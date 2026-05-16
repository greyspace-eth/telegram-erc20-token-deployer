/**
 * ERC20 Telegram Deployer Bot
 * Author: Grayson Lim <graysonlimcrypto@gmail.com>
 * Created: December 2023
 * License: MIT
 *
 * A Telegram bot for deploying and managing custom ERC20 token contracts
 * on Ethereum mainnet. Supports configurable taxes, limits, Uniswap V2
 * liquidity, and Etherscan verification — all from within a Telegram chat.
 */

const { Telegraf } = require('telegraf');
const session = require('telegraf-session-local');
const fs = require('fs');
const path = require('path');
const { Wallet, ethers } = require('ethers');
const solc = require('solc');
const {Web3} = require('web3');
const axios = require ('axios');
const querystring = require('querystring');
require('dotenv').config();
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const ETHERSCAN_API_URL = process.env.ETHERSCAN_API_URL;
const URL = process.env.URL;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const AUTHORIZED_USER_IDS = process.env.AUTHORIZED_USER_IDS
    ? process.env.AUTHORIZED_USER_IDS.split(',').map(id => id.trim())
    : [];

// Settings for provider
const provider = new ethers.providers.JsonRpcProvider({
    url: URL,
    timeout: 120000 // Timeout in milliseconds, e.g., 120000 ms for 2 minutes
}); 
const web3 = new Web3(URL);
const abi = JSON.parse(fs.readFileSync('abi.json', 'utf8'));
const ERC20_ABI = JSON.parse(fs.readFileSync('erc20abi.json', 'utf8'));
const UNISWAP_ROUTER_ABI = JSON.parse(fs.readFileSync('uniswapRouterAbi.json', 'utf8'));
const UNISWAP_ROUTER_ADDRESS = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";

// Create a bot instance with your token
const token = TELEGRAM_TOKEN;
const bot = new Telegraf(token, { polling: true, handlerTimeout: 180_000 });
bot.use(new session());

// Compile and deploy contract functions
async function compileContract(details) {
    let contractSource = fs.readFileSync('TokenContract.sol', 'utf8');

    // Calculate token amounts based on percentages and total supply
    const maxTxAmount = calculateTokenAmount(details.tokenSupply, details.maxTxAmount);
    const maxWalletSize = calculateTokenAmount(details.tokenSupply, details.maxWalletSize);
    const taxSwapThreshold = calculateTokenAmount(details.tokenSupply, details.taxSwapThreshold);
    const maxTxSwap = calculateTokenAmount(details.tokenSupply, details.maxTxSwap);

    contractSource = contractSource
                    .replace(/{{CONTRACT_NAME}}/g, details.contractName)
                    .replace(/{{TOKEN_NAME}}/g, details.tokenName)
                    .replace(/{{TOKEN_SYMBOL}}/g, details.tokenSymbol)
                    .replace(/{{TOKEN_SUPPLY}}/g, details.tokenSupply)
                    .replace(/{{INITIAL_BUY_TAX}}/g, details.initialBuyTax)
                    .replace(/{{INITIAL_SELL_TAX}}/g, details.initialSellTax)
                    .replace(/{{FINAL_BUY_TAX}}/g, details.finalBuyTax)
                    .replace(/{{FINAL_SELL_TAX}}/g, details.finalSellTax)
                    .replace(/{{TAX_SWAP_THRESHOLD}}/g, taxSwapThreshold)
                    .replace(/{{MAX_TX_SWAP}}/g, maxTxSwap)
                    .replace(/{{MAX_TX_AMOUNT}}/g, maxTxAmount)
                    .replace(/{{MAX_WALLET_SIZE}}/g, maxWalletSize)
                    .replace(/{{REDUCE_BUY_TAX_AT}}/g, details.reduceBuyTaxAt)
                    .replace(/{{REDUCE_SELL_TAX_AT}}/g, details.reduceSellTaxAt)
                    .replace(/{{PREVENT_SWAP_BEFORE}}/g, details.preventSwapBefore);

    const input = {
        language: 'Solidity',
        sources: {
            'TokenContract.sol': {
                content: contractSource
            }
        },
        settings: {
            outputSelection: {
                '*': {
                    '*': ['*']
                }
            }
        }
    };

    try {
        console.log('starting compile solc');
        const output = await JSON.parse(solc.compile(JSON.stringify(input)));
        if (output.errors) {
            const errors = output.errors.filter(error => error.severity === 'error');
            if (errors.length > 0) {
                throw new Error('Solidity compilation errors:\n' + errors.map(error => error.formattedMessage).join('\n'));
            }
        }
        const contractData = await output.contracts['TokenContract.sol'][details.contractName];
        console.log('ending compile compile solc');
        return {
            abi: contractData.abi,
            bytecode: contractData.evm.bytecode.object
        };
    } catch (error) {
        console.error('Error in compiling contract:', error);
        throw error;
    }
}

async function deployContract(details, wallet, gas) {
    console.log('starting deploy contract');
    // Compile the contract with placeholders replaced
    const { abi, bytecode } = await compileContract(details);

    console.log('Attempting to deploy from account:', wallet.address);
    const contract = new web3.eth.Contract(abi);

    const contractTx = contract.deploy({
        data: bytecode,
        // Add constructor arguments after bytecode if necessary, like ['arg1', 'arg2']
    });

    // Sign the transaction
    const baseHighGas = await getCurrentHighGas();
    // const gasEstimate = await contractTx.estimateGas({ from: wallet.address });

    const signedTx = await web3.eth.accounts.signTransaction({
        from: wallet.address,
        data: contractTx.encodeABI(),
        // gas: gasEstimate + 10000n,
        maxPriorityFeePerGas: web3.utils.toWei(gas.maxPriorityFeePerGas.toString(), 'gwei'), // web3.js method to convert gwei to wei 
        maxFeePerGas: web3.utils.toWei(baseHighGas.toString(), 'gwei') // web3.js method to convert gwei to wei
    }, wallet.pk);

    return new Promise((resolve, reject) => {
        web3.eth.sendSignedTransaction(signedTx.rawTransaction)
            .on('receipt', (receipt) => {
                console.log('Contract deployed at address', receipt.contractAddress);
                resolve(receipt.contractAddress); // Resolve the promise with the contract address
            })
            .on('error', (error) => {
                console.error('Transaction failed:', error);
                reject(error); // Reject the promise on error
            });
    });

    // console.log('Contract deployed at address', receipt.contractAddress);
    // console.log('ending deploy contract');
}

async function verifyContract(contractAddress, details) {
    console.log('starting verify contract');
    let contractSource = fs.readFileSync('TokenContract.sol', 'utf8');

    // Calculate token amounts based on percentages and total supply
    const maxTxAmount = calculateTokenAmount(details.tokenSupply, details.maxTxAmount);
    const maxWalletSize = calculateTokenAmount(details.tokenSupply, details.maxWalletSize);
    const taxSwapThreshold = calculateTokenAmount(details.tokenSupply, details.taxSwapThreshold);
    const maxTxSwap = calculateTokenAmount(details.tokenSupply, details.maxTxSwap);

    contractSource = contractSource
                    .replace(/{{CONTRACT_NAME}}/g, details.contractName)
                    .replace(/{{TOKEN_NAME}}/g, details.tokenName)
                    .replace(/{{TOKEN_SYMBOL}}/g, details.tokenSymbol)
                    .replace(/{{TOKEN_SUPPLY}}/g, details.tokenSupply)
                    .replace(/{{INITIAL_BUY_TAX}}/g, details.initialBuyTax)
                    .replace(/{{INITIAL_SELL_TAX}}/g, details.initialSellTax)
                    .replace(/{{FINAL_BUY_TAX}}/g, details.finalBuyTax)
                    .replace(/{{FINAL_SELL_TAX}}/g, details.finalSellTax)
                    .replace(/{{TAX_SWAP_THRESHOLD}}/g, taxSwapThreshold)
                    .replace(/{{MAX_TX_SWAP}}/g, maxTxSwap)
                    .replace(/{{MAX_TX_AMOUNT}}/g, maxTxAmount)
                    .replace(/{{MAX_WALLET_SIZE}}/g, maxWalletSize)
                    .replace(/{{REDUCE_BUY_TAX_AT}}/g, details.reduceBuyTaxAt)
                    .replace(/{{REDUCE_SELL_TAX_AT}}/g, details.reduceSellTaxAt)
                    .replace(/{{PREVENT_SWAP_BEFORE}}/g, details.preventSwapBefore)
                    .replace(/{{DESCRIPTION1}}/g, details.desc1 || '')
                    .replace(/{{DESCRIPTION2}}/g, details.desc2 || '')
                    .replace(/{{DESCRIPTION3}}/g, details.desc3 || '');

    // Construct the payload for the verification request
    const payload = {
        apikey: ETHERSCAN_API_KEY,
        module: 'contract',
        action: 'verifysourcecode',
        contractaddress: contractAddress,
        sourceCode: contractSource,
        codeformat: 'solidity-single-file',
        contractname: details.contractName,
        compilerversion: 'v0.8.20+commit.a1b79de6', // Specify the compiler version used during deployment
        optimizationUsed: 0, // Change if optimization was not used
        runs: 200, 
        licenseType: 3,
        constructorArguments: '', 
    };

    const config = {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    };

     // Send a POST request to the Etherscan API
     const response = await axios.post(ETHERSCAN_API_URL, querystring.stringify(payload), config);

     // Handle the response. If successful, Etherscan will provide a GUID to check verification status.
     if (response.data.status != '1') {
        throw new Error(response.data.result);
     }

     console.log('ending verify contract');

     return response.data.result;
}

async function checkVerificationStatus(guid) {
    console.log('starting check verification contract'); 
    const response = await axios.get(`${ETHERSCAN_API_URL}?module=contract&action=checkverifystatus&guid=${guid}&apikey=${ETHERSCAN_API_KEY}`); //change here 
    console.log('ending check verification contract');
    console.log(response.data);
    if (response.data.status === '1') {
        return 1; //Contract verified successfully
    } else {
        if(response.data.result.includes('Already Verified')){
            return 1; //already verified
        }
        return 0; //Contract verification is still pending or failed.
    }
}

async function addContractForUser(userId, contractAddress, contractSymbol, deployerAddress) {
    const contractCountPath = `./user/${userId}/contractCount.json`;
    try {
        const contractCount = fs.existsSync(contractCountPath)
            ? await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'))
            : { count: 0, deployedContracts: [] };

            // Add the new contract with initial status flags set to false
            const newContractData = {
                address: contractAddress,
                symbol: contractSymbol,
                deployer: deployerAddress,
                hasRenounceOwnership: false,
                hasVerifyContract: false,
                hasRemoveLimits: false,
                hasTransferTokens: false,
                hasTransferEth: false,
                hasOpenedTrading: false,
                hasRemoveLiquidity: false,
                hasApproveTokenForLiquidity: false,
                lpTokenPairAddress: "",
                lpTokenAmount: ""
            };

            // Push the new contract data into the deployedContracts array
            await contractCount.deployedContracts.push(newContractData);
            contractCount.count = await contractCount.deployedContracts.length;

        fs.writeFileSync(contractCountPath, JSON.stringify(contractCount, null, 2));
    } catch (error) {
        console.error('Error adding contract for user:', error);
        throw error; // You may want to handle this error more gracefully in production code
    }
}

