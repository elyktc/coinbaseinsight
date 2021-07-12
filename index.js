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
          const amount = t.amount.amount;
          const code = t.amount.currency;
          const usd = t.native_amount.amount;
          const fee =
            t.type === "buy" && code !== "USD" ? Math.max(usd * 0.015, 3) : 0;
          const price = (usd - fee) / amount;
          return {
            id: t.id,
            type: t.type,
            amount: amount,
            code: code,
            usd: usd,
            price: price,
            fee: fee,
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
          price: t.price,
          fee: t.fee,
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
  return ["staking_reward", "inflation_reward"].includes(transaction.type);
}

function isSent(transaction) {
  return (
    !process.argv.includes("s") &&
    transaction.type === "send" &&
    transaction.code !== "USD"
  );
}

function round(number) {
  return Math.round(number * 100) / 100;
}

function sum(numbers) {
  return numbers.reduce((sum, n) => sum + n);
}

async function getSummary() {
  await logToConsole(`Mathing...`);
  const rows = [];
  for (let account of accounts) {
    const name = account.name;
    const code = account.code;
    let amount = 0.0;
    let investedValue = 0.0;
    const txns = transactions.filter((t) => t.code === code && !isSent(t));
    for (let t of txns) {
      amount += parseFloat(t.amount);
      investedValue += !isReward(t) ? parseFloat(t.usd) : 0;
    }
    const currentPrice = parseFloat(prices[code]);
    const currentValue = round(amount * currentPrice);
    const valueDifference = round(currentValue - investedValue);
    const pctChangeValue = round((valueDifference / investedValue) * 100);
    const avgInvestPrice = investedValue / amount;
    const lastBuy = txns.find((t) => t.type === "buy");
    const lastSell = txns.find((t) => t.type === "sell");
    const lastBuyPrice = lastBuy?.price;
    const lastSellPrice = lastSell?.price;
    const lastBuyDate = lastBuy?.date ?? 0;
    const lastSellDate = lastSell?.date ?? 0;
    const soldLast = new Date(lastBuyDate) - new Date(lastSellDate) < 0;
    const lastBuyDifference = lastBuyPrice && currentPrice - lastBuyPrice;
    const lastSellDifference = lastSellPrice && currentPrice - lastSellPrice;
    const pctChangeLastBuy = !soldLast && lastBuyPrice
      ? round((lastBuyDifference / lastBuyPrice) * 100)
      : "";
    const pctChangeLastSell = soldLast && lastSellPrice
      ? round((lastSellDifference / lastSellPrice) * 100)
      : "";
    const row = {
      name,
      code,
      avgInvestPrice,
      currentPrice,
      lastBuyPrice,
      pctChangeLastBuy,
      lastSellPrice,
      pctChangeLastSell,
      amount,
      currentValue,
      investedValue,
      valueDifference,
      pctChangeValue,
      lastBuyDate,
      lastSellDate,
    };
    rows.push(row);
  }
  rows.sort((a, b) => b.pctChangeLastBuy - a.pctChangeLastBuy || a.pctChangeLastSell - b.pctChangeLastSell);
  rows.push(getTotalsRow(rows));
  await saveCsv("summary", rows);
}

function getTotalsRow(rows) {
  const investedValue = sum(rows.map((r) => r.investedValue));
  const currentValue = sum(rows.map((r) => r.currentValue));
  const valueDifference = currentValue - investedValue;
  const pctChangeValue = round((valueDifference / investedValue) * 100);
  return {
    currentValue,
    investedValue,
    valueDifference,
    pctChangeValue,
  };
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
