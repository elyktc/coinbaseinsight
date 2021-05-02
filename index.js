const fs = require("fs/promises");
const crypto = require("crypto");
const axios = require("axios");

let credentials, accounts, transactions, prices;

async function checkDir(dir) {
  try {
    await fs.access(dir);
  } catch (err) {
    try {
      await fs.mkdir(dir);
    } catch (error) {
      console.log(error);
    }
  }
}

async function logToFile(message) {
  await checkDir("logs");
  const dt = new Date().toISOString();
  const fileName = dt.substring(0, 10);
  await fs.appendFile(`logs/${fileName}.txt`, `${dt}\t${message}\n`);
}

async function logToConsole(message) {
  console.log(message);
  await logToFile(message);
}

async function loadJson(fileName) {
  await checkDir("data");
  try {
    const data = await fs.readFile(`data/${fileName}.json`);
    return JSON.parse(data);
  } catch (error) {
    await logToFile(error);
    return undefined;
  }
}

async function saveJson(fileName, data) {
  try {
    await fs.writeFile(`data/${fileName}.json`, JSON.stringify(data));
  } catch (error) {
    await logToFile(error);
  }
}

async function saveCsv(fileName, rows) {
  await checkDir("output");
  if (Array.isArray(rows) && rows.length > 0) {
    const keys = Object.keys(rows[0]);
    const values = rows.map((r) => keys.map((k) => r[k]).join(","));
    const data = [keys.join(","), ...values].join("\n");
    try {
      await fs.writeFile(`output/${fileName}.csv`, data);
    } catch (error) {
      await logToFile(error);
    }
  }
}

async function getHeaders(path) {
  credentials = credentials ?? (await loadJson("credentials"));
  if (!credentials?.apiKey || !credentials?.apiSecret) {
    throw new Error("Credentials missing");
  }
  const timestamp = Math.round(Date.now() / 1000);
  const method = "GET";
  const signature = crypto
    .createHmac("sha256", credentials.apiSecret)
    .update(`${timestamp}${method}${path}`)
    .digest("hex");
  return {
    headers: {
      "Content-Type": "application/json",
      "CB-ACCESS-KEY": credentials.apiKey,
      "CB-ACCESS-SIGN": signature,
      "CB-ACCESS-TIMESTAMP": timestamp,
      "CB-VERSION": "2021-04-29",
    },
  };
}

async function get(path, headers) {
  await logToFile(path);
  let response;
  try {
    response = await axios.get(`https://api.coinbase.com${path}`, headers);
  } catch (error) {
    if (error?.response) {
      response = error.response;
    } else {
      throw error;
    }
  }
  if (response?.status === 200) {
    return response.data;
  } else {
    throw new Error(`${response?.status} ${JSON.stringify(response?.data)}`);
  }
}

async function getItems(name, savedItems, context) {
  const items = [];
  const contextPath = context ? `${context.name}/${context.id}/` : "";
  let path = `/v2/${contextPath}${name}`;
  do {
    const headers = await getHeaders(path);
    const response = await get(path, headers);
    const newItems = response?.data?.filter(
      (d) => !savedItems.some((i) => i.id === d.id)
    );
    items.push(...newItems);
    const allNew = newItems.length === response.data.length;
    path = allNew ? response?.pagination?.next_uri : undefined;
  } while (path);
  return items;
}

async function getAccounts() {
  accounts = await loadJson("accounts");
  if (!accounts || process.argv.includes("a")) {
    await logToConsole("Retrieving accounts...");
    accounts = accounts ?? [];
    const newAccounts = await getItems("accounts", accounts);
    accounts.push(
      ...newAccounts.map((a) => {
        return {
          id: a.id,
          code: a.currency.code,
          name: a.currency.name,
        };
      })
    );
    await saveJson("accounts", accounts);
  }
}

async function getTransactions() {
  transactions = await loadJson("transactions");
  if (!transactions || process.argv.includes("t")) {
    transactions = transactions ?? [];
    for (let account of accounts) {
      await logToConsole(`Retrieving ${account.code} transactions...`);
      const context = {
        name: "accounts",
        id: account.id,
      };
      const newTransactions = await getItems(
        "transactions",
        transactions,
        context
      );
      transactions.push(
        ...newTransactions.map((t) => {
          return {
            id: t.id,
            type: t.type,
            amount: t.amount.amount,
            code: t.amount.currency,
            usd: t.native_amount.amount,
            date: t.created_at,
          };
        })
      );
    }
    const time = (iso) => new Date(iso).getTime();
    transactions.sort((a, b) => time(b.date) - time(a.date));
    await saveJson("transactions", transactions);
    await saveCsv(
      "transactions",
      transactions.map((t) => {
        return {
          id: t.id,
          type: t.type,
          amount: t.amount,
          code: t.code,
          usd: t.usd,
          date: t.date.replace(/[TZ]/g, " ").trim(),
        };
      })
    );
  }
}

async function filterAccountsWithoutTransactions() {
  const totalAccounts = accounts.length;
  accounts = accounts.filter((a) =>
    transactions.some((t) => t.code === a.code)
  );
  if (accounts.length < totalAccounts) {
    await saveJson("accounts", accounts);
  }
}

async function getPrices() {
  await logToConsole(`Retrieving current prices...`);
  prices = {};
  for (let account of accounts) {
    const response = await get(`/v2/prices/${account.code}-USD/spot`);
    prices[account.code] = response?.data?.amount;
  }
}

function isReward(transaction) {
  return (
    ["staking_reward", "inflation_reward"].includes(transaction.type) ||
    (transaction.type === "send" && transaction.amount > 0)
  );
}

function isSent(transaction) {
  return (
    !process.argv.includes("s") &&
    transaction.type === "send" &&
    transaction.amount < 0
  );
}

function round(number) {
  return Math.round(number * 100) / 100;
}

async function getSummary() {
  await logToConsole(`Mathing...`);
  const rows = [];
  for (let account of accounts) {
    const name = account.name;
    const code = account.code;
    let amount = 0.0;
    let investedValue = 0.0;
    for (let t of transactions.filter((t) => t.code === code && !isSent(t))) {
      amount += parseFloat(t.amount);
      investedValue += !isReward(t) ? parseFloat(t.usd) : 0;
    }
    const currentPrice = parseFloat(prices[code]);
    const currentValue = round(amount * currentPrice);
    const valueDifference = round(currentValue - investedValue);
    const pctChangeValue = round((valueDifference / investedValue) * 100);
    const avgInvestPrice = investedValue / amount;
    const priceDifference = currentPrice - avgInvestPrice;
    const pctChangePrice = round((priceDifference / avgInvestPrice) * 100);
    const row = {
      name,
      code,
      amount,
      currentValue,
      investedValue,
      valueDifference,
      pctChangeValue,
      currentPrice,
      avgInvestPrice,
      pctChangePrice,
    };
    rows.push(row);
  }
  rows.sort((a, b) => b.valueDifference - a.valueDifference);
  await saveCsv("summary", rows);
}

async function run() {
  await logToConsole("Starting...");
  await getAccounts();
  await getTransactions();
  await filterAccountsWithoutTransactions();
  await getPrices();
  await getSummary();
  await logToConsole("Done");
}

run().catch((error) => logToConsole(error?.toString()));