async function displayDeployedContracts(ctx,isEditMessage) {
    const userId = ctx.from.id;
    const contractCountPath = `./user/${userId}/contractCount.json`;
    
    if (fs.existsSync(contractCountPath)) {
        const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
        const contracts = await contractCount.deployedContracts;

        if (contracts.length === 0) {
            ctx.reply("You have not deployed any contracts.");
            return;
        }

        let keyboard = await contracts.map((contract, index) => {
            return [{ text: `${index + 1}: $${contract.symbol} - ${contract.address}`, callback_data: `manage_contract:${contract.address}` }];
        });

        await keyboard.push([{ text: '🔙 Back to Main Menu', callback_data: 'back_to_menu' }]);

        const messageText = "Select a contract to manage:";

        // Check if the message is a callback query (i.e., user clicked on a button)
        if (isEditMessage) {
            await ctx.editMessageText(messageText, {
                reply_markup: { inline_keyboard: keyboard },
                parse_mode: 'Markdown'
            });
        } else {
            // It's a regular command invocation, send a new message
            await ctx.reply(messageText, {
                reply_markup: { inline_keyboard: keyboard },
                parse_mode: 'Markdown'
            });
        }
    } else {
        await ctx.reply("You have not deployed any contracts.");
    }
}

async function checkCurrentGas() {
    console.log('starting check current gas');
    // URL of the gas price API
    const apiUrl = `https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey=${ETHERSCAN_API_KEY}`;

    try {
        // Send a GET request to the API
        const response = await axios.get(apiUrl);
        const gasData = await response.data.result;

        // Extract the relevant data
        const lowGas = await gasData.SafeGasPrice;
        const averageGas = await gasData.ProposeGasPrice;
        const highGas = await gasData.FastGasPrice;
        const baseFee = await gasData.suggestBaseFee;

        console.log('ending check current gas');
        return {
            low: lowGas,
            average: averageGas,
            high: highGas,
            base: baseFee,
        };
    } catch (error) {
        console.error('Error fetching current gas prices:', error);
        throw error;
    }
}

async function getCurrentHighGas() {
    const apiUrl = `https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey=${ETHERSCAN_API_KEY}`;

    try {
        // Send a GET request to the API
        const response = await axios.get(apiUrl);
        const gasData = await response.data.result;

        // Extract the relevant data
        const highGas = await gasData.FastGasPrice;

        return highGas;
    } catch (error) {
        console.error('Error fetching current high gas prices:', error);
        throw error;
    }
}

const calculateTokenAmount = (totalSupply, percentage) => {
    return Math.floor((parseInt(totalSupply) * parseInt(percentage)) / 100);
}

// Function to check if the user folder exists
const userExistsInUserFolder = (chatId) => {
    const folderPath = path.join(__dirname, 'user', chatId.toString());
    return fs.existsSync(folderPath);
};

// Function to create user data
const createUserData = (chatId) => {
    fs.mkdir(path.join(__dirname, 'user', chatId.toString()), { recursive: true }, (err) => {
        if (err) {
            console.error('Error creating user data folder:', err);
            return;
        } 

        const filesToCreate = [
            {
                path: `./user/${chatId}/contractDetails.json`,
                content: {
                    contractName: "",
                    tokenName: "",
                    tokenSymbol: "",
                    tokenSupply: 1000000000,
                    tokenToRemainInDeployerWallet: 0,
                    liquidityToAdd: 1,
                    initialBuyTax: 20,
                    initialSellTax: 20,
                    finalBuyTax: 0,
                    finalSellTax: 0,
                    taxSwapThreshold: 1,
                    maxTxSwap: 2,
                    maxTxAmount: 2,
                    maxWalletSize: 2,
                    reduceBuyTaxAt: 20,
                    reduceSellTaxAt: 25,
                    preventSwapBefore: 20,
                    desc1: "",
                    desc2: "",
                    desc3: "",
                    contractType: "rug"
                }
            },
            {
                path: `./user/${chatId}/wallet.json`,
                content: {
                    pk: "",
                    address: ""
                }
            },
            {
                path: `./user/${chatId}/contractCount.json`,
                content: {
                    count: 0,
                    deployedContracts: []
                }
            },
            {
                path: `./user/${chatId}/gas.json`,
                content: {
                    maxPriorityFeePerGas : 2,
                    maxFeePerGas : 20
                }
            }
        ];
        // Write each file with the specified content
        filesToCreate.forEach(file => {
            fs.writeFile(file.path, JSON.stringify(file.content, null, 2), (err) => {
                if (err) {
                    console.error(`Error creating ${file.path} file:`, err);
                } else {
                    console.log(`${file.path} file created successfully`);
                }
            });
        });

    });
};

// Function to get wallet keyboard
const getWalletKeyboard = (wallet) => {
    const keyboard = {
        inline_keyboard: []
    };

    if (wallet.pk.length !== 0) {
        keyboard.inline_keyboard.push([
            { text: '↗️ Send ETH', callback_data: 'sendeth_button' },
            { text: 'Disconnect Wallet', callback_data: 'disconnectwallet_button' }
        ]);
    } else {
        keyboard.inline_keyboard.push([
            { text: 'Connect Wallet', callback_data: 'connectwallet_button' }, 
            { text: 'Generate New Wallet', callback_data: 'generatewallet_button' }
        ]);
    }
    // Add back button to the keyboard
    keyboard.inline_keyboard.push([{ text: '🔙 Back', callback_data: 'back_to_menu' }]);

    return keyboard;
};

//Function to get gas keyboard
const getGasKeyboard = () => {
    return {
        inline_keyboard: [ 
            [
                { text: '✏️ Priority fee', callback_data: 'priorityfee_button' },
                // { text: '✏️ Additional fee', callback_data: 'maxfee_button' }
            ],
            [
                { text: '🔄 Reset Default', callback_data: 'resetgasconfig_button' },
                { text: '⛽️ Check current gas', callback_data: 'checkcurrentgas_button' }
            ],
            [
                { text: '🔙 Back', callback_data: 'back_to_menu' }
            ]
        ]
    };
}

// Function to get PostDeployment keyboard
const getPostDeploymentKeyboard = (contractAddress, contractCount) => {
    const contractData = contractCount.deployedContracts.find(c => c.address === contractAddress);

    const transferTokensToContractText = contractData.hasTransferTokens ? '1. Transfer Tokens ✅' : '1. Transfer Tokens ❌';
    const transferEthToContractText = contractData.hasTransferEth ? '2. Transfer ETH ✅' : '2. Transfer ETH ❌';
    const openTradingText = contractData.hasOpenedTrading ? '3. Open Trading ✅' : '3. Open Trading ❌';
    const renounceOwnershipText = contractData.hasRenounceOwnership ? '1. Renounce Ownership ✅' : '1. Renounce Ownership ❌';
    const verifyContractText = contractData.hasVerifyContract ? '1. Verify Contract ✅' : '1. Verify Contract ❌';
    const removeLimitsText = contractData.hasRemoveLimits ? '2. Remove Limits ✅' : '2. Remove Limits ❌ ';
    const approveTokenForLiquidityText = contractData.hasApproveTokenForLiquidity ? '1. Approve Token ✅' : '1. Approve Token ❌';
    const removeLiquidityText = contractData.hasRemoveLiquidity ? '2. Remove Liquidity ✅' : '2. Remove Liquidity ❌';

    return {
        inline_keyboard: [
            [
                { text: '⬇️ Open Live Trading Steps (Order matter) ⬇️' , callback_data: 'no_action' },
                
            ],
            [
                { text: transferTokensToContractText, callback_data: `transfer_tokens:${contractAddress}` },
                { text: transferEthToContractText, callback_data: `transfer_eth:${contractAddress}` }
                
            ],
            [
                { text: openTradingText, callback_data: `open_trading:${contractAddress}` },
                
            ],
            [
                { text: ' ' , callback_data: 'no_action' }
                
            ],
            [
                { text: "⬇️ Post Deploy Steps (Order don't matter) ⬇️" , callback_data: 'no_action' },
                
            ],
            [
                { text: verifyContractText, callback_data: `verify_contract:${contractAddress}` },
                { text: removeLimitsText, callback_data: `remove_limits:${contractAddress}` }
            ],
            [
                { text: ' ' , callback_data: 'no_action' }
                
            ],
            [
                { text: "⬇️ Renounce Ownership Steps ⬇️" , callback_data: 'no_action' }
                
            ],
            [
                { text: renounceOwnershipText, callback_data: `renounce_ownership:${contractAddress}` }
                
            ],
            [
                { text: ' ' , callback_data: 'no_action' }
                
            ],
            [
                { text: "💧 Remove Liquidity Steps 💧" , callback_data: 'no_action' }
                
            ],
            [
                { text: approveTokenForLiquidityText, callback_data: `approve_token:${contractAddress}` },
                { text: removeLiquidityText, callback_data: `remove_liquidity:${contractAddress}` }
                
            ],
            [
                { text: ' ' , callback_data: 'no_action' }
                
            ],
            [
                { text: '💵 Rescue ETH', callback_data: `rescue_eth:${contractAddress}` },
                { text: '🔂 Manual Swap', callback_data: `manual_swap:${contractAddress}` },    
                { text: '🪙 Rescue Tokens', callback_data: `rescue_tokens:${contractAddress}` }
            ],
            [
                { text: '🔙 Back', callback_data: 'back_to_deployed_contracts' }
            ]
        ]
    };
}

const isValidPrivateKey = (pk) =>  {
    try {
        new ethers.Wallet(pk);  // This will throw an error if the private key is invalid
        return true;
    } catch (error) {
        return false;
    }
}

const isValidEthereumAddress = (address) => {
    return ethers.isAddress(address);
}

const isValidPercentage = (value) => {
    const pattern = /^\d+$/; // Regular expression for whole numbers only
    const num = parseInt(value);
    return pattern.test(value) && num >= 0 && num <= 100;
};

const isPositiveInteger = (value) => {
    const num = parseInt(value);
    return Number.isInteger(num) && num > 0;
};

const isNonNegativeInteger = (value) => {
    const num = parseInt(value);
    return Number.isInteger(num) && num >= 0;
};

const isDecimalNonNegative = (input) => {
    const pattern = /^(?!0(\.0+)?$)\d+(\.\d+)?$/;
    return pattern.test(input);
};

const updateWalletJson = async (ctx, walletData, isConnect) => {
    const walletPath = `./user/${ctx.from.id}/wallet.json`;
    fs.writeFileSync(walletPath, JSON.stringify(walletData, null, 2));

    const messageText = await isConnect
        ? `Wallet successfully connected.\nAddress: \`${walletData.address}\``
        : 'Wallet successfully disconnected.';

    const menuButton = {
        text: '🔙 Menu',
        callback_data: 'back_to_menu'
    };

    const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[menuButton]]
        }
    };

    await ctx.reply(messageText, opts);
};

const updateGasJson = async (ctx, json, isPriorityFee) => {
    const gasPath = `./user/${ctx.from.id}/gas.json`;
    fs.writeFileSync(gasPath, JSON.stringify(json, null, 2));

    const gas = await json;
    const messageText = `📌 *Fees*:\nPriority Fee: *${gas.maxPriorityFeePerGas} gwei*`; //\nAdditional Gas (High+Addtional): *${gas.maxFeePerGas} gwei*

    const opts = {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: getGasKeyboard()
    };

    // Determine the message ID to edit based on the fee type
    const messageIdToEdit = await isPriorityFee
        ? ctx.session.replyToPriorityFeeButtonMessage
        : ctx.session.replyToMaxFeeButtonMessage;

    try {
        await ctx.telegram.editMessageText(ctx.from.id, messageIdToEdit, null, messageText, opts);
    } catch (error) {
        if (error.response && error.response.description.includes("message is not modified")) {
            console.warn("Attempted to edit message with unchanged content. Ignoring.");
        } else {
            console.error("Unexpected error:", error);
            await ctx.reply("An unexpected error occurred in updating gas. Please try again later.");
        }
    }
};

