# coinbaseinsight
Analyzes your crypto assets and compares current market values to the amount you've invested

## Usage instructions
1. Get an API key from your Coinbase account settings
1. Set the values in `data/credentials.json`
1. Via CLI in the root project directory,
   1. Run `npm install`
   1. Run `npm start`

## Output
`output/summary.csv` will contain the following information about each asset you've bought/sold:
* Amount of asset owned
* Current value of asset
* Total invested in asset
* Difference of investment and current value (gain/loss)
* Percent difference in value
* Current market price of asset
* Average price paid for asset
* Percent difference in price

`output/transactions.csv` will contain the following information about each individual transaction:
* Type (e.g. buy/sell)
* Amount of asset transacted
* Value of transaction
* Date and time of transaction

## Notes
The first time the program is run, it will pull down all your accounts (e.g. wallets) and transactions and save them in the `data/accounts.json` and `data/transactions.json`. On subsequent runs, it will read these saved files instead. To pull your latest transactions or accounts, use the arguments `t` or `a` (e.g. `npm start t` or `npm start a t`). Note this will only add new transactions/accounts to your saved files; to pull down everything again, just delete the files.

Accounts with no transaction history are excluded from the saved accounts file. If you make new transactions with an existing unused account, you should pull down your accounts again (see above note).

The summary will be sorted by gain/loss. Transactions are sorted by date.

The total investment excludes assets received via rewards or an external source, however these assets are not excluded from the total amount owned.

By default, assets sent from your account are assumed to still be owned by you and excluded from the summary. Use the argument `s` to treat these transactions like a sell instead.

The native currency is assumed to be USD.