# ERC20 Telegram Deployer Bot

A Telegram bot for deploying and managing custom ERC20 token smart contracts on **Ethereum mainnet** — entirely from within a Telegram chat. Configure token parameters, compile Solidity at runtime, deploy to the blockchain, list on Uniswap V2, and verify on Etherscan, all without leaving the app.

> Built by [Grayson Lim](https://github.com/graysonlim) · December 2023

---

## Features

- **Full token configuration** — Set name, symbol, supply, buy/sell taxes, wallet limits, and transaction limits via Telegram commands
- **Runtime Solidity compilation** — The bot compiles a parameterized ERC20 contract template using `solc` on every deploy
- **One-click deployment** — Deploy to Ethereum mainnet with a connected wallet, gas-configurable
- **Uniswap V2 integration** — Add liquidity, open trading, approve LP tokens, and remove liquidity
- **Etherscan verification** — Automatically verify the deployed contract source code
- **Post-deployment management** — Transfer tokens/ETH, remove limits, renounce ownership, rescue stuck funds, and trigger manual tax swaps
- **Wallet management** — Connect via private key or generate a new wallet in-bot
- **Gas configuration** — Set custom `maxFeePerGas` and `maxPriorityFeePerGas`, or query live Ethereum gas prices
- **Per-user session persistence** — User wallets, gas settings, and deployed contracts are saved locally per Telegram user

---

## Tech Stack

| Layer | Technology |
|---|---|
| Bot framework | [Telegraf](https://telegraf.js.org/) v4 (Node.js) |
| Blockchain interaction | [ethers.js](https://docs.ethers.org/) v5 + [web3.js](https://web3js.readthedocs.io/) v4 |
| Solidity compiler | [solc](https://www.npmjs.com/package/solc) v0.8.20 |
| RPC provider | [Alchemy](https://www.alchemy.com/) (Ethereum mainnet) |
| DEX | [Uniswap V2](https://docs.uniswap.org/contracts/v2/overview) |
| Contract verification | [Etherscan API](https://docs.etherscan.io/) |
| Session management | telegraf-session-local |
| HTTP client | axios |
| Runtime | Node.js |

---

## Project Structure

```
├── bot.js                  # Main bot — all command handlers, deployment logic, wallet management
├── TokenContract.sol       # Solidity ERC20 template with {{PLACEHOLDER}} variables
├── abi.json                # ABI for the deployed token contracts
├── erc20abi.json           # Standard ERC20 ABI
├── uniswapRouterAbi.json   # Uniswap V2 Router ABI
├── .env                    # Environment variables (never commit this)
├── .env.example            # Example env file for setup reference
├── package.json
├── LICENSE
└── user/                   # Auto-created per-user data directory (gitignored)
    └── <chatId>/
        ├── contractDetails.json   # Current token config being built
        ├── wallet.json            # Connected wallet address + private key
        ├── contractCount.json     # History of deployed contracts and their status
        └── gas.json               # User's gas fee settings
```

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- An [Alchemy](https://www.alchemy.com/) account with an Ethereum mainnet app
- An [Etherscan](https://etherscan.io/myapikey) API key
- An Ethereum wallet with ETH for gas fees

---


<img width="589" height="1280" alt="image" src="https://github.com/user-attachments/assets/e57b5a1e-d84a-4805-93d3-5cfc68c2adc7" />


## Setup

### 1. Clone the repository

```bash
git clone https://github.com/graysonlim/erc20-telegram-deployer.git
cd erc20-telegram-deployer
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```env
ETHERSCAN_API_KEY=your_etherscan_api_key
ETHERSCAN_API_URL=https://api.etherscan.io/api
URL=https://eth-mainnet.g.alchemy.com/v2/your_alchemy_key
TELEGRAM_TOKEN=your_telegram_bot_token
AUTHORIZED_USER_IDS=your_telegram_user_id
```

> **Finding your Telegram user ID:** Message [@userinfobot](https://t.me/userinfobot) on Telegram. For multiple authorized users, comma-separate the IDs: `123456,789012`.

### 4. Run the bot

```bash
node bot.js
```

---

## Usage

### Getting started

1. Open Telegram and start a conversation with your bot
2. Send `/start` — the bot will verify your authorization and initialize your user session
3. Send `/menu` — navigate all features from the main menu

### Configuring a token

Use these commands to set your token parameters before deploying:

| Command | Description | Default |
|---|---|---|
| `/setcn <name>` | Contract name (used in Solidity) | — |
| `/settn <name>` | Token display name | — |
| `/setts <symbol>` | Token ticker symbol | — |
| `/settokensupply <amount>` | Total token supply | 1,000,000,000 |
| `/setinitialbuytax <0-100>` | Buy tax percentage before threshold | 20% |
| `/setinitialselltax <0-100>` | Sell tax percentage before threshold | 20% |
| `/setfinalbuytax <0-100>` | Buy tax after reduction threshold | 0% |
| `/setfinalselltax <0-100>` | Sell tax after reduction threshold | 0% |
| `/setreducebuytaxat <n>` | Buy count to trigger buy tax reduction | 20 |
| `/setreduceselltaxat <n>` | Buy count to trigger sell tax reduction | 25 |
| `/setpreventswapbefore <n>` | Buy count before tax collection starts | 20 |
| `/setswapthreshold <%>` | % of supply to trigger auto tax swap | 1% |
| `/setmaxtxswap <%>` | Max % of supply to swap in one tx | 2% |
| `/setmaxtxamount <%>` | Max % of supply per transaction | 2% |
| `/setmaxwalletsize <%>` | Max % of supply a wallet can hold | 2% |
| `/setdesc1 <text>` | Contract description line 1 (appears in verified source) | — |
| `/setdesc2 <text>` | Contract description line 2 | — |
| `/setdesc3 <text>` | Contract description line 3 | — |

### Deploying

1. Connect a wallet via the **Wallet** menu (paste private key or generate a new one)
2. Configure gas fees via the **Gas Config** menu
3. Go to **Deploy** from `/menu` and confirm the deployment
4. The bot compiles the contract, submits the transaction, and returns the deployed contract address

### Post-deployment actions

After deploying, tap the contract in `/deployedcontracts` to access:

| Action | Description |
|---|---|
| Transfer Tokens | Send tokens from your wallet to the contract |
| Transfer ETH | Send ETH to the contract for liquidity |
| Open Trading | Add liquidity to Uniswap V2 and open trading |
| Verify Contract | Submit source code to Etherscan for verification |
| Remove Limits | Remove max tx and max wallet restrictions |
| Renounce Ownership | Permanently give up owner privileges |
| Approve Token | Approve LP tokens for the Uniswap router |
| Remove Liquidity | Remove liquidity from the Uniswap pool |
| Manual Swap | Manually trigger a tax swap to ETH |
| Rescue ETH | Withdraw stuck ETH from the contract |
| Rescue Tokens | Withdraw stuck tokens from the contract |

---

## Smart Contract Overview

The `TokenContract.sol` template is a fully-featured ERC20 with:

- **Dynamic tax system** — separate initial/final buy and sell tax rates, automatically reducing after a configurable buy count
- **Anti-bot protections** — transfer delay (one buy per block), bot blacklisting
- **Transaction and wallet limits** — configurable max tx amount and max wallet size
- **Auto tax swap** — collects tax tokens and swaps them to ETH when thresholds are met
- **Uniswap V2 native** — integrates directly with the Uniswap V2 router for trading and liquidity
- **Owner controls** — remove limits, reduce fees, rescue funds, renounce ownership

The contract is compiled fresh on each deployment with the user's chosen parameters substituted into the template.

---

## Gas Configuration

The bot uses EIP-1559 transaction pricing. You can configure:

- **Max Priority Fee (tip)** — paid directly to validators (default: 2 gwei)
- **Max Fee Per Gas** — maximum total gas price you'll pay (default: 20 gwei)

Use the **Gas Config** menu or query live Ethereum gas prices from Etherscan directly within the bot.

---

## Security Notes

- **Private keys are stored in plaintext** in the local `user/` directory. This is a personal-use tool — do not expose the `user/` folder or run this on a shared server without encrypting key storage.
- The `.env` file contains sensitive credentials. It is gitignored and should never be committed.
- Access is restricted to Telegram user IDs listed in `AUTHORIZED_USER_IDS`.

---

## License

MIT © 2023 [Grayson Lim](https://github.com/graysonlim)