const resetGasDefaults = async (ctx) => {
    const defaultGasConfig = {
        maxPriorityFeePerGas: 2,
        maxFeePerGas: 10
    };

    const gasPath = `./user/${ctx.from.id}/gas.json`;

    try {
        // Read current gas configuration
        const currentGasConfig = await JSON.parse(fs.readFileSync(gasPath, 'utf8'));

        // Check if the current configuration is already at default
        if (currentGasConfig.maxPriorityFeePerGas === defaultGasConfig.maxPriorityFeePerGas &&
            currentGasConfig.maxFeePerGas === defaultGasConfig.maxFeePerGas) {
            await ctx.answerCbQuery('Already in default settings');
            return;
        }

        // Write the default gas configuration to the file
        fs.writeFileSync(gasPath, JSON.stringify(defaultGasConfig, null, 2));

        const messageText = `📌 *Fees*:\nPriority Fee: *${defaultGasConfig.maxPriorityFeePerGas} gwei*`; //Additional Gas (High+Addtional): *${defaultGasConfig.maxFeePerGas} gwei*

        const opts = {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: getGasKeyboard()
        };

        // Edit the original message with the updated gas values
        await ctx.editMessageText(messageText, opts);

        // Provide a callback query notification to the user
        await ctx.answerCbQuery('Restored default settings');

    } catch (error) {
        console.error('Error resetting gas configuration to defaults:', error);

        if (error.response && error.response.description.includes("message is not modified")) {
            console.warn("Attempted to edit message with unchanged content. Ignoring.");
        } else {
            // Notify the user of an error through a callback query notification
            await ctx.answerCbQuery('An error occurred while resetting the gas configuration.');
        }
    }
};

const updateContractDetails = async (ctx, field, value) => {
    const chatId = ctx.from.id;
    const contractDetailsPath = `./user/${chatId}/contractDetails.json`;

    // Check if the contractDetails.json exists
    if (!fs.existsSync(contractDetailsPath)) {
        await ctx.reply('Please start your bot with /start to create your profile.');
        return;
    }

    try {
        const contractDetails = await JSON.parse(fs.readFileSync(contractDetailsPath, 'utf8'));
        contractDetails[field] = await value;
        fs.writeFileSync(contractDetailsPath, JSON.stringify(contractDetails, null, 2));
        // Check if the field is a percentage value
        const percentageFields = ['initialBuyTax', 'initialSellTax', 'finalBuyTax', 'finalSellTax', 'taxSwapThreshold', 'maxTxSwap', 'maxTxAmount', 'maxWalletSize'];
        const isPercentageField = percentageFields.includes(field);

        // Format the field name for display
        const fieldNameForDisplay = await field.replace(/([A-Z])/g, ' $1').trim();

        // Append '%' symbol if it's a percentage field
        const valueForDisplay = isPercentageField ? `${value}%` : value;

        await ctx.reply(`${fieldNameForDisplay} set to: ${valueForDisplay}`);
    } catch (error) {
        console.error('Error updating contract details:', error);
        ctx.reply('An error occurred while updating contract details. Please try again.');
    }
};

// Start command
bot.start(async (ctx) => {
    const chatId = ctx.from.id.toString();
    const telegramHandle = ctx.from.username;

    // Check if the user is authorized
    if (!AUTHORIZED_USER_IDS.includes(chatId)) {
        console.error('Unauthorized access attempt by chatId:', chatId);
        await ctx.reply('Only authorized users can access this feature.');
        return;
    }

    // Proceed if the user is authorized
    if (userExistsInUserFolder(chatId)) {
        await ctx.replyWithMarkdown(`Welcome back *${telegramHandle}* ❤️\nNavigate to the /menu to continue.`);
    } else {
        createUserData(chatId);
        await ctx.replyWithMarkdown(`Welcome *${telegramHandle}* ❤️\nTime to start your journey with our smart contract creator bot!`);
    }
});

// Command handler for /menu
bot.command('menu', async (ctx) => {
    if (userExistsInUserFolder(ctx.from.id)) {
        // User exists, show the menu
        const contractCountPath = `./user/${ctx.from.id}/contractCount.json`;
        const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
        const messageText = `Ready to deploy a contract today?\n\n*Deployment*\nContracts Deployed: *${contractCount.count}*`;
        const menu = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🚀 Deploy', callback_data: 'deploy_button' },
                        { text: '⛽️ Gas Config', callback_data: 'gasconfig_button' }
                    ],
                    [
                        { text: '👛 Wallet', callback_data: 'wallet_button' },
                        { text: '❓ Help', callback_data: 'help_button' }
                    ]
                ]
            },
            parse_mode: 'Markdown'
        };
        await ctx.reply(messageText, menu);
    } else {
        // User does not exist, prompt to use /start
        await ctx.replyWithMarkdown('It looks like you do not have a profile yet. Please use the /start command to create your profile.');
    }
});

// Command handler for /setContractName
bot.command('setcn', async (ctx) => {
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) {
        ctx.reply('Please provide a contract name.');
        return;
    }

    const contractName = parts.slice(1).join(' ');
    const isValidName = /^[A-Za-z][A-Za-z0-9]*$/.test(contractName);

    if (!isValidName) {
        await ctx.reply('Invalid contract name. The name must start with a letter and can only contain letters and numbers and cannot contain spaces');
        return;
    }

    await updateContractDetails(ctx, 'contractName', contractName);
});

// Command handler for /setTokenName
bot.command('settn', async (ctx) => {
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) {
        await ctx.reply('Please provide a token name.');
        return;
    }

    // Join the parts to form the token name, excluding the command part
    const tokenName = parts.slice(1).join(' ');

    await updateContractDetails(ctx, 'tokenName', tokenName);
});

// Command handler for /setSymbol
bot.command('setts', async (ctx) => {
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) {
        await ctx.reply('Please provide a token symbol.');
        return;
    }

    const symbol = parts.slice(1).join(' ');
    const isValidSymbol = /^[A-Za-z0-9]+$/.test(symbol);

    if (!isValidSymbol) {
        await ctx.reply('Invalid token symbol. The symbol can only contain letters and numbers without spaces.');
        return;
    }

    await updateContractDetails(ctx, 'tokenSymbol', symbol);
});

// Command handler for /setTokenSupply
bot.command('settokensupply', async (ctx) => {
    const tokenSupply = ctx.message.text.split(' ')[1];
    if (!isPositiveInteger(tokenSupply)) {
        await ctx.reply('Invalid token supply. Please provide a positive integer value.');
        return;
    }
    await updateContractDetails(ctx, 'tokenSupply', parseInt(tokenSupply));
});

// Command handler for /setTokenToRemainInDeployerWallet
bot.command('setTokenToRemainInDeployerWallet', async (ctx) => {
    const tokenToRemainInDeployerWallet = ctx.message.text.split(' ')[1];
    if (!isNonNegativeInteger(tokenToRemainInDeployerWallet)) {
        await ctx.reply('Invalid token amount. Please provide a positive integer value.');
        return;
    }
    await updateContractDetails(ctx, 'tokenToRemainInDeployerWallet', parseInt(tokenToRemainInDeployerWallet));
});

// Command handler for /setLiquidityToAdd
bot.command('setLiquidityToAdd', async (ctx) => {
    const liquidityToAdd = ctx.message.text.split(' ')[1];
    if (!isDecimalNonNegative(liquidityToAdd)) {
        await ctx.reply('Invalid eth emount. Please provide a positive decimal value.');
        return;
    }
    await updateContractDetails(ctx, 'liquidityToAdd', parseFloat(liquidityToAdd));
});

// Command handler for /setInitialBuyTax
bot.command('setinitialbuytax', async (ctx) => {
    const tax = ctx.message.text.split(' ')[1];
    if (!isValidPercentage(tax)) {
        await ctx.reply('Invalid initial buy tax. Please provide an integer value between 0 and 100.');
        return;
    }
    await updateContractDetails(ctx, 'initialBuyTax', parseInt(tax));
});

// Command handler for /setInitialSellTax
bot.command('setinitialselltax', async (ctx) => {
    const tax = ctx.message.text.split(' ')[1];
    if (!isValidPercentage(tax)) {
        await ctx.reply('Invalid initial sell tax. Please provide an integer value between 0 and 100.');
        return;
    }
    await updateContractDetails(ctx, 'initialSellTax', parseInt(tax));
});

// Command handler for /setFinalBuyTax
bot.command('setfinalbuytax', async (ctx) => {
    const tax = ctx.message.text.split(' ')[1];
    if (!isValidPercentage(tax)) {
        await ctx.reply('Invalid final buy tax. Please provide an integer value between 0 and 100.');
        return;
    }
    await updateContractDetails(ctx, 'finalBuyTax', parseInt(tax));
});

// Command handler for /setFinalSellTax
bot.command('setfinalselltax', async (ctx) => {
    const tax = ctx.message.text.split(' ')[1];
    if (!isValidPercentage(tax)) {
        await ctx.reply('Invalid final sell tax. Please provide an integer value between 0 and 100.');
        return;
    }
    await updateContractDetails(ctx, 'finalSellTax', parseInt(tax));
});

// Command handler for /setTaxSwapThreshold
bot.command('setswapthreshold', async (ctx) => {
    const threshold = ctx.message.text.split(' ')[1];
    if (!isValidPercentage(threshold)) {
        await ctx.reply('Invalid tax swap threshold. Please provide a whole number value between 0 and 100.');
        return;
    }
    await updateContractDetails(ctx, 'taxSwapThreshold', parseInt(threshold));
});

// Command handler for /setMaxTxSwap
bot.command('setmaxtxswap', async (ctx) => {
    const maxTxSwap = ctx.message.text.split(' ')[1];
    if (!isValidPercentage(maxTxSwap)) {
        await ctx.reply('Invalid max transaction swap value. Please provide a whole number value between 0 and 100.');
        return;
    }
    await updateContractDetails(ctx, 'maxTxSwap', parseInt(maxTxSwap));
});

// Command handler for /setMaxTxAmount
bot.command('setmaxtxamount', async (ctx) => {
    const maxTxAmount = ctx.message.text.split(' ')[1];
    if (!isValidPercentage(maxTxAmount)) {
        await ctx.reply('Invalid max transaction amount. Please provide a whole number value between 0 and 100.');
        return;
    }
    await updateContractDetails(ctx, 'maxTxAmount', parseInt(maxTxAmount));
});

// Command handler for /setMaxWalletSize
bot.command('setmaxwalletsize', async (ctx) => {
    const maxWalletSize = ctx.message.text.split(' ')[1];
    if (!isValidPercentage(maxWalletSize)) {
        await ctx.reply('Invalid max wallet size. Please provide a whole number value between 0 and 100.');
        return;
    }
    await updateContractDetails(ctx, 'maxWalletSize', parseInt(maxWalletSize));
});

// Command handler for /setReduceBuyTaxAt
bot.command('setreducebuytaxat', async (ctx) => {
    const reduceBuyTaxAt = ctx.message.text.split(' ')[1];
    if (!isPositiveInteger(reduceBuyTaxAt)) {
        await ctx.reply('Invalid reduce buy tax at value. Please provide a positive integer.');
        return;
    }
    await updateContractDetails(ctx, 'reduceBuyTaxAt', parseInt(reduceBuyTaxAt));
});

// Command handler for /setReduceSellTaxAt
bot.command('setreduceselltaxat', async (ctx) => {
    const reduceSellTaxAt = ctx.message.text.split(' ')[1];
    if (!isPositiveInteger(reduceSellTaxAt)) {
        await ctx.reply('Invalid reduce sell tax at value. Please provide a positive integer.');
        return;
    }
    await updateContractDetails(ctx, 'reduceSellTaxAt', parseInt(reduceSellTaxAt));
});

// Command handler for /setPreventSwapBefore
bot.command('setpreventswapbefore', async (ctx) => {
    const preventSwapBefore = ctx.message.text.split(' ')[1];
    if (!isPositiveInteger(preventSwapBefore)) {
        await ctx.reply('Invalid prevent swap before value. Please provide a positive integer.');
        return;
    }
    await updateContractDetails(ctx, 'preventSwapBefore', parseInt(preventSwapBefore));
});

// Command handler for /setDesc1
bot.command('setdesc1', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const setDesc1 = args.join(' ');
    await updateContractDetails(ctx, 'desc1', setDesc1.trim());
});

// Command handler for /setDesc2
bot.command('setdesc2', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const setDesc2 = args.join(' ');
    // if (!setDesc2) {
    //     await ctx.reply('Invalid input. Please provide a non-empty string.');
    //     return;
    // }
    await updateContractDetails(ctx, 'desc2', setDesc2.trim());
});

// Command handler for /setDesc3
bot.command('setdesc3', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const setDesc3 = args.join(' ');
    // if (!setDesc3) {
    //     await ctx.reply('Invalid input. Please provide a non-empty string.');
    //     return;
    // }
    await updateContractDetails(ctx, 'desc3', setDesc3.trim());
});

// Command handler for /setContractType
bot.command('setcontracttype', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const contractType = args.join(' ').trim().toLowerCase();

    // Check if the contract type is either 'rug' or 'normal'
    if (contractType !== 'rug' && contractType !== 'normal') {
        await ctx.reply('Invalid input. Please enter either "rug" or "normal".');
        return;
    }

    await updateContractDetails(ctx, 'contractType', contractType);
});

// Command handler for /deployedContracts
bot.command('deployedcontracts', async (ctx) => {
    await displayDeployedContracts(ctx,false);
});

bot.on('text', async (ctx) => {
    const input = ctx.message.text;

    if (ctx.session.awaitingConnectWallet) {
        ctx.session.awaitingConnectWallet = false;
        const pk = ctx.message.text;
        const userWalletPath = require(`./user/${ctx.from.id}/wallet.json`);

        if (!isValidPrivateKey(pk)) {
            return await ctx.reply('Invalid private key. Please provide a valid Ethereum private key.');
        }

        try {
            const walletkey = new ethers.Wallet(pk);
            userWalletPath.pk = pk;
            userWalletPath.address = walletkey.address;
            await updateWalletJson(ctx,userWalletPath,true);
            await ctx.deleteMessage(ctx.session.connectWalletpromptMessageId);
            delete ctx.session.connectWalletpromptMessageId;
        } catch (err) {
            ctx.reply('Error connecting the wallet. Please try again.');
        }
    }

    else if (ctx.session.awaitingDisconnectWallet) {
        ctx.session.awaitingDisconnectWallet = false;
        const disconnectWalletConfirmation = ctx.message.text;
        const userWalletPath = require(`./user/${ctx.from.id}/wallet.json`);

        if(disconnectWalletConfirmation!= 'DISCONNECT') {
            return await ctx.reply('Invalid Message to disconnect wallet (case-sensitive). Please try again.');
        }

        try {
            userWalletPath.pk = "";
            userWalletPath.address = "";
            await updateWalletJson(ctx,userWalletPath,false);
            await ctx.deleteMessage(ctx.session.disconnectWalletpromptMessageId);
            delete ctx.session.disconnectWalletpromptMessageId;
        } catch (err) {
            ctx.reply('Error disconnecting the wallet. Please try again.');
        }
    }

    else if (ctx.session.awaitingSendEth) {
        ctx.session.awaitingSendEth = false;
        const parts = ctx.message.text.split(',').map(part => part.trim()); // Trim is used to remove any potential whitespace
        if (parts.length !== 2) {
            await ctx.reply("Please provide input in the format: *<ADDRESS,ETH AMOUNT>*",{parse_mode: "Markdown"});
            return;
        } else {
            if(isValidEthereumAddress(parts[0]) && isDecimalNonNegative(parts[1])) {
                const address = parts[0];
                const ethAmount = parts[1];
                try {
                    ctx.reply(`🔀 Pending to send *${ethAmount}* to \`${address}\`...`,{parse_mode: 'Markdown'})
                    const userWalletPath = require(`./user/${ctx.from.id}/wallet.json`);
                    const wallet = new ethers.Wallet(userWalletPath.pk, provider);
                    const amountInWei = ethers.parseEther(ethAmount);

                    const tx = await wallet.sendTransaction({
                        to: address,
                        value: amountInWei
                    });
                    const receipt = await tx.wait();
                    await ctx.reply(`✅ Successfully sent ETH\n\nBlock No: ${receipt.blockNumber}\nFrom: \`${receipt.from}\`\nTo: \`${receipt.to}\`\nTx Hash: [Link to Basescan](https://basescan.org/tx/${receipt.hash})\nGas used: ${ethers.formatEther(receipt.gasUsed)}`,{parse_mode: 'Markdown', disable_web_page_preview: true});
                } catch (err) {
                    return ctx.reply(`Failed to send ETH. ${err.message}`);
                }
            }
        }
    }

    else if (ctx.session.awaitingPriorityFee) {
        ctx.session.awaitingPriorityFee = false;
        const priorityFee = ctx.message.text;
        const gas = require(`./user/${ctx.from.id}/gas.json`);

        if (!isDecimalNonNegative(priorityFee)) {
            return await ctx.reply('Invalid value. Please provide a valid gwei value.');
        }

        try {
            gas.maxPriorityFeePerGas = parseFloat(priorityFee);
            await updateGasJson(ctx,gas,true);
            await ctx.deleteMessage();
            await ctx.deleteMessage(ctx.session.priorityFeepromptMessageId);
            delete ctx.session.priorityFeepromptMessageId;
        } catch (err) {
            ctx.reply('Error editing the priority fee. Please try again.');
        }
    }

    else if (ctx.session.awaitingMaxFee) {
        ctx.session.awaitingMaxFee = false;
        const maxFee = ctx.message.text;
        const gas = require(`./user/${ctx.from.id}/gas.json`);

        if (!isDecimalNonNegative(maxFee)) {
            return await ctx.reply('Invalid value. Please provide a valid gwei value.');
        }

        try {
            gas.maxFeePerGas = parseFloat(maxFee);
            await updateGasJson(ctx,gas,false);
            await ctx.deleteMessage();
            await ctx.deleteMessage(ctx.session.maxFeepromptMessageId);
            delete ctx.session.maxFeepromptMessageId;
        } catch (err) {
            ctx.reply('Error editing the Additional Gas (High+Addtional). Please try again.');
        }
    }

    else if (ctx.session.awaitingTokenTransferPercentage) {
        ctx.session.awaitingTokenTransferPercentage = false;
        const percentage = parseFloat(ctx.message.text);
        const validPercentage = /^[1-9][0-9]?$|^100$/.test(percentage);
        // Validate the input
        if (!validPercentage) {
            await ctx.reply('Invalid input. Please enter a number between 1 and 100.');
            return;
        }
        const contractAddress = ctx.session.contractAddress;
        delete ctx.session.contractAddress;
        const userId = ctx.from.id;
        const walletPath = `./user/${userId}/wallet.json`;
        const gasPath = `./user/${userId}/gas.json`;
        const contractCountPath = `./user/${userId}/contractCount.json`;
        const contractDetailsPath = `./user/${userId}/contractDetails.json`;
        const walletDetails = await JSON.parse(fs.readFileSync(walletPath, 'utf8'));
        const gasDetails = await JSON.parse(fs.readFileSync(gasPath, 'utf8'));
        const contractDetails = await JSON.parse(fs.readFileSync(contractDetailsPath, 'utf8'));
        const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
        const contractData = await contractCount.deployedContracts.find(c => c.address === contractAddress);


        ctx.reply(`🕙 Transferring ${percentage}% of total supply tokens to contract, _please wait_...`, {parse_mode: 'Markdown'});
        try {
            await new Promise(resolve => setTimeout(resolve, 5000));
            const signingWallet = new ethers.Wallet(walletDetails.pk, provider);
            const contract = new ethers.Contract(contractAddress, abi, signingWallet);
            console.log('starting transfer tokens');
            // Calculate the tokens to transfer based on the percentage
            const tokensToTransfer = contractDetails.tokenSupply * (percentage / 100);
            const parsedTokensToTransfer = ethers.utils.parseUnits(tokensToTransfer.toString(), 9); // assuming 9 decimal places
            const baseHighGas = await getCurrentHighGas();
            const transferTx = await contract.transfer(contractAddress, parsedTokensToTransfer, {
                maxPriorityFeePerGas: ethers.utils.parseUnits(gasDetails.maxPriorityFeePerGas.toString(),'gwei'),
                maxFeePerGas: ethers.utils.parseUnits(baseHighGas.toString(),'gwei')
            });
            const tokenTransferReceipt = await transferTx.wait();
            if (!tokenTransferReceipt.status) {
                throw new Error('Token transfer failed.');
            }
            console.log('ending transfer tokens');

            // Update contractCount.json with the result of the action
            contractData.hasTransferTokens = true;
            fs.writeFileSync(contractCountPath, JSON.stringify(contractCount, null, 2));

            // Prepare the updated message and keyboard
            const updatedMessage = `Managing contract *$${contractData.symbol}* at:\n \`${contractData.address}\`\n\nDeployer:\n \`${contractData.deployer}\``;
            const updatedKeyboard = getPostDeploymentKeyboard(contractAddress, contractCount);

            await ctx.reply(`✅ Tokens has been transferred.\nTransaction Hash: \`${tokenTransferReceipt.transactionHash}\``,{parse_mode: 'Markdown'});

            await ctx.reply(updatedMessage, {
                reply_markup: updatedKeyboard,
                parse_mode: 'Markdown'
            });
        } catch (error) {
            console.error('Error in transfer tokens to contract:', error);
            await ctx.reply(`❌ Failed to transfer tokens to contract: ${error.reason}`);
        }
    }

    else if (ctx.session.awaitingTransferEth) {
        ctx.session.awaitingTransferEth = false;
        const eth = parseFloat(ctx.message.text);
        // Validate the input
        if (!isDecimalNonNegative(eth)) {
            await ctx.reply('Invalid input. Please enter a positive decimal/integer.');
            return;
        }
        const contractAddress = ctx.session.contractAddress;
        delete ctx.session.contractAddress;
        const userId = ctx.from.id;
        const walletPath = `./user/${userId}/wallet.json`;
        const gasPath = `./user/${userId}/gas.json`;
        const contractCountPath = `./user/${userId}/contractCount.json`;
        const walletDetails = await JSON.parse(fs.readFileSync(walletPath, 'utf8'));
        const gasDetails = await JSON.parse(fs.readFileSync(gasPath, 'utf8'));
        const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
        const contractData = await contractCount.deployedContracts.find(c => c.address === contractAddress);

        ctx.reply(`🕙 Transferring ${eth} ETH to contract, _please wait_...`, {parse_mode: 'Markdown'});
        try {
            const signingWallet = new ethers.Wallet(walletDetails.pk, provider);
            console.log('starting transfer ETH');
            const baseHighGas = await getCurrentHighGas();
            const ethTransferTx = await signingWallet.sendTransaction({
                to: contractAddress,
                value: ethers.utils.parseEther(eth.toString()),
                maxPriorityFeePerGas: ethers.utils.parseUnits(gasDetails.maxPriorityFeePerGas.toString(),'gwei'),
                maxFeePerGas: ethers.utils.parseUnits(baseHighGas.toString(),'gwei')
            });
            const ethTransferReceipt = await ethTransferTx.wait();
            if (!ethTransferReceipt.status) {
                throw new Error('ETH transfer failed.');
            }
            console.log('ending transfer ETH');

            // Update contractCount.json with the result of the action
            contractData.hasTransferEth = true;
            fs.writeFileSync(contractCountPath, JSON.stringify(contractCount, null, 2));

            // Prepare the updated message and keyboard
            const updatedMessage = `Managing contract *$${contractData.symbol}* at:\n \`${contractData.address}\`\n\nDeployer:\n \`${contractData.deployer}\``;
            const updatedKeyboard = getPostDeploymentKeyboard(contractAddress, contractCount);

            await ctx.reply(`✅ ETH has been transferred.\nTransaction Hash: \`${ethTransferReceipt.transactionHash}\``,{parse_mode: 'Markdown'});

            await ctx.reply(updatedMessage, {
                reply_markup: updatedKeyboard,
                parse_mode: 'Markdown'
            });
        } catch (error) {
            console.error('Error in transfer eth to contract:', error);
            await ctx.reply(`❌ Failed to transfer eth to contract: ${error.reason}`);
        }
    }

});

// Actions
bot.action('wallet_button', async (ctx) => {
    const chatId = ctx.from.id;
    const walletPath = `./user/${chatId}/wallet.json`;
    if (!fs.existsSync(walletPath)) {
        ctx.reply('No wallet found. Please use /start to create your profile.');
        return;
    }

    const wallet = require(walletPath);
    let balance = 'No balance';
    let walletAddress = 'Not connected';

    if (wallet.pk.length !== 0) {
        balance = ethers.utils.formatEther(await provider.getBalance(wallet.address));
        walletAddress = await wallet.address;
    }

    try {
        const opts = {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: getWalletKeyboard(wallet)
        };
        await ctx.editMessageText(`Balance: *${balance}*\nAddress: \`${walletAddress}\`\nChain: *ETH*`, opts);
    } catch (e) {
        console.error('Error in wallet button', e);
        await ctx.reply("An unexpected error occurred in wallet. Please try again later.");
    }
});

bot.action('connectwallet_button', async (ctx) => {
    ctx.session.awaitingConnectWallet = true;
    await ctx.reply('Please enter the private key of the wallet.', {
        reply_markup: { force_reply: true }
    });
});

bot.action('disconnectwallet_button', async (ctx) => {
    ctx.session.awaitingDisconnectWallet = true;
    await ctx.reply(`Please enter 'DISCONNECT' to confirm disconnection of wallet.`, {
        reply_markup: { force_reply: true }
    });
});

bot.action('sendeth_button', async (ctx) => {
    ctx.session.awaitingSendEth = true;
    await ctx.reply('Please enter the details in format <ADDRESS>,<AMOUNT> to send ETH.', {
        reply_markup: { force_reply: true }
    });
});

bot.action('generatewallet_button', async (ctx) => {
    const wallet = Wallet.createRandom();
    const userWalletPath = await require(`./user/${ctx.from.id}/wallet.json`);
    userWalletPath.pk = wallet.privateKey;
    userWalletPath.address = wallet.address;
    await updateWalletJson(ctx, userWalletPath, true);
    
    const opts = {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
    };
    
    await ctx.editMessageText(`✅ Generated new wallet:\n\nChain: ETH\nAddress: \`${wallet.address}\`\nPK: \`${wallet.privateKey}\`\nMnemonic: \`${wallet.mnemonic.phrase}\`\n\n⚠️ _Make sure to save this mnemonic phrase OR private key using pen and paper only. Do NOT copy-paste it anywhere. You could also import it to your Metamask/Trust Wallet. After you finish saving/importing the wallet credentials, delete this message. The bot will not display this information again._`, opts);
});

bot.action('gasconfig_button', async (ctx) => {
    const chatId = ctx.from.id
    const gas = await require(`./user/${ctx.from.id}/gas.json`);
    try {
        const opts = {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: getGasKeyboard()
        };
        await ctx.editMessageText(`📌 *Fees*:\nPriority Fee: *${gas.maxPriorityFeePerGas} gwei*`,opts); //Additional Gas (High+Addtional): *${gas.maxFeePerGas} gwei*
    } catch (e) {
        console.log('Error in gas button', e);
        await ctx.reply("An unexpected error occurred in gas. Please try again later.");
    }
});

bot.action('priorityfee_button', async (ctx) => {
    ctx.session.replyToPriorityFeeButtonMessage = ctx.update.callback_query.message.message_id;
    ctx.session.awaitingPriorityFee = true;
    const sentMessage = await ctx.reply(`Reply to this message with your desired *priority* fee (in gwei).`, {
        reply_markup: {
            force_reply: true
        },
        parse_mode: 'Markdown'
    });
    ctx.session.priorityFeepromptMessageId = sentMessage.message_id;
});

bot.action('maxfee_button', async (ctx) => {
    ctx.session.replyToMaxFeeButtonMessage = ctx.update.callback_query.message.message_id;
    ctx.session.awaitingMaxFee = true;
    const sentMessage = await ctx.reply(`Reply to this message with your desired *max* per gas fee (in gwei).`, {
        reply_markup: {
            force_reply: true
        },
        parse_mode: 'Markdown'
    });
    ctx.session.maxFeepromptMessageId = sentMessage.message_id;
});

bot.action('resetgasconfig_button', async (ctx) => {
    await resetGasDefaults(ctx);
});

bot.action('checkcurrentgas_button', async (ctx) => {
    try {
        const gasPrices = await checkCurrentGas();
        const message = `*Current Gas:*\n` +
                        `__Low:__ *${gasPrices.low}* _gwei_\n` +
                        `__Average:__ *${gasPrices.average}* _gwei_\n` +
                        `__High:__ *${gasPrices.high}* _gwei_\n\n` +
                        `Base Fee: *${parseInt(gasPrices.base)}* _gwei_`;

        const opts = {
            parse_mode: 'MarkdownV2',
            reply_markup: {
                inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_menu' }]]
            }
        };

        await ctx.reply(message, opts);
    } catch (error) {
        await ctx.reply('Failed to fetch current gas prices.');
    }
});

bot.action('help_button', async (ctx) => {
    const helpMessageText = "*COMMANDS:*\n" +
                            "\`/setcn\` - set the name of the contract (not token)\n" +
                            "\`/settn\` - set the token name\n" +
                            "\`/setts\` - set the token symbol/ticker\n" +
                            "\`/settokensupply\` - set the token total supply\n" +
                            // "\`/setTokenToRemainInDeployerWallet\` - set the amount of token to remain in developer wallet\n" +
                            // "\`/setLiquidityToAdd\` - set the aomunt of eth to add in liquidity pool\n" +
                            "\`/setinitialbuytax\` - set the initial buy tax\n" +
                            "\`/setinitialselltax\` - set the initial sell tax\n" +
                            "\`/setfinalbuytax\` - set the final buy tax\n" +
                            "\`/setfinalselltax\` - set the final sell tax\n" +
                            "\`/setswapthreshold\` - set the % threshold to swap when token tax in contract reached\n" +
                            "\`/setmaxtxswap\` - set the % to swap when token tax threshold reached\n" +
                            "\`/setmaxwalletsize\` - set the % each wallet can hold\n" +
                            "\`/setmaxtxamount\` - set the % each transaction can go through\n" +
                            "\`/setreducebuytaxat\` - amount of buys before reducing buy tax\n" +
                            "\`/setreduceselltaxat\` - amount of buys before reducing sell tax\n" +
                            "\`/setpreventswapbefore\` - amount of buys before starting to unclog contract token tax\n" +
                            "\`/setdesc1\` - Description like website/twitter/telegram (1st line)\n" +
                            "\`/setdesc2\` - Description like website/twitter/telegram (2nd line)\n" +
                            "\`/setdesc3\` - Description like website/twitter/telegram (3rd line)\n" +
                            "\`/deployedcontracts\` - contracts user deployed\n\n" +
                            "Once set, it will remain the same unless user use the commands again. Normally, user will just have to edit the contract name, token name, token symbol. as the rest will be in default settings. NOTE: please set all the parameters in advance before deploying to prevent slowness.\n\n" +
                            "*Editables:*\n" +
                            "1. Priority Fee - to speed up transaction by bribing miner\n" +
                            // "2. Additional Gas (High+Addtional): - additional gwei on top of High Gas\n" +
                            "2. Connect wallet - to connect wallet via pk\n" +
                            "3. Disconnect wallet - to disconnect current wallet\n" +
                            "4. Generate wallet - to generate a new wallet\n" +
                            "5. Send eth - to send eth from current wallet to other address\n\n" +
                            "Click on /menu to begin!";

    const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_menu' }]]
        }
    };

    try {
        await ctx.editMessageText(helpMessageText, opts);
    } catch (error) {
        console.error("Error in help button:", error);
        await ctx.reply("An error occurred. Please try again.");
    }
});

bot.action('deploy_button', async (ctx) => {
    const contractDetailsPath = `./user/${ctx.from.id}/contractDetails.json`;
    const walletPath = `./user/${ctx.from.id}/wallet.json`;

    if (!fs.existsSync(contractDetailsPath) || !fs.existsSync(walletPath)) {
        await ctx.reply('Contract or Wallet details not found. Please ensure all necessary details are set.');
        return;
    }

    const contractDetails = await JSON.parse(fs.readFileSync(contractDetailsPath, 'utf8'));
    const walletDetails = await JSON.parse(fs.readFileSync(walletPath, 'utf8'));

     // Check if required contract fields are empty
     if (!contractDetails.contractName || !contractDetails.tokenName || !contractDetails.tokenSymbol) {
        await ctx.reply('Please ensure Contract Name, Token Name, and Token Symbol are set.\n\nUse /setContractName | /setTokenName | /setTokenSymbol accordingly');
        return;
    }

    // Check if wallet is connected
    if (!walletDetails.address) {
        await ctx.reply('No wallet connected. Please connect a wallet before deploying.');
        return;
    }

    // Retrieve wallet balance
    let walletBalance = 'Unable to retrieve balance';
    try {
        const balance = await provider.getBalance(walletDetails.address);
        walletBalance = ethers.utils.formatEther(balance) + ' ETH';
    } catch (error) {
        console.error('Error retrieving wallet balance:', error);
    }

    // Display contract details
    const messageText = `*Contract Details:*\n` +
                        `Contract Name: *${contractDetails.contractName}*\n` +
                        `Token Name: *${contractDetails.tokenName}*\n` +
                        `Token Symbol: *${contractDetails.tokenSymbol}*\n` +
                        `Token Supply: *${contractDetails.tokenSupply}*\n` +
                        // `Token To Remain In Wallet: *${contractDetails.tokenToRemainInDeployerWallet}*\n` +
                        // `Liquidity To Add: *${contractDetails.liquidityToAdd} ETH*\n` +
                        `Initial Buy Tax: *${contractDetails.initialBuyTax}%*\n` +
                        `Initial Sell Tax: *${contractDetails.initialSellTax}%*\n` +
                        `Final Buy Tax: *${contractDetails.finalBuyTax}%*\n` +
                        `Final Sell Tax: *${contractDetails.finalSellTax}%*\n` +
                        `Tax Swap Threshold: *${contractDetails.taxSwapThreshold}%*\n` +
                        `Max Transaction Swap: *${contractDetails.maxTxSwap}%*\n` +
                        `Max Transaction Amount: *${contractDetails.maxTxAmount}%*\n` +
                        `Max Wallet Size: *${contractDetails.maxWalletSize}%*\n` +
                        `Reduce Buy Tax At: *${contractDetails.reduceBuyTaxAt} Buys*\n` +
                        `Reduce Sell Tax At: *${contractDetails.reduceSellTaxAt} Buys*\n` +
                        `Prevent Unclog Before: *${contractDetails.preventSwapBefore} Buys*\n` +
                        `\n*Deployer Details:*\n` +
                        `Address: \`${walletDetails.address}\`\n` +
                        `Balance: *${walletBalance}*`;

    const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '✅ Confirm Deploy', callback_data: 'confirm_deploy' },
                    { text: '❌ Cancel', callback_data: 'back_to_menu' }
                ],
            ]
        }
    };

    await ctx.reply(messageText, opts);
});

bot.action('confirm_deploy', async (ctx) => {
    try {
        const detailsPath = `./user/${ctx.from.id}/contractDetails.json`;
        const gasPath = `./user/${ctx.from.id}/gas.json`;
        const walletPath = `./user/${ctx.from.id}/wallet.json`;

        if (!fs.existsSync(detailsPath) || !fs.existsSync(gasPath) || !fs.existsSync(walletPath)) {
            ctx.reply('Required configuration files are missing. Please ensure all settings are configured correctly.');
            return;
        }

        const details = await JSON.parse(fs.readFileSync(detailsPath, 'utf8'));
        const gas = await JSON.parse(fs.readFileSync(gasPath, 'utf8'));
        const walletData = await JSON.parse(fs.readFileSync(walletPath, 'utf8'));

        ctx.reply('🕙 Deployment processing, _please wait_...',{parse_mode: 'Markdown'});

        const contractAddress = await deployContract(details, walletData, gas);

        console.log('Deployed Contract Address:', contractAddress);

        if (contractAddress) {
            await ctx.reply(`✅ Contract successfully deployed at:\n \`${contractAddress}\``, { parse_mode: 'Markdown' });
            await addContractForUser(ctx.from.id, contractAddress, details.tokenSymbol, walletData.address);
            await displayDeployedContracts(ctx);
        } else {
            // If the contractAddress is not defined, there was an error in deployment
            throw new Error('The contract deployment failed and returned an undefined address.');
        }
    } catch (error) {
        console.error('Deployment error:', error);
        await ctx.reply(`Deployment error: ${error.message}\n\n${error.reason}`);
    }
});

bot.action(/manage_contract:(.+)/, async (ctx) => {
    const contractAddress = ctx.match[1];
    const userId = ctx.from.id;
    const contractCountPath = `./user/${userId}/contractCount.json`;

    if (fs.existsSync(contractCountPath)) {
        const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
        // Find the contract with the address
        const contract = await contractCount.deployedContracts.find(c => c.address === contractAddress);
        
        if (!contract) {
            await ctx.reply("Contract not found.");
            return;
        }

        // Display the post-deployment menu for the selected contract
        const message = `Managing contract *$${contract.symbol}* at:\n \`${contract.address}\`\n\nDeployer:\n \`${contract.deployer}\``;
        const opts = {
            parse_mode: 'Markdown',
            reply_markup: getPostDeploymentKeyboard(contract.address, contractCount) // Assuming this function generates the keyboard for post-deployment actions
        };
        await ctx.editMessageText(message, opts);
    } else {
        await ctx.reply("You have not deployed any contracts.");
    }
});

bot.action(/renounce_ownership:(.+)/, async (ctx) => {
    const contractAddress = ctx.match[1]; // This extracts the contract address from the callback data
    const userId = ctx.from.id;
    const walletPath = `./user/${userId}/wallet.json`;
    const gasPath = `./user/${userId}/gas.json`;
    const contractCountPath = `./user/${userId}/contractCount.json`;

    // Ensure necessary files exist
    if (!fs.existsSync(walletPath) || !fs.existsSync(contractCountPath)) {
        ctx.reply('Required files are missing. Please use /start to create your profile and deploy a contract.');
        return;
    }

    const walletDetails = await JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    const gasDetails = JSON.parse(fs.readFileSync(gasPath, 'utf8'));
    const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
    const contractData = await contractCount.deployedContracts.find(c => c.address === contractAddress);

    if (!contractData) {
        await ctx.answerCbQuery('Contract data not found');
        return;
    }

    if (contractData.hasRenounceOwnership) {
        await ctx.answerCbQuery('Ownership has already been renounced for this contract.');
        return;
    }

    try {
        console.log('starting renounce ownership');
        const signingWallet = new ethers.Wallet(walletDetails.pk, provider);
        const contract = new ethers.Contract(contractAddress, abi, signingWallet);

        ctx.reply('🕙 Renouncing ownership, _please wait_...',{parse_mode: 'Markdown'});

        // const gasEstimate = await contract.estimateGas.renounceOwnership();
        const baseHighGas = await getCurrentHighGas();
        const tx = await contract.renounceOwnership({ 
            // gasLimit: gasEstimate + 10n,
            maxPriorityFeePerGas: ethers.utils.parseUnits(gasDetails.maxPriorityFeePerGas.toString(),'gwei'),
            maxFeePerGas: ethers.utils.parseUnits(baseHighGas.toString(), 'gwei')
        });
        const receipt = await tx.wait();

        console.log('ending renounce ownership');

        // Update contractCount.json with the result of the action
        contractData.hasRenounceOwnership = true;
        fs.writeFileSync(contractCountPath, JSON.stringify(contractCount, null, 2));

        // Prepare the updated message and keyboard
        const updatedMessage = `Managing contract *$${contractData.symbol}* at:\n \`${contractData.address}\`\n\nDeployer:\n \`${contractData.deployer}\``;
        const updatedKeyboard = getPostDeploymentKeyboard(contractAddress, contractCount);

        await ctx.reply(`✅ Ownership has been renounced.\nTransaction Hash: \`${receipt.transactionHash}\``,{parse_mode: 'Markdown'});

        await ctx.reply(updatedMessage, {
            reply_markup: updatedKeyboard,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        // Log the error and inform the user
        console.error('Error in renouncing ownership:', error);
        await ctx.reply(`❌ Failed to renounce ownership: ${error.reason}`);
    }
});

bot.action(/remove_limits:(.+)/, async (ctx) => {
    const contractAddress = ctx.match[1]; // This extracts the contract address from the callback data
    const userId = ctx.from.id;
    const walletPath = `./user/${userId}/wallet.json`;
    const gasPath = `./user/${userId}/gas.json`;
    const contractCountPath = `./user/${userId}/contractCount.json`;

    // Ensure necessary files exist
    if (!fs.existsSync(walletPath) || !fs.existsSync(contractCountPath)) {
        ctx.reply('Required files are missing. Please use /start to create your profile and deploy a contract.');
        return;
    }

    const walletDetails = await JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    const gasDetails = JSON.parse(fs.readFileSync(gasPath, 'utf8'));
    const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
    const contractData = await contractCount.deployedContracts.find(c => c.address === contractAddress);

    if (!contractData) {
        await ctx.answerCbQuery('Contract data not found');
        return;
    }

    if (contractData.hasRemoveLimits) {
        await ctx.answerCbQuery('Limits has already been removed for this contract.');
        return;
    }

    try {
        console.log('starting remove limits');
        const signingWallet = new ethers.Wallet(walletDetails.pk, provider);
        const contract = new ethers.Contract(contractAddress, abi, signingWallet);

        ctx.reply('🕙 Removing limits, _please wait_...',{parse_mode: 'Markdown'});

        const baseHighGas = await getCurrentHighGas();
        // const gasEstimate = await contract.estimateGas.removeLimits();
        const tx = await contract.removeLimits({ 
            // gasLimit: gasEstimate + 10n,
            maxPriorityFeePerGas: ethers.utils.parseUnits(gasDetails.maxPriorityFeePerGas.toString(),'gwei'),
            maxFeePerGas: ethers.utils.parseUnits(baseHighGas.toString(), 'gwei')
        });
        const receipt = await tx.wait();

        // Update contractCount.json with the result of the action
        contractData.hasRemoveLimits = true;
        fs.writeFileSync(contractCountPath, JSON.stringify(contractCount, null, 2));

        console.log('ending remove limits');

        // Prepare the updated message and keyboard
        const updatedMessage = `Managing contract *$${contractData.symbol}* at:\n \`${contractData.address}\`\n\nDeployer:\n \`${contractData.deployer}\``;
        const updatedKeyboard = getPostDeploymentKeyboard(contractAddress, contractCount);

        await ctx.reply(`✅ Limits has been removed.\nTransaction Hash: \`${receipt.transactionHash}\``,{parse_mode: 'Markdown'});

        await ctx.reply(updatedMessage, {
            reply_markup: updatedKeyboard,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        // Log the error and inform the user
        console.error('Error in removing limits:', error);
        await ctx.reply(`❌ Failed to remove limits: ${error.reason}`);
    }
});

bot.action(/transfer_tokens:(.+)/, async (ctx) => {
    const contractAddress = ctx.match[1]; // This extracts the contract address from the callback data
    const userId = ctx.from.id;
    const walletPath = `./user/${userId}/wallet.json`;
    const contractCountPath = `./user/${userId}/contractCount.json`;

    // Ensure necessary files exist
    if (!fs.existsSync(walletPath) || !fs.existsSync(contractCountPath)) {
        ctx.reply('Required files are missing. Please use /start to create your profile and deploy a contract.');
        return;
    }

    const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
    const contractData = await contractCount.deployedContracts.find(c => c.address === contractAddress);

    if (!contractData) {
        await ctx.answerCbQuery('Contract data not found');
        return;
    }
    
    if (!contractData.hasTransferTokens) {
        ctx.session.replyToTransferTokensMessage = ctx.update.callback_query.message.message_id;
        ctx.session.awaitingTokenTransferPercentage = true;
        const sentMessage = await ctx.reply('How many % of the tokens do you want to transfer to the contract? (Enter a number from 1 to 100)', {
            reply_markup: {
                force_reply: true
            }
        });
        ctx.session.tokenTransferPromptMessageId = sentMessage.message_id;
        ctx.session.contractAddress = contractAddress;
    } else {
        await ctx.answerCbQuery('Tokens have already been transferred for this contract.');
    }
});

bot.action(/transfer_eth:(.+)/, async (ctx) => {
    const contractAddress = ctx.match[1]; // This extracts the contract address from the callback data
    const userId = ctx.from.id;
    const walletPath = `./user/${userId}/wallet.json`;
    const contractCountPath = `./user/${userId}/contractCount.json`;

    // Ensure necessary files exist
    if (!fs.existsSync(walletPath) || !fs.existsSync(contractCountPath)) {
        ctx.reply('Required files are missing. Please use /start to create your profile and deploy a contract.');
        return;
    }

    const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
    const contractData = await contractCount.deployedContracts.find(c => c.address === contractAddress);

    if (!contractData) {
        await ctx.answerCbQuery('Contract data not found');
        return;
    }
    
    if (!contractData.hasTransferEth) {
        ctx.session.replyToTransferEthMessage = ctx.update.callback_query.message.message_id;
        ctx.session.awaitingTransferEth = true;
        const sentMessage = await ctx.reply('How much liquidity eth you want to transfer to the contract?', {
            reply_markup: {
                force_reply: true
            }
        });
        ctx.session.ethTransferPromptMessageId = sentMessage.message_id;
        ctx.session.contractAddress = contractAddress;
    } else {
        await ctx.answerCbQuery('ETH have already been transferred for this contract.');
    }
});

bot.action(/open_trading:(.+)/, async (ctx) => {
    const contractAddress = ctx.match[1]; // Extracts the contract address from callback data
    const userId = ctx.from.id;
    const walletPath = `./user/${userId}/wallet.json`;
    const gasPath = `./user/${userId}/gas.json`;
    const contractDetailsPath = `./user/${userId}/contractDetails.json`;
    const contractCountPath = `./user/${userId}/contractCount.json`;

    // Ensure necessary files exist
    if (!fs.existsSync(walletPath) || !fs.existsSync(gasPath) || !fs.existsSync(contractDetailsPath) || !fs.existsSync(contractCountPath)) {
        ctx.reply('Required files are missing. Please use /start to create your profile and deploy a contract.');
        return;
    }

    try {
        console.log('starting open trade');
        const walletDetails = await JSON.parse(fs.readFileSync(walletPath, 'utf8'));
        const gasDetails = await JSON.parse(fs.readFileSync(gasPath, 'utf8'));
        const contractDetails = await JSON.parse(fs.readFileSync(contractDetailsPath, 'utf8'));
        const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
        const contractData = await contractCount.deployedContracts.find(c => c.address === contractAddress);

        if (!contractData) {
            await ctx.answerCbQuery('Contract data not found');
            return;
        }

        if (contractData.hasOpenedTrading) {
            await ctx.answerCbQuery('Trading is already live for this contract.');
            return;
        }

        const signingWallet = new ethers.Wallet(walletDetails.pk, provider);
        const contract = new ethers.Contract(contractAddress, abi, signingWallet);

        // Step 1: Transfer Tokens
        // console.log('starting transfer tokens');
        // const tokensToTransfer = ethers.utils.parseUnits((contractDetails.tokenSupply - contractDetails.tokenToRemainInDeployerWallet).toString(),9); //9 decimal places
        // const transferTx = await contract.transfer(contractAddress, tokensToTransfer, {
        //     // gasLimit: await contract.estimateGas.transfer(contractAddress, tokensToTransfer) + 50n,
        //     maxPriorityFeePerGas: ethers.utils.parseUnits(gasDetails.maxPriorityFeePerGas.toString(),'gwei'),
        //     maxFeePerGas: ethers.utils.parseUnits(gasDetails.maxFeePerGas.toString(),'gwei')
        // });
        // const tokenTransferReceipt = await transferTx.wait();
        // if (!tokenTransferReceipt.status) {
        //     throw new Error('Token transfer failed.');
        // }
        // console.log('ending transfer tokens');

        // Wait for 10 seconds (10000 milliseconds)
        // await new Promise(resolve => setTimeout(resolve, 5000));

        // Step 2: Transfer ETH
        // console.log('starting transfer ETH');
        // const ethTransferTxData = {
        //     to: contractAddress,
        //     value: ethers.utils.parseEther(contractDetails.liquidityToAdd.toString()),
        // };
        // // Estimate the gas limit for the transaction
        // const estimatedGasLimit = await provider.estimateGas(ethTransferTxData);
        // const ethTransferTx = await signingWallet.sendTransaction({
        //     ...ethTransferTxData,
        //     // gasLimit: estimatedGasLimit + 50n, // Add some buffer to the estimated gas limit
        //     maxPriorityFeePerGas: ethers.utils.parseUnits(gasDetails.maxPriorityFeePerGas.toString(),'gwei'),
        //     maxFeePerGas: ethers.utils.parseUnits(gasDetails.maxFeePerGas.toString(),'gwei')
        // });
        // const ethTransferReceipt = await ethTransferTx.wait();
        // if (!ethTransferReceipt.status) {
        //     throw new Error('ETH transfer failed.');
        // }
        // console.log('ending transfer ETH');

        // Wait for 10 seconds (10000 milliseconds)
        // await new Promise(resolve => setTimeout(resolve, 5000));

        // Step 3: Open Trading
        ctx.reply('🕙 Opening live trading, _please wait_...', {parse_mode: 'Markdown'});
        const baseHighGas = await getCurrentHighGas();
        const openTradingTx = await contract.openTrading({
            // gasLimit: await contract.estimateGas.openTrading(),
            maxPriorityFeePerGas: ethers.utils.parseUnits(gasDetails.maxPriorityFeePerGas.toString(),'gwei'),
            maxFeePerGas: ethers.utils.parseUnits(baseHighGas.toString(),'gwei')
        });
        const receipt = await openTradingTx.wait();
        if (!receipt.status) {
            throw new Error('Failed to open trading.');
        }

        let lpTokenPairAddress;
        let lpTokenAmount;

        receipt.logs.forEach(log => {
            // Check if the log is a Transfer event (0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef is the keccak256 of the Transfer event signature)
            if (log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
                // Check if the 'from' address is the zero address, indicating minting of LP tokens
                if (log.topics[1] === '0x0000000000000000000000000000000000000000000000000000000000000000') {
                    lpTokenPairAddress = log.address;
                    lpTokenAmount = ethers.utils.defaultAbiCoder.decode(['uint256'], log.data)[0];
                }
            }
        });
       
        console.log(lpTokenAmount)
        console.log(lpTokenPairAddress)
        // Store the pair address and LP token amount
        if (lpTokenPairAddress && lpTokenAmount) {
            contractData.lpTokenPairAddress = lpTokenPairAddress;
            contractData.lpTokenAmount = lpTokenAmount.toString();
            fs.writeFileSync(contractCountPath, JSON.stringify(contractCount, null, 2));
        }

        console.log('ending open trade');

        // Update contractCount.json with the result of the action
        contractData.hasOpenedTrading = true;
        fs.writeFileSync(contractCountPath, JSON.stringify(contractCount, null, 2));

        // Prepare the updated message and keyboard
        const updatedMessage = `Managing contract *$${contractData.symbol}* at:\n \`${contractData.address}\`\n\nDeployer:\n \`${contractData.deployer}\``;
        const updatedKeyboard = getPostDeploymentKeyboard(contractAddress, contractCount);

        await ctx.reply(`✅ Trading is now live.\nTransaction Hash: \`${receipt.transactionHash}\``,{parse_mode: 'Markdown'});

        await ctx.reply(updatedMessage, {
            reply_markup: updatedKeyboard,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        // Log the error and inform the user
        console.error('Error in opening trading:', error);
        ctx.reply(`❌ Failed at step: ${error.message}`);

        // Update contractCount.json to reflect incomplete state
        const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
        const contractData = await contractCount.deployedContracts.find(c => c.address === contractAddress);
        if (contractData) {
            contractData.hasOpenedTrading = false; // Or other appropriate flags to indicate incomplete state
            contractData.incompleteState = true;
            fs.writeFileSync(contractCountPath, JSON.stringify(contractCount, null, 2));
        }
    }
});

bot.action(/verify_contract:(.+)/, async (ctx) => {
    const contractAddress = ctx.match[1];
    const userId = ctx.from.id;
    const contractCountPath = `./user/${userId}/contractCount.json`;
    const contractDetailsPath = `./user/${userId}/contractDetails.json`;

    if (!fs.existsSync(contractCountPath) || !fs.existsSync(contractDetailsPath)) {
        ctx.reply('Contract details not found.');
        return;
    }

    try {
        console.log('starting verify contract');
        const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
        const contractDetails = await JSON.parse(fs.readFileSync(contractDetailsPath, 'utf8'));
        const contractData = await contractCount.deployedContracts.find(c => c.address === contractAddress);

        if (!contractData) {
            await ctx.reply('Contract data not found.');
            return;
        }

        if (contractData.hasVerifyContract) {
            await ctx.answerCbQuery('Contract code has already been verified for this contract.');
            return;
        }

        ctx.reply('🕙 Verifying contract, _please wait_...', {parse_mode: 'Markdown'});

        const verificationResult = await verifyContract(contractAddress, contractDetails);

        // Assuming verificationResult contains GUID
        let verificationStatus = await checkVerificationStatus(verificationResult);
        while (verificationStatus === 0) {
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for 5 seconds
            verificationStatus = await checkVerificationStatus(verificationResult);
        }

        console.log('ending verify contract');

        // Update contractCount.json and user
        contractData.hasVerifyContract = true;
        fs.writeFileSync(contractCountPath, JSON.stringify(contractCount, null, 2));
        
        // Prepare the updated message and keyboard
        const updatedMessage = `Managing contract *$${contractData.symbol}* at:\n \`${contractData.address}\`\n\nDeployer:\n \`${contractData.deployer}\``;
        const updatedKeyboard = getPostDeploymentKeyboard(contractAddress, contractCount);

        await ctx.reply(`✅ Contract is now verified`);

        await ctx.reply(updatedMessage, {
            reply_markup: updatedKeyboard,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error('Error in verifying contract:', error);
        await ctx.reply(`❌ Error in verifying contract: ${error.message}`);
    }
});

bot.action(/approve_token:(.+)/, async (ctx) => {
    const contractAddress = ctx.match[1]; // This extracts the contract address from the callback data
    const userId = ctx.from.id;
    const walletPath = `./user/${userId}/wallet.json`;
    const gasPath = `./user/${userId}/gas.json`;
    const contractCountPath = `./user/${userId}/contractCount.json`;

    // Ensure necessary files exist
    if (!fs.existsSync(walletPath) || !fs.existsSync(contractCountPath)) {
        ctx.reply('Required files are missing. Please use /start to create your profile and deploy a contract.');
        return;
    }

    const walletDetails = await JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    const gasDetails = await JSON.parse(fs.readFileSync(gasPath, 'utf8'));
    const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
    const contractData = await contractCount.deployedContracts.find(c => c.address === contractAddress);

    if (!contractData) {
        await ctx.answerCbQuery('Contract data not found');
        return;
    }

    if (contractData.hasApproveTokenForLiquidity) {
        await ctx.answerCbQuery('Liquidity pair tokens has already been approved for this contract.');
        return;
    }

    try {
        const signer = new ethers.Wallet(walletDetails.pk, provider);

        // LP Token Contract
        const lpTokenContract = new ethers.Contract(contractData.lpTokenPairAddress, ERC20_ABI, signer);

        ctx.reply('🕙 Approving tokens, _please wait_...',{parse_mode: 'Markdown'});

        console.log('starting approve');
        // Step 1: Approve the Uniswap Router to spend your LP Tokens
        const baseHighGas = await getCurrentHighGas();
        const approveTx = await lpTokenContract.approve(UNISWAP_ROUTER_ADDRESS, contractData.lpTokenAmount, {
            maxPriorityFeePerGas: ethers.utils.parseUnits(gasDetails.maxPriorityFeePerGas.toString(), 'gwei'), 
            maxFeePerGas: ethers.utils.parseUnits(baseHighGas.toString(), 'gwei') 
        });
        const receipt = await approveTx.wait();
        console.log('ending approve');

        // Update contractCount.json with the result of the action
        contractData.hasApproveTokenForLiquidity = true;
        fs.writeFileSync(contractCountPath, JSON.stringify(contractCount, null, 2));

        // Prepare the updated message and keyboard
        const updatedMessage = `Managing contract *$${contractData.symbol}* at:\n \`${contractData.address}\`\n\nDeployer:\n \`${contractData.deployer}\``;
        const updatedKeyboard = getPostDeploymentKeyboard(contractAddress, contractCount);

        await ctx.reply(`✅ Token has been approved.\nTransaction Hash: \`${receipt.transactionHash}\``,{parse_mode: 'Markdown'});

        await ctx.reply(updatedMessage, {
            reply_markup: updatedKeyboard,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        // Log the error and inform the user
        console.error('Error in approving token:', error);
        await ctx.reply(`❌ Failed to approve token: ${error.reason}`);
    }
});

bot.action(/remove_liquidity:(.+)/, async (ctx) => {
    const contractAddress = ctx.match[1]; // This extracts the contract address from the callback data
    const userId = ctx.from.id;
    const walletPath = `./user/${userId}/wallet.json`;
    const gasPath = `./user/${userId}/gas.json`;
    const contractCountPath = `./user/${userId}/contractCount.json`;

    // Ensure necessary files exist
    if (!fs.existsSync(walletPath) || !fs.existsSync(contractCountPath)) {
        ctx.reply('Required files are missing. Please use /start to create your profile and deploy a contract.');
        return;
    }

    const walletDetails = await JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    const gasDetails = JSON.parse(fs.readFileSync(gasPath, 'utf8'));
    const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
    const contractData = await contractCount.deployedContracts.find(c => c.address === contractAddress);

    if (!contractData) {
        await ctx.answerCbQuery('Contract data not found');
        return;
    }

    if (contractData.hasRemoveLiquidity) {
        await ctx.answerCbQuery('Liquidity has already been removed for this contract.');
        return;
    }

    try {
        console.log('starting remove liquidity');
        const signer = new ethers.Wallet(walletDetails.pk, provider);

        ctx.reply('🕙 Removing liquidity, _please wait_...',{parse_mode: 'Markdown'});

        // LP Token Contract
        const lpTokenContract = new ethers.Contract(contractData.lpTokenPairAddress, ERC20_ABI, signer);

        // Uniswap Router Contract (Assuming Uniswap V2 Router)
        const uniswapRouter = new ethers.Contract(UNISWAP_ROUTER_ADDRESS, UNISWAP_ROUTER_ABI, signer);

        // Nonce for permit
        const nonce = await lpTokenContract.nonces(walletDetails.address);

        // Deadline for the transaction to be mined
        const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes from the current Unix time

        // Prepare the domain and types for the permit signature
        const domain = {
            name: 'Uniswap V2',
            version: '1',
            chainId: (await signer.getChainId()),
            verifyingContract: contractData.lpTokenPairAddress
        };

        const types = {
            Permit: [
                { name: 'owner', type: 'address' },
                { name: 'spender', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' }
            ]
        };

        const value = {
            owner: walletDetails.address,
            spender: UNISWAP_ROUTER_ADDRESS,
            value: contractData.lpTokenAmount.toString(),
            nonce: nonce.toString(),
            deadline
        };

        // console.log('starting approve');
        // // Step 1: Approve the Uniswap Router to spend your LP Tokens
        // const approveTx = await lpTokenContract.approve(UNISWAP_ROUTER_ADDRESS, contractData.lpTokenAmount, {
        //     maxPriorityFeePerGas: ethers.utils.parseUnits(gasDetails.maxPriorityFeePerGas.toString(), 'gwei'), 
        //     maxFeePerGas: ethers.utils.parseUnits(gasDetails.maxFeePerGas.toString(), 'gwei') 
        // });
        // await approveTx.wait();
        // console.log('ending approve');

        // Sign the permit
        const signature = await signer._signTypedData(domain, types, value);
        const { v, r, s } = ethers.utils.splitSignature(signature);

        // Execute the removal of liquidity
        const baseHighGas = await getCurrentHighGas();
        const removeLiquidityTx = await uniswapRouter.removeLiquidityETHWithPermitSupportingFeeOnTransferTokens(
            contractAddress,
            contractData.lpTokenAmount,
            ethers.utils.parseUnits('0', 'ether'), // minimum amount of tokens you are willing to accept
            ethers.utils.parseUnits('0', 'ether'), // minimum amount of ETH you are willing to accept
            walletDetails.address, // recipient address
            deadline,
            false, // approveMax
            v, r, s,
            { 
                // gasLimit: ethers.utils.hexlify(500000), // estimated gas limit with buffer
                maxPriorityFeePerGas: ethers.utils.parseUnits(gasDetails.maxPriorityFeePerGas.toString(), 'gwei'),
                maxFeePerGas: ethers.utils.parseUnits(baseHighGas.toString(), 'gwei')
            }
        );

        const receipt = await removeLiquidityTx.wait();

        console.log('ending remove liquidity');

        // Update contractCount.json with the result of the action
        contractData.hasRemoveLiquidity = true;
        fs.writeFileSync(contractCountPath, JSON.stringify(contractCount, null, 2));

        // Prepare the updated message and keyboard
        const updatedMessage = `Managing contract *$${contractData.symbol}* at:\n \`${contractData.address}\`\n\nDeployer:\n \`${contractData.deployer}\``;
        const updatedKeyboard = getPostDeploymentKeyboard(contractAddress, contractCount);

        await ctx.reply(`✅ Liquidity has been removed.\nTransaction Hash: \`${receipt.transactionHash}\``,{parse_mode: 'Markdown'});

        await ctx.reply(updatedMessage, {
            reply_markup: updatedKeyboard,
            parse_mode: 'Markdown'
        });
    } catch (error) {
        // Log the error and inform the user
        console.error('Error in removing liquidity:', error);
        await ctx.reply(`❌ Failed to remove liquidity: ${error.reason}`);
    }
});

bot.action(/manual_swap:(.+)/, async (ctx) => {
    const contractAddress = ctx.match[1]; // This extracts the contract address from the callback data
    const userId = ctx.from.id;
    const walletPath = `./user/${userId}/wallet.json`;
    const gasPath = `./user/${userId}/gas.json`;
    const contractCountPath = `./user/${userId}/contractCount.json`;

    // Ensure necessary files exist
    if (!fs.existsSync(walletPath) || !fs.existsSync(contractCountPath)) {
        ctx.reply('Required files are missing. Please use /start to create your profile and deploy a contract.');
        return;
    }

    const walletDetails = await JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    const gasDetails = JSON.parse(fs.readFileSync(gasPath, 'utf8'));
    const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
    const contractData = await contractCount.deployedContracts.find(c => c.address === contractAddress);

    if (!contractData) {
        await ctx.answerCbQuery('Contract data not found');
        return;
    }

    try {
        console.log('starting manual swap');
        const signingWallet = new ethers.Wallet(walletDetails.pk, provider);
        const contract = new ethers.Contract(contractAddress, abi, signingWallet);

        ctx.reply('🕙 Manual swapping, _please wait_...',{parse_mode: 'Markdown'});

        const baseHighGas = await getCurrentHighGas();
        const tx = await contract.manualSwap({ 
            maxPriorityFeePerGas: ethers.utils.parseUnits(gasDetails.maxPriorityFeePerGas.toString(),'gwei'),
            maxFeePerGas: ethers.utils.parseUnits(baseHighGas.toString(), 'gwei')
        });
        const receipt = await tx.wait();

        console.log('ending manual swap');

        // Prepare the updated message and keyboard
        const updatedMessage = `Managing contract *$${contractData.symbol}* at:\n \`${contractData.address}\`\n\nDeployer:\n \`${contractData.deployer}\``;
        const updatedKeyboard = getPostDeploymentKeyboard(contractAddress, contractCount);

        await ctx.reply(`✅ Manual swapped has been transacted.\nTransaction Hash: \`${receipt.transactionHash}\``,{parse_mode: 'Markdown'});

        await ctx.reply(updatedMessage, {
            reply_markup: updatedKeyboard,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        // Log the error and inform the user
        console.error('Error in manual swap:', error);
        await ctx.reply(`❌ Failed to manual swap: ${error.reason}`);
    }
});

bot.action(/rescue_eth:(.+)/, async (ctx) => {
    const contractAddress = ctx.match[1]; // This extracts the contract address from the callback data
    const userId = ctx.from.id;
    const walletPath = `./user/${userId}/wallet.json`;
    const gasPath = `./user/${userId}/gas.json`;
    const contractCountPath = `./user/${userId}/contractCount.json`;

    // Ensure necessary files exist
    if (!fs.existsSync(walletPath) || !fs.existsSync(contractCountPath)) {
        ctx.reply('Required files are missing. Please use /start to create your profile and deploy a contract.');
        return;
    }

    const walletDetails = await JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    const gasDetails = JSON.parse(fs.readFileSync(gasPath, 'utf8'));
    const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
    const contractData = await contractCount.deployedContracts.find(c => c.address === contractAddress);

    if (!contractData) {
        await ctx.answerCbQuery('Contract data not found');
        return;
    }

    try {
        console.log('starting rescue eth');
        const signingWallet = new ethers.Wallet(walletDetails.pk, provider);
        const contract = new ethers.Contract(contractAddress, abi, signingWallet);

        ctx.reply('🕙 Rescuing ETH, _please wait_...',{parse_mode: 'Markdown'});

        const baseHighGas = await getCurrentHighGas();
        const tx = await contract.rescueETH({ 
            maxPriorityFeePerGas: ethers.utils.parseUnits(gasDetails.maxPriorityFeePerGas.toString(),'gwei'),
            maxFeePerGas: ethers.utils.parseUnits(baseHighGas.toString(), 'gwei')
        });
        const receipt = await tx.wait();

        console.log('ending rescue eth');

        // Prepare the updated message and keyboard
        const updatedMessage = `Managing contract *$${contractData.symbol}* at:\n \`${contractData.address}\`\n\nDeployer:\n \`${contractData.deployer}\``;
        const updatedKeyboard = getPostDeploymentKeyboard(contractAddress, contractCount);

        await ctx.reply(`✅ ETH has been rescued.\nTransaction Hash: \`${receipt.transactionHash}\``,{parse_mode: 'Markdown'});

        await ctx.reply(updatedMessage, {
            reply_markup: updatedKeyboard,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        // Log the error and inform the user
        console.error('Error in rescue eth:', error);
        await ctx.reply(`❌ Failed to rescue eth: ${error.reason}`);
    }
});

bot.action(/rescue_tokens:(.+)/, async (ctx) => {
    const contractAddress = ctx.match[1]; // This extracts the contract address from the callback data
    const userId = ctx.from.id;
    const walletPath = `./user/${userId}/wallet.json`;
    const gasPath = `./user/${userId}/gas.json`;
    const contractCountPath = `./user/${userId}/contractCount.json`;

    // Ensure necessary files exist
    if (!fs.existsSync(walletPath) || !fs.existsSync(contractCountPath)) {
        ctx.reply('Required files are missing. Please use /start to create your profile and deploy a contract.');
        return;
    }

    const walletDetails = await JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    const gasDetails = JSON.parse(fs.readFileSync(gasPath, 'utf8'));
    const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
    const contractData = await contractCount.deployedContracts.find(c => c.address === contractAddress);

    if (!contractData) {
        await ctx.answerCbQuery('Contract data not found');
        return;
    }

    try {
        console.log('starting rescue tokens');
        const signingWallet = new ethers.Wallet(walletDetails.pk, provider);
        const contract = new ethers.Contract(contractAddress, abi, signingWallet);

        ctx.reply('🕙 Rescuing tokens, _please wait_...',{parse_mode: 'Markdown'});

        const baseHighGas = await getCurrentHighGas();
        const tx = await contract.rescueTokens({ 
            maxPriorityFeePerGas: ethers.utils.parseUnits(gasDetails.maxPriorityFeePerGas.toString(),'gwei'),
            maxFeePerGas: ethers.utils.parseUnits(baseHighGas.toString(), 'gwei')
        });
        const receipt = await tx.wait();

        console.log('ending rescue tokens');

        // Prepare the updated message and keyboard
        const updatedMessage = `Managing contract *$${contractData.symbol}* at:\n \`${contractData.address}\`\n\nDeployer:\n \`${contractData.deployer}\``;
        const updatedKeyboard = getPostDeploymentKeyboard(contractAddress, contractCount);

        await ctx.reply(`✅ Tokens has been rescued.\nTransaction Hash: \`${receipt.transactionHash}\``,{parse_mode: 'Markdown'});

        await ctx.reply(updatedMessage, {
            reply_markup: updatedKeyboard,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        // Log the error and inform the user
        console.error('Error in rescue tokens:', error);
        await ctx.reply(`❌ Failed to rescue tokens: ${error.reason}`);
    }
});

bot.action('back_to_deployed_contracts', async(ctx) => {
    await displayDeployedContracts(ctx,true); // Call the function to display deployed contracts
});

bot.action('back_to_menu', async (ctx) => {
    if (userExistsInUserFolder(ctx.from.id)) {
        // User exists, show the menu
        const contractCountPath = `./user/${ctx.from.id}/contractCount.json`;
        const contractCount = await JSON.parse(fs.readFileSync(contractCountPath, 'utf8'));
        const messageText = `Ready to deploy a contract today?\n\n*Deployment*\nContracts Deployed: *${contractCount.count}*`;
        const menu = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🚀 Deploy', callback_data: 'deploy_button' },
                        { text: '⛽️ Gas Config', callback_data: 'gasconfig_button' }
                    ],
                    [
                        { text: '👛 Wallet', callback_data: 'wallet_button' },
                        { text: '❓ Help', callback_data: 'help_button' }
                    ]
                ]
            },
            parse_mode: 'Markdown'
        };
        await ctx.editMessageText(messageText, menu);
    } else {
        // User does not exist, prompt to use /start
        await ctx.replyWithMarkdown('It looks like you do not have a profile yet. Please use the /start command to create your profile.');
    }
});

bot.launch();
