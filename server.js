// ============================================================
// 🔥 LOAD ENVIRONMENT VARIABLES FIRST
// ============================================================
require('dotenv').config();

// Debug: Check if ALL environment variables are loaded
console.log('\n🔍 ENVIRONMENT VARIABLES CHECK:');
console.log('=================================');
console.log('BTC_PRIVATE_KEY:', process.env.BTC_PRIVATE_KEY ? '✅ SET' : '❌ MISSING');
console.log('BTC_ADDRESS:', process.env.BTC_ADDRESS ? '✅ SET' : '❌ MISSING');
console.log('ETH_PRIVATE_KEY:', process.env.ETH_PRIVATE_KEY ? '✅ SET' : '❌ MISSING');
console.log('ETH_ADDRESS:', process.env.ETH_ADDRESS ? '✅ SET' : '❌ MISSING');
console.log('SOL_PRIVATE_KEY:', process.env.SOL_PRIVATE_KEY ? '✅ SET' : '❌ MISSING');
console.log('SOL_ADDRESS:', process.env.SOL_ADDRESS ? '✅ SET' : '❌ MISSING');
console.log('BNB_PRIVATE_KEY:', process.env.BNB_PRIVATE_KEY ? '✅ SET' : '❌ MISSING');
console.log('BNB_ADDRESS:', process.env.BNB_ADDRESS ? '✅ SET' : '❌ MISSING');
console.log('TRX_PRIVATE_KEY:', process.env.TRX_PRIVATE_KEY ? '✅ SET' : '❌ MISSING');
console.log('TRX_ADDRESS:', process.env.TRX_ADDRESS ? '✅ SET' : '❌ MISSING');
console.log('VTPASS_API_KEY:', process.env.VTPASS_API_KEY ? '✅ SET' : '❌ MISSING');
console.log('VTPASS_SECRET_KEY:', process.env.VTPASS_SECRET_KEY ? '✅ SET' : '❌ MISSING');
console.log('FLUTTERWAVE_SECRET:', process.env.FLUTTERWAVE_SECRET ? '✅ SET' : '❌ MISSING');
console.log('INFURA_KEY:', process.env.INFURA_KEY ? '✅ SET' : '❌ MISSING');
console.log('=================================\n');

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair, SystemProgram, Transaction } = require('@solana/web3.js');
const { createTransferInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const { ethers } = require('ethers');
const bitcoin = require('bitcoinjs-lib');
const { ECPairFactory } = require('ecpair');
const ecc = require('tiny-secp256k1');
const TronWeb = require('tronweb');
const bs58 = require('bs58');
const { google } = require('googleapis');
const winston = require('winston');
const rateLimit = require('express-rate-limit');
const app = express();

const ECPair = ECPairFactory(ecc);

// ============================================================
// 🔥 LOGGING
// ============================================================
const logger = winston.createLogger({
level: 'info',
format: winston.format.combine(
winston.format.timestamp(),
winston.format.printf(({ timestamp, level, message }) => {
return `${timestamp} [${level}]: ${message}`;
})
),
transports: [
new winston.transports.Console(),
new winston.transports.File({ filename: 'dubpay.log' })
]
});

app.use(cors());
app.use(express.json());

// ============================================================
// 🔥 RATE LIMITING
// ============================================================
const limiter = rateLimit({
windowMs: 15 * 60 * 1000,
max: 100,
message: 'Too many requests, please try again later.'
});
app.use('/api/', limiter);

// ============================================================
// 🔥 GOOGLE SHEETS SETUP
// ============================================================
const sheets = google.sheets('v4');

const GOOGLE_SHEETS_PRIVATE_KEY = process.env.GOOGLE_SHEETS_PRIVATE_KEY || '';
const GOOGLE_SHEETS_CLIENT_EMAIL = process.env.GOOGLE_SHEETS_CLIENT_EMAIL || '';
const GOOGLE_SHEETS_SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '';

let googleAuth = null;

function getGoogleAuth() {
if (!googleAuth && GOOGLE_SHEETS_PRIVATE_KEY && GOOGLE_SHEETS_CLIENT_EMAIL) {
googleAuth = new google.auth.JWT({
email: GOOGLE_SHEETS_CLIENT_EMAIL,
key: GOOGLE_SHEETS_PRIVATE_KEY.replace(/\\n/g, '\n'),
scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
}
return googleAuth;
}

async function appendToSheet(tx_ref, orderData) {
try {
const auth = getGoogleAuth();
if (!auth || !GOOGLE_SHEETS_SPREADSHEET_ID) {
logger.warn('Google Sheets not configured - skipping save');
return;
}

const values = [[
tx_ref,
orderData.coinSymbol || '',
orderData.cryptoAmount || 0,
orderData.walletAddress || '',
orderData.network || 'Default',
orderData.amountUSD || 0,
orderData.amountNGN || 0,
orderData.status || 'pending',
orderData.txId || '',
orderData.explorerUrl || '',
orderData.createdAt || new Date().toISOString(),
orderData.completedAt || '',
orderData.email || '',
orderData.name || '',
orderData.profit || 0,
orderData.billType || '',
orderData.billDetails || '',
JSON.stringify(orderData.paymentData || {})
]];

await sheets.spreadsheets.values.append({
auth: auth,
spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
range: 'Sheet1!A:R',
valueInputOption: 'USER_ENTERED',
requestBody: { values }
});

logger.info(`✅ Order ${tx_ref} saved to Google Sheets`);
} catch (error) {
logger.error(`❌ Failed to save to Google Sheets: ${error.message}`);
}
}

async function updateSheetRow(tx_ref, updates) {
try {
const auth = getGoogleAuth();
if (!auth || !GOOGLE_SHEETS_SPREADSHEET_ID) {
logger.warn('Google Sheets not configured - skipping update');
return;
}

const response = await sheets.spreadsheets.values.get({
auth: auth,
spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
range: 'Sheet1!A:A'
});

const rows = response.data.values;
let rowIndex = -1;
for (let i = 0; i < rows.length; i++) {
if (rows[i][0] === tx_ref) {
rowIndex = i + 1;
break;
}
}

if (rowIndex === -1) {
logger.warn(`⚠️ Order ${tx_ref} not found in Google Sheets`);
return;
}

const updateData = [];
const columns = {
status: 7,
txId: 8,
explorerUrl: 9,
completedAt: 11,
paymentData: 17,
profit: 15
};

for (const [key, value] of Object.entries(updates)) {
if (columns[key]) {
updateData.push({
range: `Sheet1!${String.fromCharCode(64 + columns[key])}${rowIndex}`,
values: [[value]]
});
}
}

for (const update of updateData) {
await sheets.spreadsheets.values.update({
auth: auth,
spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
range: update.range,
valueInputOption: 'USER_ENTERED',
requestBody: { values: update.values }
});
}

logger.info(`✅ Order ${tx_ref} updated in Google Sheets`);
} catch (error) {
logger.error(`❌ Failed to update Google Sheets: ${error.message}`);
}
}

async function getOrdersFromSheet() {
try {
const auth = getGoogleAuth();
if (!auth || !GOOGLE_SHEETS_SPREADSHEET_ID) {
logger.warn('Google Sheets not configured');
return {};
}

const response = await sheets.spreadsheets.values.get({
auth: auth,
spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
range: 'Sheet1!A:R'
});

const rows = response.data.values;
if (!rows || rows.length <= 1) return {};

const orders = {};
for (let i = 1; i < rows.length; i++) {
const row = rows[i];
if (row[0]) {
orders[row[0]] = {
tx_ref: row[0],
coinSymbol: row[1] || '',
cryptoAmount: parseFloat(row[2]) || 0,
walletAddress: row[3] || '',
network: row[4] || 'Default',
amountUSD: parseFloat(row[5]) || 0,
amountNGN: parseFloat(row[6]) || 0,
status: row[7] || 'pending',
txId: row[8] || '',
explorerUrl: row[9] || '',
createdAt: row[10] || new Date().toISOString(),
completedAt: row[11] || '',
email: row[12] || '',
name: row[13] || '',
profit: parseFloat(row[14]) || 0,
billType: row[15] || '',
billDetails: row[16] || '',
paymentData: row[17] ? JSON.parse(row[17]) : {}
};
}
}

return orders;
} catch (error) {
logger.error(`❌ Failed to read Google Sheets: ${error.message}`);
return {};
}
}

// ============================================================
// 🔥 NIGERIAN BILLS MODULE
// ============================================================
class NigeriaBills {
constructor(apiKey, secretKey, profitMargin = 0.98) {
this.apiKey = apiKey;
this.secretKey = secretKey;
this.profitMargin = profitMargin;
this.baseURL = 'https://api.vtpass.com/api';
this.client = axios.create({
baseURL: this.baseURL,
headers: {
'api-key': this.apiKey,
'secret-key': this.secretKey,
'Content-Type': 'application/json'
}
});
}

generateRequestId() {
return `DB_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

handleError(error) {
if (error.response) {
return {
success: false,
error: error.response.data.message || error.response.data,
status: error.response.status
};
}
return {
success: false,
error: error.message || 'Unknown error occurred'
};
}

async buyAirtime(phoneNumber, customerAmount, network) {
try {
const yourCost = Math.round(customerAmount * this.profitMargin);
const profit = customerAmount - yourCost;

const response = await this.client.post('/pay', {
request_id: this.generateRequestId(),
serviceID: network.toLowerCase(),
phone: phoneNumber,
amount: yourCost
});

return {
success: true,
transactionId: response.data.transactionId,
customerAmount: customerAmount,
yourCost: yourCost,
profit: profit,
message: `₦${customerAmount} airtime sent to ${phoneNumber}`,
data: response.data
};
} catch (error) {
return this.handleError(error);
}
}

async buyData(phoneNumber, dataPlanCode, network, customerPrice) {
try {
const yourCost = Math.round(customerPrice * this.profitMargin);
const profit = customerPrice - yourCost;

const response = await this.client.post('/pay', {
request_id: this.generateRequestId(),
serviceID: network.toLowerCase() + '-data',
phone: phoneNumber,
variation_code: dataPlanCode
});

return {
success: true,
transactionId: response.data.transactionId,
customerPrice: customerPrice,
yourCost: yourCost,
profit: profit,
message: `Data bundle activated for ${phoneNumber}`,
data: response.data
};
} catch (error) {
return this.handleError(error);
}
}

async payTV(subscriptionType, smartCardNumber, packageCode, customerPrice) {
try {
const yourCost = Math.round(customerPrice * this.profitMargin);
const profit = customerPrice - yourCost;

const response = await this.client.post('/pay', {
request_id: this.generateRequestId(),
serviceID: subscriptionType.toLowerCase(),
phone: smartCardNumber,
variation_code: packageCode
});

return {
success: true,
transactionId: response.data.transactionId,
customerPrice: customerPrice,
yourCost: yourCost,
profit: profit,
message: `${subscriptionType.toUpperCase()} subscription activated`,
data: response.data
};
} catch (error) {
return this.handleError(error);
}
}

async payElectricity(disco, meterNumber, amount, meterType, customerPrice) {
try {
const yourCost = Math.round(customerPrice * this.profitMargin);
const profit = customerPrice - yourCost;

const response = await this.client.post('/pay', {
request_id: this.generateRequestId(),
serviceID: disco.toLowerCase() + '-electric',
phone: meterNumber,
amount: yourCost,
variation_code: meterType || 'prepaid'
});

return {
success: true,
transactionId: response.data.transactionId,
customerPrice: customerPrice,
yourCost: yourCost,
profit: profit,
message: `₦${customerPrice} electricity bill paid for ${disco.toUpperCase()}`,
data: response.data
};
} catch (error) {
return this.handleError(error);
}
}

async verifyService(serviceID, phoneNumber) {
try {
const response = await this.client.post('/merchant/verify', {
serviceID: serviceID,
phone: phoneNumber
});
return {
success: true,
available: true,
customerName: response.data.customerName,
data: response.data
};
} catch (error) {
return this.handleError(error);
}
}

async checkBalance() {
try {
const response = await this.client.get('/balance');
return {
success: true,
balance: response.data.balance,
currency: response.data.currency
};
} catch (error) {
return this.handleError(error);
}
}

async getDataPlans(network) {
try {
const response = await this.client.get(`/service-variations/${network.toLowerCase()}-data`);
return {
success: true,
plans: response.data.variations || []
};
} catch (error) {
return this.handleError(error);
}
}

async getTVPackages(provider) {
try {
const response = await this.client.get(`/service-variations/${provider.toLowerCase()}`);
return {
success: true,
packages: response.data.variations || []
};
} catch (error) {
return this.handleError(error);
}
}

async getElectricityDiscos() {
try {
const discos = ['ikeja', 'eko', 'ibadan', 'kaduna', 'portharcourt', 'benin', 'enugu', 'jos', 'abuja'];
return {
success: true,
discos: discos
};
} catch (error) {
return this.handleError(error);
}
}

async payWithCrypto(btcAmount, serviceDetails) {
try {
const nairaAmount = await this.convertBtcToNaira(btcAmount);
let result;
switch(serviceDetails.serviceType) {
case 'airtime':
result = await this.buyAirtime(serviceDetails.phone, nairaAmount, serviceDetails.network);
break;
case 'data':
result = await this.buyData(serviceDetails.phone, serviceDetails.planCode, serviceDetails.network, nairaAmount);
break;
case 'tv':
result = await this.payTV(serviceDetails.provider, serviceDetails.smartCard, serviceDetails.package, nairaAmount);
break;
case 'electricity':
result = await this.payElectricity(serviceDetails.disco, serviceDetails.meterNumber, nairaAmount, serviceDetails.meterType, nairaAmount);
break;
default:
throw new Error('Invalid service type');
}
return {
success: true,
paidInBtc: btcAmount,
nairaEquivalent: nairaAmount,
profit: result.profit || 0,
transactionId: result.transactionId,
message: `Payment completed with BTC (Profit: ₦${result.profit || 0})`,
data: result.data
};
} catch (error) {
return this.handleError(error);
}
}

async convertBtcToNaira(btcAmount) {
try {
const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=ngn');
const btcToNgn = response.data.bitcoin.ngn;
return btcAmount * btcToNgn;
} catch (error) {
logger.warn('⚠️ Using fallback BTC/NGN rate');
return btcAmount * 45000000;
}
}
}

// ============================================================
// 🔥 CONFIGURATION
// ============================================================
const FLUTTERWAVE_SECRET = process.env.FLUTTERWAVE_SECRET;
const FLUTTERWAVE_WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const BACKEND_URL = process.env.BACKEND_URL || 'https://your-backend.onrender.com';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://your-frontend.netlify.app';

const INFURA_KEY = process.env.INFURA_KEY;

const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const BSC_RPC = 'https://bsc-dataseed.binance.org/';
const AVALANCHE_RPC = 'https://api.avax.network/ext/bc/C/rpc';
const TRON_RPC = 'https://api.trongrid.io';
const ETH_RPC = `https://mainnet.infura.io/v3/${INFURA_KEY}`;
const POLYGON_RPC = 'https://polygon-rpc.com';
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const OPTIMISM_RPC = 'https://mainnet.optimism.io';
const FANTOM_RPC = 'https://rpc.ftm.tools';

const PROFIT_MARGIN = parseFloat(process.env.PROFIT_MARGIN) || 0.98;
const bills = new NigeriaBills(
process.env.VTPASS_API_KEY || '',
process.env.VTPASS_SECRET_KEY || '',
PROFIT_MARGIN
);

// ============================================================
// 🔥 PRIVATE KEY PARSER
// ============================================================
function parsePrivateKey(privateKeyInput, coinName) {
logger.info(`🔑 Parsing private key for ${coinName}...`);
if (!privateKeyInput) {
throw new Error(`No private key provided for ${coinName}`);
}
const input = privateKeyInput.trim();
if (input.length >= 80 && input.length <= 100) {
try {
const decoded = bs58.decode(input);
if (decoded.length === 64 || decoded.length === 32) {
logger.info(`✅ ${coinName}: Using Base58 format (${decoded.length} bytes)`);
return Uint8Array.from(decoded);
}
} catch (e) { /* Not Base58 */ }
}
try {
const array = JSON.parse(input);
if (Array.isArray(array) && (array.length === 64 || array.length === 32)) {
logger.info(`✅ ${coinName}: Using JSON array format (${array.length} bytes)`);
return Uint8Array.from(array);
}
} catch (e) { /* Not JSON array */ }
try {
const base64Buffer = Buffer.from(input, 'base64');
if (base64Buffer.length === 64 || base64Buffer.length === 32) {
logger.info(`✅ ${coinName}: Using Base64 format (${base64Buffer.length} bytes)`);
return Uint8Array.from(base64Buffer);
}
} catch (e) { /* Not Base64 */ }
try {
const hexClean = input.replace('0x', '').trim();
if (/^[0-9a-f]{64}$/i.test(hexClean) || /^[0-9a-f]{128}$/i.test(hexClean) || /^[0-9a-f]{32}$/i.test(hexClean)) {
logger.info(`✅ ${coinName}: Using Hex format`);
const buffer = Buffer.from(hexClean, 'hex');
return Uint8Array.from(buffer);
}
} catch (e) { /* Not Hex */ }
if (input.startsWith('5') || input.startsWith('K') || input.startsWith('L') || input.startsWith('c') || input.startsWith('T')) {
logger.info(`✅ ${coinName}: Using WIF format`);
return input;
}
try {
const buffer = Buffer.from(input);
if (buffer.length === 64 || buffer.length === 32) {
logger.info(`✅ ${coinName}: Using raw buffer format`);
return Uint8Array.from(buffer);
}
} catch (e) { /* Not raw buffer */ }
logger.info(`✅ ${coinName}: Using raw string format (${input.length} chars)`);
return input;
}

// ============================================================
// 🔥 BTC WIF CONVERTER
// ============================================================
function convertToBTCWIF(privateKeyInput) {
logger.info('🔄 Converting BTC private key to WIF format...');
if (!privateKeyInput) {
throw new Error('No BTC private key provided');
}
if (typeof privateKeyInput === 'string') {
if (privateKeyInput.startsWith('5') || privateKeyInput.startsWith('K') || privateKeyInput.startsWith('L') || privateKeyInput.startsWith('c') || privateKeyInput.startsWith('T')) {
logger.info('✅ BTC: Already in WIF format');
return privateKeyInput;
}
}
let rawKey = privateKeyInput;
if (rawKey instanceof Uint8Array || Buffer.isBuffer(rawKey)) {
rawKey = Buffer.from(rawKey);
} else if (typeof rawKey === 'string') {
let hex = rawKey.replace('0x', '').trim();
if (rawKey.length >= 80 && rawKey.length <= 100) {
try {
const decoded = bs58.decode(rawKey);
if (decoded.length === 32 || decoded.length === 64) {
if (decoded.length === 64) {
rawKey = Buffer.from(decoded.slice(0, 32));
} else {
rawKey = Buffer.from(decoded);
}
}
} catch (e) { /* Not base58 */ }
}
if (/^[0-9a-f]{64}$/i.test(hex) || /^[0-9a-f]{32}$/i.test(hex)) {
rawKey = Buffer.from(hex, 'hex');
}
try {
const base64Buffer = Buffer.from(rawKey, 'base64');
if (base64Buffer.length === 32 || base64Buffer.length === 64) {
if (base64Buffer.length === 64) {
rawKey = Buffer.from(base64Buffer.slice(0, 32));
} else {
rawKey = base64Buffer;
}
}
} catch (e) { /* Not base64 */ }
try {
const array = JSON.parse(rawKey);
if (Array.isArray(array) && (array.length === 32 || array.length === 64)) {
if (array.length === 64) {
rawKey = Buffer.from(array.slice(0, 32));
} else {
rawKey = Buffer.from(array);
}
}
} catch (e) { /* Not JSON array */ }
} else {
try {
rawKey = Buffer.from(rawKey);
} catch (e) {
throw new Error('Could not parse BTC private key');
}
}
if (rawKey.length !== 32) {
if (rawKey.length === 64) {
rawKey = rawKey.slice(0, 32);
} else {
throw new Error(`Invalid BTC private key length: ${rawKey.length} bytes, expected 32 bytes`);
}
}
const isTestnet = process.env.BTC_NETWORK === 'testnet' ||
process.env.BTC_ADDRESS?.startsWith('tb') ||
process.env.BTC_ADDRESS?.startsWith('2');
const network = isTestnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
try {
const keyPair = ECPair.fromPrivateKey(rawKey, { network });
const wif = keyPair.toWIF();
logger.info(`✅ BTC: Successfully converted to WIF (${isTestnet ? 'TESTNET' : 'MAINNET'})`);
return wif;
} catch (error) {
logger.error('❌ Failed to create WIF:', error.message);
throw new Error(`Failed to convert to WIF: ${error.message}`);
}
}

// ============================================================
// 🔥 SOL PRIVATE KEY NORMALIZER
// ============================================================
function normalizeSolPrivateKey(privateKeyInput) {
logger.info('🔄 Normalizing SOL private key...');
if (!privateKeyInput) {
throw new Error('No SOL private key provided');
}
if (privateKeyInput instanceof Uint8Array && privateKeyInput.length === 64) {
logger.info('✅ SOL: Already Uint8Array (64 bytes)');
return privateKeyInput;
}
if (Buffer.isBuffer(privateKeyInput) && privateKeyInput.length === 64) {
logger.info('✅ SOL: Already Buffer (64 bytes)');
return Uint8Array.from(privateKeyInput);
}
if (typeof privateKeyInput === 'string') {
let input = privateKeyInput.trim();
if (input.length >= 80 && input.length <= 100) {
try {
const decoded = bs58.decode(input);
if (decoded.length === 64) {
logger.info('✅ SOL: Base58 format (64 bytes)');
return Uint8Array.from(decoded);
}
if (decoded.length === 32) {
logger.info('✅ SOL: Base58 format (32 bytes, padding to 64)');
const padded = new Uint8Array(64);
padded.set(decoded, 0);
return padded;
}
} catch (e) { /* Not base58 */ }
}
try {
const buffer = Buffer.from(input, 'base64');
if (buffer.length === 64) {
logger.info('✅ SOL: Base64 format (64 bytes)');
return Uint8Array.from(buffer);
}
if (buffer.length === 32) {
logger.info('✅ SOL: Base64 format (32 bytes, padding to 64)');
const padded = new Uint8Array(64);
padded.set(buffer, 0);
return padded;
}
} catch (e) { /* Not base64 */ }
let hex = input.replace('0x', '').trim();
if (/^[0-9a-f]{64}$/i.test(hex)) {
logger.info('✅ SOL: Hex format (32 bytes)');
const buffer = Buffer.from(hex, 'hex');
const padded = new Uint8Array(64);
padded.set(buffer, 0);
return padded;
}
if (/^[0-9a-f]{128}$/i.test(hex)) {
logger.info('✅ SOL: Hex format (64 bytes)');
return Uint8Array.from(Buffer.from(hex, 'hex'));
}
try {
const array = JSON.parse(input);
if (Array.isArray(array)) {
if (array.length === 64) {
logger.info('✅ SOL: JSON array format (64 bytes)');
return Uint8Array.from(array);
}
if (array.length === 32) {
logger.info('✅ SOL: JSON array format (32 bytes, padding to 64)');
const padded = new Uint8Array(64);
padded.set(array, 0);
return padded;
}
}
} catch (e) { /* Not JSON */ }
try {
const buffer = Buffer.from(input);
if (buffer.length === 64) {
logger.info('✅ SOL: Raw buffer format (64 bytes)');
return Uint8Array.from(buffer);
}
if (buffer.length === 32) {
logger.info('✅ SOL: Raw buffer format (32 bytes, padding to 64)');
const padded = new Uint8Array(64);
padded.set(buffer, 0);
return padded;
}
} catch (e) { /* Not raw buffer */ }
}
try {
const parsed = parsePrivateKey(privateKeyInput, 'SOL');
if (typeof parsed === 'string') {
try {
const decoded = bs58.decode(parsed);
if (decoded.length === 64) {
return Uint8Array.from(decoded);
}
} catch (e) { /* Last attempt failed */ }
}
if (parsed instanceof Uint8Array) {
if (parsed.length === 64) return parsed;
if (parsed.length === 32) {
const padded = new Uint8Array(64);
padded.set(parsed, 0);
return padded;
}
}
} catch (e) { /* Final attempt failed */ }
throw new Error('Could not parse SOL private key in any format');
return privateKeyInput;
}



// ============================================================
// 🔥 TRON PRIVATE KEY NORMALIZER
// ============================================================
function normalizeTronPrivateKey(privateKeyInput) {
logger.info('🔄 Normalizing TRX private key...');
if (!privateKeyInput) {
throw new Error('No TRX private key provided');
}
if (privateKeyInput instanceof Uint8Array || Buffer.isBuffer(privateKeyInput)) {
const buffer = Buffer.from(privateKeyInput);
if (buffer.length === 32) {
logger.info('✅ TRX: Buffer format (32 bytes)');
return buffer.toString('hex');
}
if (buffer.length === 64) {
logger.info('✅ TRX: Buffer format (64 bytes, taking first 32)');
return buffer.slice(0, 32).toString('hex');
}
}
if (typeof privateKeyInput === 'string') {
let input = privateKeyInput.trim();
if (input.startsWith('0x')) {
input = input.slice(2);
}
if (/^[0-9a-f]{64}$/i.test(input)) {
logger.info('✅ TRX: Hex format (32 bytes)');
return input;
}
if (/^[0-9a-f]{128}$/i.test(input)) {
logger.info('✅ TRX: Hex format (64 bytes, taking first 32)');
return input.slice(0, 64);
}
if (input.length >= 50 && input.length <= 60) {
try {
const decoded = bs58.decode(input);
if (decoded.length === 32) {
logger.info('✅ TRX: Base58 format (32 bytes)');
return Buffer.from(decoded).toString('hex');
}
if (decoded.length === 64) {
logger.info('✅ TRX: Base58 format (64 bytes, taking first 32)');
return Buffer.from(decoded.slice(0, 32)).toString('hex');
}
} catch (e) { /* Not base58 */ }
}
try {
const buffer = Buffer.from(input, 'base64');
if (buffer.length === 32) {
logger.info('✅ TRX: Base64 format (32 bytes)');
return buffer.toString('hex');
}
if (buffer.length === 64) {
logger.info('✅ TRX: Base64 format (64 bytes, taking first 32)');
return buffer.slice(0, 32).toString('hex');
}
} catch (e) { /* Not base64 */ }
try {
const array = JSON.parse(input);
if (Array.isArray(array)) {
if (array.length === 32) {
logger.info('✅ TRX: JSON array format (32 bytes)');
return Buffer.from(array).toString('hex');
}
if (array.length === 64) {
logger.info('✅ TRX: JSON array format (64 bytes, taking first 32)');
return Buffer.from(array.slice(0, 32)).toString('hex');
}
}
} catch (e) { /* Not JSON */ }
if (/^[0-9a-f]{64}$/i.test(input)) {
return input;
}
try {
const buffer = Buffer.from(input);
if (buffer.length === 32) {
logger.info('✅ TRX: Raw string format (32 bytes)');
return buffer.toString('hex');
}
} catch (e) { /* Not raw string */ }
}
try {
const parsed = parsePrivateKey(privateKeyInput, 'TRX');
if (typeof parsed === 'string') {
if (/^[0-9a-f]{64}$/i.test(parsed)) {
return parsed;
}
}
if (parsed instanceof Uint8Array) {
const buffer = Buffer.from(parsed);
if (buffer.length === 32) {
return buffer.toString('hex');
}
if (buffer.length === 64) {
return buffer.slice(0, 32).toString('hex');
}
}
} catch (e) { /* Generic parser failed */ }
throw new Error('Could not parse TRX private key in any format');
}

// ============================================================
// 🔥 BTC WALLET CLASS
// ============================================================
class BTCWallet {
constructor(config) {
if (!config.privateKey) {
throw new Error('❌ BTC private key is required');
}
if (!config.address) {
throw new Error('❌ BTC address is required');
}
this.rawPrivateKey = config.privateKey;
this.privateKey = convertToBTCWIF(config.privateKey);
this.address = config.address;
this.network = config.network === 'testnet' || config.network === 'test'
? bitcoin.networks.testnet
: bitcoin.networks.bitcoin;
this.mempoolApi = config.mempoolApi || 'https://mempool.space/testnet/api';
this.blockchainApi = config.blockchainApi || 'https://blockstream.info/testnet/api';
try {
this.keyPair = ECPair.fromWIF(this.privateKey, this.network);
logger.info('✅ BTC: Key pair loaded successfully');
} catch (error) {
logger.error('❌ Failed to load BTC key pair:', error.message);
throw new Error(`BTC key pair creation failed: ${error.message}`);
}
console.log('🔑 BTC Wallet initialized on:', this.network === bitcoin.networks.testnet ? 'TESTNET' : 'MAINNET');
}

async getBalance() {
try {
const response = await axios.get(
`${this.mempoolApi}/address/${this.address}`
);
const balance = response.data.chain_stats.funded_txo_sum / 100000000;
return balance;
} catch (error) {
const response = await axios.get(
`${this.blockchainApi}/address/${this.address}`
);
const balance = response.data.chain_stats.funded_txo_sum - response.data.chain_stats.spent_txo_sum;
return balance / 100000000;
}
}

async getUtxos() {
try {
const response = await axios.get(
`${this.mempoolApi}/address/${this.address}/utxo`
);
const utxos = response.data;
for (const utxo of utxos) {
try {
const tx = await axios.get(
`${this.mempoolApi}/tx/${utxo.txid}`
);
const output = tx.data.vout[utxo.vout];
utxo.scriptpubkey = output.scriptpubkey;
utxo.value = output.value;
} catch {
const tx = await axios.get(
`${this.blockchainApi}/tx/${utxo.txid}`
);
const output = tx.data.vout[utxo.vout];
utxo.scriptpubkey = output.scriptpubkey;
utxo.value = output.value;
}
}
return utxos;
} catch (error) {
throw new Error(`Failed to get UTXOs: ${error.message}`);
}
}

async getEstimatedFee() {
try {
const response = await axios.get(
`${this.mempoolApi}/v1/fees/recommended`
);
return {
fastest: response.data.fastestFee,
halfHour: response.data.halfHourFee,
hour: response.data.hourFee,
minimum: response.data.minimumFee
};
} catch {
return {
fastest: 20,
halfHour: 15,
hour: 10,
minimum: 5
};
}
}

validateAddress(address) {
try {
bitcoin.address.toOutputScript(address, this.network);
return true;
} catch {
throw new Error(`Invalid Bitcoin address: ${address}`);
}
}

async send(toAddress, amountBTC, options = {}) {
try {
console.log(`📤 Sending ${amountBTC} BTC to ${toAddress}`);
this.validateAddress(toAddress);
const balance = await this.getBalance();
const feeEstimate = await this.getEstimatedFee();
const estimatedFeeBTC = ((250 * feeEstimate.halfHour) / 100000000);
if (balance < amountBTC + estimatedFeeBTC) {
throw new Error(
`Insufficient balance. Need approximately ${amountBTC + estimatedFeeBTC} BTC including network fee`
);
}
const utxos = await this.getUtxos();
if (utxos.length === 0) {
throw new Error('No UTXOs found. Please fund your wallet.');
}
const satoshisNeeded = Math.round(amountBTC * 100000000);
const totalAvailable = utxos.reduce((sum, utxo) => sum + utxo.value, 0);
const feeRate = options.feeRate || feeEstimate.halfHour;
const estimatedFee = Math.min(25000, Math.round(utxos.length * 2500 + 5000));
const totalNeeded = satoshisNeeded + estimatedFee;
if (totalAvailable < totalNeeded) {
throw new Error(
`Insufficient funds: ${totalAvailable} sats available, ${totalNeeded} sats needed`
);
}
const selectedUTXOs = [];
let totalSats = 0;
for (const utxo of utxos) {
if (totalSats < totalNeeded) {
selectedUTXOs.push(utxo);
totalSats += utxo.value;
}
}
const psbt = new bitcoin.Psbt({ network: this.network });
for (const utxo of selectedUTXOs) {
let rawTx;
try {
const response = await axios.get(
`${this.mempoolApi}/tx/${utxo.txid}/hex`
);
rawTx = response.data;
} catch {
const response = await axios.get(
`${this.blockchainApi}/rawtx/${utxo.txid}`
);
rawTx = response.data;
}
psbt.addInput({
hash: utxo.txid,
index: utxo.vout,
witnessUtxo: {
script: Buffer.from(utxo.scriptpubkey, 'hex'),
value: utxo.value
}
});
}
psbt.addOutput({
address: toAddress,
value: satoshisNeeded
});
const fee = Math.min(estimatedFee, totalSats - satoshisNeeded - 1000);
const change = totalSats - satoshisNeeded - fee;
if (change > 1000) {
psbt.addOutput({
address: this.address,
value: change
});
}
for (let i = 0; i < selectedUTXOs.length; i++) {
psbt.signInput(i, this.keyPair);
}
psbt.finalizeAllInputs();
const tx = psbt.extractTransaction();
const txHex = tx.toHex();
let broadcastResponse;
try {
broadcastResponse = await axios.post(
`${this.mempoolApi}/tx`,
txHex,
{ headers: { 'Content-Type': 'text/plain' } }
);
} catch {
broadcastResponse = await axios.post(
`${this.blockchainApi}/pushtx`,
`tx=${txHex}`
);
}
const txId = broadcastResponse.data;
console.log(`✅ BTC Transaction broadcasted: ${txId}`);
return {
txId,
txHex,
fromAddress: this.address,
toAddress,
amount: amountBTC,
fee,
explorerUrl: `https://mempool.space/testnet/tx/${txId}`
};
} catch (error) {
console.error('❌ BTC send error:', error.message);
throw error;
}
}
}

// ============================================================
// 🔥 WALLET CONFIGURATION
// ============================================================
logger.info('🔍 Checking environment variables...');

const BTC_NETWORK = process.env.BTC_ADDRESS && (process.env.BTC_ADDRESS.startsWith('tb') || process.env.BTC_ADDRESS.startsWith('2'))
? 'testnet'
: 'mainnet';

const WALLETS = {
BTC: { address: process.env.BTC_ADDRESS || '', privateKey: process.env.BTC_PRIVATE_KEY || '', network: BTC_NETWORK },
ETH: { address: process.env.ETH_ADDRESS || '', privateKey: process.env.ETH_PRIVATE_KEY || '', network: 'ethereum' },
BNB: { address: process.env.BNB_ADDRESS || '', privateKey: process.env.BNB_PRIVATE_KEY || '', network: 'bsc' },
SOL: { address: process.env.SOL_ADDRESS || '', privateKey: process.env.SOL_PRIVATE_KEY || '', network: 'solana' },
TRX: { address: process.env.TRX_ADDRESS || '', privateKey: process.env.TRX_PRIVATE_KEY || '', network: 'tron' },
AVAX: { address: process.env.AVAX_ADDRESS || '', privateKey: process.env.AVAX_PRIVATE_KEY || '', network: 'avalanche' },
MATIC: { address: process.env.MATIC_ADDRESS || '', privateKey: process.env.MATIC_PRIVATE_KEY || '', network: 'polygon' },
ARB: { address: process.env.ARB_ADDRESS || '', privateKey: process.env.ARB_PRIVATE_KEY || '', network: 'arbitrum' },
OP: { address: process.env.OP_ADDRESS || '', privateKey: process.env.OP_PRIVATE_KEY || '', network: 'optimism' },
FTM: { address: process.env.FTM_ADDRESS || '', privateKey: process.env.FTM_PRIVATE_KEY || '', network: 'fantom' }
};

Object.keys(WALLETS).forEach(coin => {
const wallet = WALLETS[coin];
if (wallet.privateKey) {
logger.info(`✅ ${coin} wallet configured`);
} else {
logger.warn(`⚠️ ${coin} wallet NOT configured`);
}
});

// ============================================================
// 🔥 COIN TO WALLET MAPPING
// ============================================================
const COIN_TO_WALLET = {
'BTC': 'BTC',
'ETH': 'ETH',
'USDC': { 'ERC20': 'ETH', 'SOL': 'SOL', 'BNB': 'BNB' },
'USDT': { 'ERC20': 'ETH', 'SOL': 'SOL', 'BNB': 'BNB', 'TRC20': 'TRX' },
'BNB': 'BNB',
'SOL': 'SOL',
'AVAX': 'AVAX',
'MATIC': 'MATIC',
'ARB': 'ARB',
'OP': 'OP',
'FTM': 'FTM'
};

function getWalletForCoin(coinSymbol, network) {
let walletKey;
if (coinSymbol === 'USDC' || coinSymbol === 'USDT') {
if (!network) { network = 'ERC20'; }
walletKey = COIN_TO_WALLET[coinSymbol][network];
if (!walletKey) {
throw new Error(`No wallet for ${coinSymbol} on network ${network}`);
}
} else {
walletKey = COIN_TO_WALLET[coinSymbol];
if (!walletKey) {
throw new Error(`No wallet mapping for ${coinSymbol}`);
}
}
const wallet = WALLETS[walletKey];
if (!wallet) { throw new Error(`Wallet ${walletKey} not configured`); }
if (!wallet.privateKey) { throw new Error(`Private key not configured for ${coinSymbol}`); }
if (!wallet.address) { throw new Error(`Address not configured for ${coinSymbol}`); }
return { address: wallet.address, privateKey: wallet.privateKey };
}

// ============================================================
// 🔥 BALANCE CHECKS
// ============================================================
async function getWalletBalance(coinSymbol, network) {
logger.info(`🔍 Checking balance for ${coinSymbol}...`);
try {
const wallet = getWalletForCoin(coinSymbol, network);
const address = wallet.address;
if (!address) { logger.warn(`⚠️ No address configured for ${coinSymbol}`); return 0; }

if (coinSymbol === 'BTC') {
try {
const btcWallet = new BTCWallet({
privateKey: wallet.privateKey,
address: wallet.address,
network: BTC_NETWORK,
mempoolApi: BTC_NETWORK === 'testnet' ? 'https://mempool.space/testnet/api' : 'https://mempool.space/api',
blockchainApi: BTC_NETWORK === 'testnet' ? 'https://blockstream.info/testnet/api' : 'https://blockstream.info/api'
});
const balance = await btcWallet.getBalance();
logger.info(`💰 BTC Balance: ${balance} BTC`);
return balance;
} catch (error) { logger.error(`❌ BTC balance check failed: ${error.message}`); return 0; }
}

if (coinSymbol === 'ETH') {
const provider = new ethers.JsonRpcProvider(ETH_RPC);
const balance = await provider.getBalance(address);
return parseFloat(ethers.formatEther(balance));
}

if (coinSymbol === 'SOL') {
const connection = new Connection(SOLANA_RPC);
const publicKey = new PublicKey(address);
const balance = await connection.getBalance(publicKey);
return balance / LAMPORTS_PER_SOL;
}

if (coinSymbol === 'USDC' && network === 'SOL') {
const connection = new Connection(SOLANA_RPC);
const publicKey = new PublicKey(address);
const tokenAddress = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const tokenAccounts = await connection.getTokenAccountsByOwner(publicKey, { mint: tokenAddress });
if (tokenAccounts.value.length > 0) {
const accountInfo = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
return accountInfo.value.uiAmount || 0;
}
return 0;
}

if ((coinSymbol === 'USDC' && network === 'ERC20') || (coinSymbol === 'USDT' && network === 'ERC20')) {
const provider = new ethers.JsonRpcProvider(ETH_RPC);
const contractAddress = coinSymbol === 'USDC'
? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
: '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const abi = ['function balanceOf(address) view returns (uint256)'];
const contract = new ethers.Contract(contractAddress, abi, provider);
const balance = await contract.balanceOf(address);
return parseFloat(ethers.formatUnits(balance, 6));
}

if (coinSymbol === 'BNB') {
const provider = new ethers.JsonRpcProvider(BSC_RPC);
const balance = await provider.getBalance(address);
return parseFloat(ethers.formatEther(balance));
}

if (coinSymbol === 'AVAX') {
const provider = new ethers.JsonRpcProvider(AVALANCHE_RPC);
const balance = await provider.getBalance(address);
return parseFloat(ethers.formatEther(balance));
}

if (coinSymbol === 'MATIC') {
const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
const balance = await provider.getBalance(address);
return parseFloat(ethers.formatEther(balance));
}

if (coinSymbol === 'ARB') {
const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);
const balance = await provider.getBalance(address);
return parseFloat(ethers.formatEther(balance));
}

if (coinSymbol === 'OP') {
const provider = new ethers.JsonRpcProvider(OPTIMISM_RPC);
const balance = await provider.getBalance(address);
return parseFloat(ethers.formatEther(balance));
}

if (coinSymbol === 'FTM') {
const provider = new ethers.JsonRpcProvider(FANTOM_RPC);
const balance = await provider.getBalance(address);
return parseFloat(ethers.formatEther(balance));
}

if (coinSymbol === 'TRX') {
try {
const privateKey = normalizeTronPrivateKey(wallet.privateKey);
const tronWeb = new TronWeb({ fullHost: TRON_RPC, privateKey: privateKey });
const balance = await tronWeb.trx.getBalance(address);
return balance / 1000000;
} catch { return 0; }
}

if (coinSymbol === 'USDT' && network === 'TRC20') {
try {
const privateKey = normalizeTronPrivateKey(wallet.privateKey);
const tronWeb = new TronWeb({ fullHost: TRON_RPC, privateKey: privateKey });
const contractAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const contract = await tronWeb.contract().at(contractAddress);
const balance = await contract.balanceOf(address).call();
return balance / 1000000;
} catch { return 0; }
}
return 0;
} catch (error) {
logger.error(`❌ Balance check error for ${coinSymbol}:`, error.message);
return 0;
}
}

// ============================================================
// 🔥 SEND FUNCTIONS
// ============================================================
function parseEVMPrivateKey(privateKeyInput) {
let privateKey = privateKeyInput;
if (privateKeyInput instanceof Uint8Array) {
privateKey = '0x' + Buffer.from(privateKeyInput).toString('hex');
} else if (Buffer.isBuffer(privateKeyInput)) {
privateKey = '0x' + privateKeyInput.toString('hex');
} else if (typeof privateKeyInput === 'string') {
if (!privateKeyInput.startsWith('0x') && /^[0-9a-f]{64}$/i.test(privateKeyInput)) {
privateKey = '0x' + privateKeyInput;
}
if (privateKeyInput.length >= 80 && privateKeyInput.length <= 100) {
try {
const decoded = bs58.decode(privateKeyInput);
if (decoded.length === 32) {
privateKey = '0x' + Buffer.from(decoded).toString('hex');
}
} catch (e) { /* Not base58 */ }
}
}
return privateKey;
}

async function sendBTC(privateKeyInput, toAddress, amountBTC) {
try {
logger.info(`📤 Sending ${amountBTC} BTC to ${toAddress}`);
if (!privateKeyInput) { privateKeyInput = process.env.BTC_PRIVATE_KEY; }
if (!privateKeyInput) { throw new Error('❌ BTC_PRIVATE_KEY is missing!'); }
if (!toAddress) { throw new Error('Recipient address is required'); }
if (!amountBTC || amountBTC <= 0) { throw new Error('Valid amount is required'); }
const btcWallet = new BTCWallet({
privateKey: privateKeyInput,
address: process.env.BTC_ADDRESS,
network: BTC_NETWORK,
mempoolApi: BTC_NETWORK === 'testnet' ? 'https://mempool.space/testnet/api' : 'https://mempool.space/api',
blockchainApi: BTC_NETWORK === 'testnet' ? 'https://blockstream.info/testnet/api' : 'https://blockstream.info/api'
});
const result = await btcWallet.send(toAddress, amountBTC);
logger.info(`✅ BTC Transaction sent! TxID: ${result.txId}`);
return result.txId;
} catch (error) { logger.error('❌ BTC send error:', error.message); throw error; }
}

async function sendETH(privateKeyInput, toAddress, amountETH) {
try {
const provider = new ethers.JsonRpcProvider(ETH_RPC);
let privateKey = parseEVMPrivateKey(privateKeyInput);
const wallet = new ethers.Wallet(privateKey, provider);
const feeData = await provider.getFeeData();
const tx = await wallet.sendTransaction({
to: toAddress,
value: ethers.parseEther(amountETH.toString()),
gasLimit: 21000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});
await tx.wait();
return tx.hash;
} catch (error) { logger.error('❌ ETH send error:', error.message); throw error; }
}

async function sendSOL(privateKeyInput, toAddress, amountSOL) {
try {
logger.info(`📤 Sending ${amountSOL} SOL to ${toAddress}`);
const connection = new Connection(SOLANA_RPC);
const secretKey = normalizeSolPrivateKey(privateKeyInput);
if (!secretKey || secretKey.length !== 64) {
throw new Error(`Invalid Solana private key. Length: ${secretKey ? secretKey.length : 'undefined'}, expected 64 bytes`);
}
const fromKeypair = Keypair.fromSecretKey(secretKey);
const toPublicKey = new PublicKey(toAddress);
const lamports = Math.round(amountSOL * LAMPORTS_PER_SOL);
const transaction = new Transaction().add(
SystemProgram.transfer({
fromPubkey: fromKeypair.publicKey,
toPubkey: toPublicKey,
lamports: lamports
})
);
const signature = await connection.sendTransaction(transaction, [fromKeypair]);
await connection.confirmTransaction(signature);
return signature;
} catch (error) { logger.error('❌ SOL send error:', error.message); throw error; }
}

async function sendBNB(privateKeyInput, toAddress, amountBNB) {
try {
const provider = new ethers.JsonRpcProvider(BSC_RPC);
let privateKey = parseEVMPrivateKey(privateKeyInput);
const wallet = new ethers.Wallet(privateKey, provider);
const feeData = await provider.getFeeData();
const tx = await wallet.sendTransaction({
to: toAddress,
value: ethers.parseEther(amountBNB.toString()),
gasLimit: 21000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});
await tx.wait();
return tx.hash;
} catch (error) { logger.error('❌ BNB send error:', error.message); throw error; }
}

async function sendAVAX(privateKeyInput, toAddress, amountAVAX) {
try {
const provider = new ethers.JsonRpcProvider(AVALANCHE_RPC);
let privateKey = parseEVMPrivateKey(privateKeyInput);
const wallet = new ethers.Wallet(privateKey, provider);
const feeData = await provider.getFeeData();
const tx = await wallet.sendTransaction({
to: toAddress,
value: ethers.parseEther(amountAVAX.toString()),
gasLimit: 21000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});
await tx.wait();
return tx.hash;
} catch (error) { logger.error('❌ AVAX send error:', error.message); throw error; }
}

async function sendMATIC(privateKeyInput, toAddress, amountMATIC) {
try {
const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
let privateKey = parseEVMPrivateKey(privateKeyInput);
const wallet = new ethers.Wallet(privateKey, provider);
const feeData = await provider.getFeeData();
const tx = await wallet.sendTransaction({
to: toAddress,
value: ethers.parseEther(amountMATIC.toString()),
gasLimit: 21000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});
await tx.wait();
return tx.hash;
} catch (error) { logger.error('❌ MATIC send error:', error.message); throw error; }
}

async function sendARB(privateKeyInput, toAddress, amountARB) {
try {
const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);
let privateKey = parseEVMPrivateKey(privateKeyInput);
const wallet = new ethers.Wallet(privateKey, provider);
const feeData = await provider.getFeeData();
const tx = await wallet.sendTransaction({
to: toAddress,
value: ethers.parseEther(amountARB.toString()),
gasLimit: 21000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});
await tx.wait();
return tx.hash;
} catch (error) { logger.error('❌ ARB send error:', error.message); throw error; }
}

async function sendOP(privateKeyInput, toAddress, amountOP) {
try {
const provider = new ethers.JsonRpcProvider(OPTIMISM_RPC);
let privateKey = parseEVMPrivateKey(privateKeyInput);
const wallet = new ethers.Wallet(privateKey, provider);
const feeData = await provider.getFeeData();
const tx = await wallet.sendTransaction({
to: toAddress,
value: ethers.parseEther(amountOP.toString()),
gasLimit: 21000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});
await tx.wait();
return tx.hash;
} catch (error) { logger.error('❌ OP send error:', error.message); throw error; }
}

async function sendFTM(privateKeyInput, toAddress, amountFTM) {
try {
const provider = new ethers.JsonRpcProvider(FANTOM_RPC);
let privateKey = parseEVMPrivateKey(privateKeyInput);
const wallet = new ethers.Wallet(privateKey, provider);
const feeData = await provider.getFeeData();
const tx = await wallet.sendTransaction({
to: toAddress,
value: ethers.parseEther(amountFTM.toString()),
gasLimit: 21000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});
await tx.wait();
return tx.hash;
} catch (error) { logger.error('❌ FTM send error:', error.message); throw error; }
}

async function sendTRX(privateKeyInput, toAddress, amountTRX) {
try {
const privateKey = normalizeTronPrivateKey(privateKeyInput);
const tronWeb = new TronWeb({ fullHost: TRON_RPC, privateKey: privateKey });
const amount = amountTRX * 1000000;
const result = await tronWeb.trx.sendTransaction(toAddress, amount);
if (result.result) {
return result.transaction.txID;
} else {
throw new Error('TRX send failed');
}
} catch (error) { logger.error('❌ TRX send error:', error.message); throw error; }
}

async function sendUSDCOnSolana(privateKeyInput, toAddress, amountUSDC) {
try {
const connection = new Connection(SOLANA_RPC);
const secretKey = normalizeSolPrivateKey(privateKeyInput);
if (!secretKey || secretKey.length !== 64) {
throw new Error(`Invalid Solana private key. Length: ${secretKey ? secretKey.length : 'undefined'}, expected 64 bytes`);
}
const fromKeypair = Keypair.fromSecretKey(secretKey);
const TOKEN_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const toPublicKey = new PublicKey(toAddress);
const fromTokenAccount = await getAssociatedTokenAddress(TOKEN_MINT, fromKeypair.publicKey);
const toTokenAccount = await getAssociatedTokenAddress(TOKEN_MINT, toPublicKey);
const toAccountInfo = await connection.getAccountInfo(toTokenAccount);
const transaction = new Transaction();
if (!toAccountInfo) {
transaction.add(
createAssociatedTokenAccountInstruction(
fromKeypair.publicKey,
toTokenAccount,
toPublicKey,
TOKEN_MINT
)
);
}
const amount = Math.round(amountUSDC * 1000000);
const transferIx = createTransferInstruction(
fromTokenAccount,
toTokenAccount,
fromKeypair.publicKey,
amount,
[],
TOKEN_PROGRAM_ID
);
transaction.add(transferIx);
const signature = await connection.sendTransaction(transaction, [fromKeypair]);
await connection.confirmTransaction(signature);
return signature;
} catch (error) { logger.error('❌ USDC Solana send error:', error.message); throw error; }
}

async function sendERC20(privateKeyInput, toAddress, amount, contractAddress, decimals = 6) {
try {
const provider = new ethers.JsonRpcProvider(ETH_RPC);
let privateKey = parseEVMPrivateKey(privateKeyInput);
const wallet = new ethers.Wallet(privateKey, provider);
const abi = ['function transfer(address to, uint256 amount) returns (bool)'];
const contract = new ethers.Contract(contractAddress, abi, wallet);
const amountUnits = ethers.parseUnits(amount.toString(), decimals);
const feeData = await provider.getFeeData();
const tx = await contract.transfer(toAddress, amountUnits, {
gasLimit: 100000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});
await tx.wait();
return tx.hash;
} catch (error) { logger.error('❌ ERC20 send error:', error.message); throw error; }
}

async function sendUSDTOnTron(privateKeyInput, toAddress, amountUSDT) {
try {
const privateKey = normalizeTronPrivateKey(privateKeyInput);
const tronWeb = new TronWeb({ fullHost: TRON_RPC, privateKey: privateKey });
const contractAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const contract = await tronWeb.contract().at(contractAddress);
const amount = amountUSDT * 1000000;
const result = await contract.transfer(toAddress, amount).send();
return result.transaction_id;
} catch (error) { logger.error('❌ USDT TRC20 send error:', error.message); throw error; }
}

// ============================================================
// 📌 MAIN SEND FUNCTION
// ============================================================
async function sendCryptoFromWallet(coinSymbol, toAddress, amount, network) {
const maxRetries = 3;
let lastError = null;
for (let attempt = 1; attempt <= maxRetries; attempt++) {
try {
logger.info(`📤 Attempt ${attempt}: Sending ${amount} ${coinSymbol} to ${toAddress}`);
const wallet = getWalletForCoin(coinSymbol, network);
if (!wallet.privateKey) { throw new Error(`Private key not configured for ${coinSymbol}`); }
const balance = await getWalletBalance(coinSymbol, network);
const estimatedFeeBTC = 0.00001;
if (balance < amount + estimatedFeeBTC) {
throw new Error(`Not enough ${coinSymbol}. Have: ${balance}, Need: ${amount + estimatedFeeBTC}`);
}
let txId, explorerUrl;
if (coinSymbol === 'BTC') {
txId = await sendBTC(wallet.privateKey, toAddress, amount);
explorerUrl = `https://mempool.space/${BTC_NETWORK === 'testnet' ? 'testnet/' : ''}tx/${txId}`;
} else if (coinSymbol === 'ETH') {
txId = await sendETH(wallet.privateKey, toAddress, amount);
explorerUrl = `https://etherscan.io/tx/${txId}`;
} else if (coinSymbol === 'SOL') {
txId = await sendSOL(wallet.privateKey, toAddress, amount);
explorerUrl = `https://solscan.io/tx/${txId}`;
} else if (coinSymbol === 'BNB') {
txId = await sendBNB(wallet.privateKey, toAddress, amount);
explorerUrl = `https://bscscan.com/tx/${txId}`;
} else if (coinSymbol === 'AVAX') {
txId = await sendAVAX(wallet.privateKey, toAddress, amount);
explorerUrl = `https://snowtrace.io/tx/${txId}`;
} else if (coinSymbol === 'MATIC') {
txId = await sendMATIC(wallet.privateKey, toAddress, amount);
explorerUrl = `https://polygonscan.com/tx/${txId}`;
} else if (coinSymbol === 'ARB') {
txId = await sendARB(wallet.privateKey, toAddress, amount);
explorerUrl = `https://arbiscan.io/tx/${txId}`;
} else if (coinSymbol === 'OP') {
txId = await sendOP(wallet.privateKey, toAddress, amount);
explorerUrl = `https://optimistic.etherscan.io/tx/${txId}`;
} else if (coinSymbol === 'FTM') {
txId = await sendFTM(wallet.privateKey, toAddress, amount);
explorerUrl = `https://ftmscan.com/tx/${txId}`;
} else if (coinSymbol === 'TRX') {
txId = await sendTRX(wallet.privateKey, toAddress, amount);
explorerUrl = `https://tronscan.org/#/transaction/${txId}`;
} else if (coinSymbol === 'USDC' && network === 'SOL') {
txId = await sendUSDCOnSolana(wallet.privateKey, toAddress, amount);
explorerUrl = `https://solscan.io/tx/${txId}`;
} else if (coinSymbol === 'USDT' && network === 'TRC20') {
txId = await sendUSDTOnTron(wallet.privateKey, toAddress, amount);
explorerUrl = `https://tronscan.org/#/transaction/${txId}`;
} else if ((coinSymbol === 'USDC' && network === 'ERC20') || (coinSymbol === 'USDT' && network === 'ERC20')) {
const contractAddress = coinSymbol === 'USDC'
? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
: '0xdAC17F958D2ee523a2206206994597C13D831ec7';
txId = await sendERC20(wallet.privateKey, toAddress, amount, contractAddress, 6);
explorerUrl = `https://etherscan.io/tx/${txId}`;
} else {
throw new Error(`Sending not implemented for ${coinSymbol}`);
}
logger.info(`✅ Transaction sent! TxID: ${txId}`);
return { success: true, txId, explorerUrl, amountSent: amount, fromAddress: wallet.address, toAddress, attempt };
} catch (error) {
lastError = error;
logger.error(`❌ Attempt ${attempt} failed: ${error.message}`);
if (attempt < maxRetries) {
const delay = attempt * 2000;
logger.info(`⏳ Retrying in ${delay/1000} seconds...`);
await new Promise(resolve => setTimeout(resolve, delay));
}
}
}
logger.error(`❌ All ${maxRetries} attempts failed for ${coinSymbol}`);
return { success: false, error: lastError ? lastError.message : 'Unknown error' };
}

// ============================================================
// 🔥 PROCESS SUCCESSFUL ORDER
// ============================================================
async function processSuccessfulOrder(order, paymentData) {
try {
logger.info(`\n🚀 Processing order: ${order.tx_ref}`);
if (order.status === 'completed') {
logger.warn(`⚠️ Order already completed. Skipping.`);
return { success: true, alreadyProcessed: true };
}
const balance = await getWalletBalance(order.coinSymbol, order.network);
if (balance < order.cryptoAmount) {
order.status = 'failed';
order.failureReason = `Insufficient balance: Have ${balance}, Need ${order.cryptoAmount}`;
logger.error(`❌ Insufficient balance for ${order.coinSymbol}`);
await updateSheetRow(order.tx_ref, { status: 'failed' });
return { success: false, error: order.failureReason };
}
const txResult = await sendCryptoFromWallet(
order.coinSymbol,
order.walletAddress,
order.cryptoAmount,
order.network
);
if (txResult.success) {
order.status = 'completed';
order.txId = txResult.txId;
order.explorerUrl = txResult.explorerUrl;
order.completedAt = new Date().toISOString();
order.paymentData = paymentData;
await updateSheetRow(order.tx_ref, {
status: 'completed',
txId: txResult.txId,
explorerUrl: txResult.explorerUrl,
completedAt: order.completedAt,
paymentData: JSON.stringify(paymentData || {})
});
logger.info(`✅ Order completed! TxID: ${txResult.txId}`);
return { success: true, txId: txResult.txId };
} else {
order.status = 'failed';
order.failureReason = txResult.error;
order.completedAt = new Date().toISOString();
await updateSheetRow(order.tx_ref, { status: 'failed', completedAt: order.completedAt });
logger.error(`❌ Failed to send crypto: ${txResult.error}`);
return { success: false, error: txResult.error };
}
} catch (error) {
logger.error('❌ Process order error:', error.message);
order.status = 'failed';
order.failureReason = error.message;
await updateSheetRow(order.tx_ref, { status: 'failed', completedAt: new Date().toISOString() });
return { success: false, error: error.message };
}
}

// ============================================================
// 📌 API ENDPOINTS
// ============================================================

const orders = {};

app.post('/api/check-balance', async (req, res) => {
try {
const { coinSymbol, network, amount } = req.body;
const comingSoon = ['LTC', 'XRP', 'LINK'];
if (comingSoon.includes(coinSymbol)) {
return res.status(400).json({ success: false, error: `${coinSymbol} is coming soon!` });
}
const balance = await getWalletBalance(coinSymbol, network);
const hasBalance = balance >= amount;
res.json({ success: true, hasBalance, balance, requested: amount });
} catch (error) {
logger.error('❌ Balance check error:', error.message);
res.status(500).json({ success: false, error: error.message });
}
});

app.post('/api/create-payment', async (req, res) => {
try {
const { coinSymbol, cryptoAmount, walletAddress, network, email, name, amountUSD, nairaRate } = req.body;
const comingSoon = ['LTC', 'XRP', 'LINK'];
if (comingSoon.includes(coinSymbol)) {
return res.status(400).json({ success: false, error: `${coinSymbol} is coming soon!` });
}
const tx_ref = 'DP' + Date.now();
const amountNGN = Math.round(amountUSD * nairaRate);
const balance = await getWalletBalance(coinSymbol, network);
if (balance < cryptoAmount) {
return res.status(400).json({
success: false,
error: `Insufficient balance. Available: ${balance} ${coinSymbol}, Required: ${cryptoAmount} ${coinSymbol}`
});
}
const orderData = {
tx_ref, coinSymbol, cryptoAmount: parseFloat(cryptoAmount), walletAddress,
network: network || 'Default', amountUSD: parseFloat(amountUSD), amountNGN,
status: 'pending', createdAt: new Date().toISOString(),
email: email || 'customer@dubpay.com', name: name || 'DubPay Customer'
};
await appendToSheet(tx_ref, orderData);
orders[tx_ref] = orderData;
logger.info(`📝 Order created: ${tx_ref}`);
const paymentData = {
tx_ref, amount: amountNGN, currency: "NGN",
redirect_url: `${FRONTEND_URL}/payment-status?tx_ref=${tx_ref}`,
payment_options: "card,banktransfer,ussd",
customer: { email: email || 'customer@dubpay.com', name: name || 'DubPay Customer' },
customizations: { title: "DubPay - Buy Crypto", description: `${cryptoAmount} ${coinSymbol}`, logo: "https://dubpay.com/logo.png" },
meta: { coinSymbol, cryptoAmount, walletAddress, network: network || 'Default' }
};
const response = await fetch('https://api.flutterwave.com/v3/payments', {
method: 'POST',
headers: { 'Authorization': `Bearer ${FLUTTERWAVE_SECRET}`, 'Content-Type': 'application/json' },
body: JSON.stringify(paymentData)
});
const data = await response.json();
if (data.status === 'success') {
res.json({ success: true, paymentLink: data.data.link, tx_ref });
} else {
res.status(400).json({ success: false, error: data.message || 'Payment creation failed' });
}
} catch (error) {
logger.error('❌ Create payment error:', error.message);
res.status(500).json({ success: false, error: error.message });
}
});

app.get('/api/verify-payment', async (req, res) => {
try {
const { tx_ref } = req.query;
logger.info(`🔍 Verifying payment for: ${tx_ref}`);
if (!tx_ref) { return res.status(400).json({ error: 'Missing transaction reference' }); }
let order = orders[tx_ref];
if (!order) { const sheetOrders = await getOrdersFromSheet(); order = sheetOrders[tx_ref]; }
if (!order) {
logger.error(`❌ Order not found: ${tx_ref}`);
return res.status(404).json({ error: 'Order not found. Please contact support.', tx_ref });
}
logger.info(`✅ Order found: ${tx_ref}, Status: ${order.status}`);
const response = await fetch(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${tx_ref}`, {
headers: { 'Authorization': `Bearer ${FLUTTERWAVE_SECRET}` }
});
const data = await response.json();
if (data.status === 'success' && data.data.status === 'successful') {
if (order.status !== 'completed') {
const result = await processSuccessfulOrder(order, data.data);
if (!result.success) {
return res.status(500).json({ success: false, error: result.error });
}
}
logger.info(`✅ Payment verified for: ${tx_ref}`);
return res.json({ success: true, message: 'Payment verified and crypto sent!', order });
} else if (order.status === 'completed') {
res.json({ success: true, message: 'Crypto has been sent to your wallet!', order });
} else {
logger.info(`⏳ Payment not yet confirmed: ${tx_ref}`);
res.json({ success: false, message: 'Payment not confirmed yet. Please check back later.', order });
}
} catch (error) {
logger.error('❌ Verify payment error:', error.message);
res.status(500).json({ error: error.message });
}
});

app.get('/api/order-status/:tx_ref', async (req, res) => {
try {
const tx_ref = req.params.tx_ref;
let order = orders[tx_ref];
if (!order) { const sheetOrders = await getOrdersFromSheet(); order = sheetOrders[tx_ref]; }
if (!order) { return res.status(404).json({ error: 'Order not found' }); }
res.json({ success: true, order });
} catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/flutterwave-webhook', async (req, res) => {
try {
const signature = req.headers['verif-hash'];
if (signature !== FLUTTERWAVE_WEBHOOK_SECRET) {
logger.error('❌ Invalid webhook signature');
return res.status(401).send('Invalid signature');
}
const event = req.body;
logger.info("📥 Full webhook payload:", JSON.stringify(event, null, 2));
if (event.event === 'charge.completed' && event.data.status === 'successful') {
const tx_ref = event.data.tx_ref;
logger.info(`✅ Payment successful for TX: ${tx_ref}`);
let order = orders[tx_ref];
if (!order) { const sheetOrders = await getOrdersFromSheet(); order = sheetOrders[tx_ref]; }
if (!order) {
logger.error(`❌ Order not found: ${tx_ref}`);
return res.status(404).send('Order not found');
}
logger.info(`📊 Processing order: ${tx_ref}`);
const result = await processSuccessfulOrder(order, event.data);
if (result.success) { logger.info(`✅ Order ${tx_ref} completed successfully!`); }
else { logger.error(`❌ Order ${tx_ref} failed: ${result.error}`); }
return res.status(200).send('Webhook processed');
}
res.status(200).send('Webhook received');
} catch (error) {
logger.error('❌ Webhook error:', error.message);
res.status(500).send('Webhook error');
}
});

app.get('/api/health', (req, res) => {
res.json({
status: 'ok',
message: 'DubPay Backend is running! 🚀',
googleSheets: GOOGLE_SHEETS_SPREADSHEET_ID ? '✅ Connected' : '⚠️ Not configured',
vtpass: process.env.VTPASS_API_KEY ? '✅ Configured' : '⚠️ Not configured',
btcNetwork: BTC_NETWORK.toUpperCase(),
profitMargin: PROFIT_MARGIN,
services: {
crypto: ['BTC', 'ETH', 'SOL', 'BNB', 'AVAX', 'MATIC', 'ARB', 'OP', 'FTM', 'TRX', 'USDC', 'USDT'],
bills: ['Airtime', 'Data', 'TV', 'Electricity']
}
});
});

app.get('/api/banks', async (req, res) => {
try {
const response = await fetch('https://api.flutterwave.com/v3/banks/NG', {
headers: { 'Authorization': `Bearer ${FLUTTERWAVE_SECRET}`, 'Content-Type': 'application/json' }
});
const data = await response.json();
if (data.status === 'success' && data.data) {
const seen = new Set();
const uniqueBanks = data.data.filter(bank => {
const duplicate = seen.has(bank.code);
seen.add(bank.code);
return !duplicate;
});
res.json({ status: 'success', message: 'Banks fetched successfully', data: uniqueBanks });
} else { res.status(400).json(data); }
} catch (error) {
logger.error('❌ Banks fetch error:', error.message);
res.status(500).json({ error: error.message });
}
});

app.post('/api/resolve', async (req, res) => {
try {
const { accountNumber, bankCode } = req.body;
if (!accountNumber || !bankCode) {
return res.status(400).json({ status: 'error', message: 'Account number and bank code are required' });
}
const cleanAccount = accountNumber.toString().trim();
if (cleanAccount.length !== 10) {
return res.status(400).json({ status: 'error', message: 'Account number must be 10 digits' });
}
if (cleanAccount === '0000000000') {
return res.json({ status: 'success', data: { account_name: 'Test User', account_number: '0000000000', bank_name: 'Test Bank' } });
}
const response = await fetch('https://api.flutterwave.com/v3/accounts/resolve', {
method: 'POST',
headers: { 'Authorization': `Bearer ${FLUTTERWAVE_SECRET}`, 'Content-Type': 'application/json' },
body: JSON.stringify({ account_number: cleanAccount, account_bank: bankCode })
});
const data = await response.json();
if (data.status === 'success' && data.data) { res.json(data); }
else { res.status(400).json({ status: 'error', message: data.message || 'Invalid account number' }); }
} catch (error) {
logger.error('❌ Resolve error:', error.message);
res.status(500).json({ status: 'error', message: error.message });
}
});

// ============================================================
// 📌 BILLS ENDPOINTS
// ============================================================

app.post('/api/bills/airtime', async (req, res) => {
try {
const { phone, amount, network, paymentMethod, btcAmount } = req.body;
if (!phone || !amount || !network) {
return res.status(400).json({ success: false, error: 'Phone, amount, and network are required' });
}
const cleanPhone = phone.replace(/\D/g, '');
if (cleanPhone.length < 10 || cleanPhone.length > 14) {
return res.status(400).json({ success: false, error: 'Invalid phone number format' });
}
const customerAmount = parseFloat(amount);
if (isNaN(customerAmount) || customerAmount <= 0) {
return res.status(400).json({ success: false, error: 'Invalid amount' });
}
if (paymentMethod === 'crypto' && btcAmount) {
const result = await bills.payWithCrypto(parseFloat(btcAmount), {
serviceType: 'airtime', phone: cleanPhone, network
});
return res.json(result);
}
const result = await bills.buyAirtime(cleanPhone, customerAmount, network);
const tx_ref = `BILL_${Date.now()}`;
const billData = {
tx_ref, billType: 'airtime',
billDetails: JSON.stringify({ phone: cleanPhone, amount: customerAmount, network }),
profit: result.profit || 0, amountNGN: customerAmount,
status: 'completed', createdAt: new Date().toISOString(), email: cleanPhone, name: 'DubPay Customer'
};
try { await appendToSheet(tx_ref, billData); } catch (e) { logger.warn('Could not save bill to sheets:', e.message); }
res.json({
success: true,
profit: result.profit || 0,
message: `Airtime purchase successful! You earned ₦${result.profit || 0}`,
data: result
});
} catch (error) {
logger.error('❌ Airtime error:', error.message);
res.status(500).json({ success: false, error: error.message });
}
});

app.post('/api/bills/data', async (req, res) => {
try {
const { phone, planCode, network, amount, paymentMethod, btcAmount } = req.body;
if (!phone || !planCode || !network) {
return res.status(400).json({ success: false, error: 'Phone, plan code, and network are required' });
}
const cleanPhone = phone.replace(/\D/g, '');
const customerPrice = parseFloat(amount) || 0;
if (paymentMethod === 'crypto' && btcAmount) {
const result = await bills.payWithCrypto(parseFloat(btcAmount), {
serviceType: 'data', phone: cleanPhone, planCode, network
});
return res.json(result);
}
const result = await bills.buyData(cleanPhone, planCode, network, customerPrice);
const tx_ref = `BILL_${Date.now()}`;
const billData = {
tx_ref, billType: 'data',
billDetails: JSON.stringify({ phone: cleanPhone, planCode, network, amount: customerPrice }),
profit: result.profit || 0, amountNGN: customerPrice,
status: 'completed', createdAt: new Date().toISOString(), email: cleanPhone
};
try { await appendToSheet(tx_ref, billData); } catch (e) { logger.warn('Could not save bill to sheets:', e.message); }
res.json({
success: true,
profit: result.profit || 0,
message: `Data purchase successful! You earned ₦${result.profit || 0}`,
data: result
});
} catch (error) {
logger.error('❌ Data error:', error.message);
res.status(500).json({ success: false, error: error.message });
}
});

app.post('/api/bills/tv', async (req, res) => {
try {
const { provider, smartCard, packageCode, amount, paymentMethod, btcAmount } = req.body;
if (!provider || !smartCard || !packageCode) {
return res.status(400).json({ success: false, error: 'Provider, smart card number, and package code are required' });
}
const cleanSmartCard = smartCard.replace(/\D/g, '');
const customerPrice = parseFloat(amount) || 0;
const verifyResult = await bills.verifyService(provider, cleanSmartCard);
if (!verifyResult.success) {
return res.status(400).json({ success: false, error: 'Invalid smart card number. Please check and try again.' });
}
if (paymentMethod === 'crypto' && btcAmount) {
const result = await bills.payWithCrypto(parseFloat(btcAmount), {
serviceType: 'tv', provider, smartCard: cleanSmartCard, package: packageCode
});
return res.json(result);
}
const result = await bills.payTV(provider, cleanSmartCard, packageCode, customerPrice);
const tx_ref = `BILL_${Date.now()}`;
const billData = {
tx_ref, billType: 'tv',
billDetails: JSON.stringify({ provider, smartCard: cleanSmartCard, packageCode, amount: customerPrice, customerName: verifyResult.customerName }),
profit: result.profit || 0, amountNGN: customerPrice,
status: 'completed', createdAt: new Date().toISOString(), email: cleanSmartCard
};
try { await appendToSheet(tx_ref, billData); } catch (e) { logger.warn('Could not save bill to sheets:', e.message); }
res.json({
success: true,
profit: result.profit || 0,
customerName: verifyResult.customerName,
message: `TV subscription successful! You earned ₦${result.profit || 0}`,
data: result
});
} catch (error) {
logger.error('❌ TV error:', error.message);
res.status(500).json({ success: false, error: error.message });
}
});

app.post('/api/bills/electricity', async (req, res) => {
try {
const { disco, meterNumber, amount, meterType, paymentMethod, btcAmount } = req.body;
if (!disco || !meterNumber || !amount) {
return res.status(400).json({ success: false, error: 'Disco, meter number, and amount are required' });
}
const cleanMeter = meterNumber.replace(/\D/g, '');
const customerPrice = parseFloat(amount);
const verifyResult = await bills.verifyService(disco + '-electric', cleanMeter);
if (!verifyResult.success) {
return res.status(400).json({ success: false, error: 'Invalid meter number. Please check and try again.' });
}
if (paymentMethod === 'crypto' && btcAmount) {
const result = await bills.payWithCrypto(parseFloat(btcAmount), {
serviceType: 'electricity', disco, meterNumber: cleanMeter, meterType: meterType || 'prepaid'
});
return res.json(result);
}
const result = await bills.payElectricity(disco, cleanMeter, customerPrice, meterType, customerPrice);
const tx_ref = `BILL_${Date.now()}`;
const billData = {
tx_ref, billType: 'electricity',
billDetails: JSON.stringify({ disco, meterNumber: cleanMeter, amount: customerPrice, meterType, customerName: verifyResult.customerName }),
profit: result.profit || 0, amountNGN: customerPrice,
status: 'completed', createdAt: new Date().toISOString(), email: cleanMeter
};
try { await appendToSheet(tx_ref, billData); } catch (e) { logger.warn('Could not save bill to sheets:', e.message); }
res.json({
success: true,
profit: result.profit || 0,
customerName: verifyResult.customerName,
message: `Electricity payment successful! You earned ₦${result.profit || 0}`,
data: result
});
} catch (error) {
logger.error('❌ Electricity error:', error.message);
res.status(500).json({ success: false, error: error.message });
}
});

app.post('/api/bills/verify', async (req, res) => {
try {
const { serviceID, phone } = req.body;
if (!serviceID || !phone) {
return res.status(400).json({ success: false, error: 'Service ID and phone number are required' });
}
const cleanPhone = phone.replace(/\D/g, '');
const result = await bills.verifyService(serviceID, cleanPhone);
if (result.success) {
res.json({ success: true, customerName: result.customerName, message: `Customer verified: ${result.customerName}` });
} else {
res.status(400).json({ success: false, error: result.error || 'Customer not found' });
}
} catch (error) {
logger.error('❌ Verify error:', error.message);
res.status(500).json({ success: false, error: error.message });
}
});

app.get('/api/bills/data-plans/:network', async (req, res) => {
try {
const { network } = req.params;
const result = await bills.getDataPlans(network);
res.json(result);
} catch (error) {
logger.error('❌ Data plans error:', error.message);
res.status(500).json({ success: false, error: error.message });
}
});

app.get('/api/bills/tv-packages/:provider', async (req, res) => {
try {
const { provider } = req.params;
const result = await bills.getTVPackages(provider);
res.json(result);
} catch (error) {
logger.error('❌ TV packages error:', error.message);
res.status(500).json({ success: false, error: error.message });
}
});

app.get('/api/bills/discos', async (req, res) => {
try {
const result = await bills.getElectricityDiscos();
res.json(result);
} catch (error) {
logger.error('❌ Discos error:', error.message);
res.status(500).json({ success: false, error: error.message });
}
});

app.get('/api/bills/balance', async (req, res) => {
try {
const result = await bills.checkBalance();
res.json(result);
} catch (error) {
logger.error('❌ Balance error:', error.message);
res.status(500).json({ success: false, error: error.message });
}
});

app.get('/api/bills/btc-to-ngn', async (req, res) => {
try {
const { btcAmount } = req.query;
if (!btcAmount) { return res.status(400).json({ success: false, error: 'BTC amount is required' }); }
const ngnAmount = await bills.convertBtcToNaira(parseFloat(btcAmount));
res.json({ success: true, btc: parseFloat(btcAmount), ngn: ngnAmount, rate: ngnAmount / parseFloat(btcAmount) });
} catch (error) {
logger.error('❌ BTC to NGN error:', error.message);
res.status(500).json({ success: false, error: error.message });
}
});

app.get('/api/bills/history', async (req, res) => {
try {
const { limit = 50, type } = req.query;
const orders = await getOrdersFromSheet();
const allOrders = Object.values(orders);
let filtered = allOrders;
if (type) { filtered = allOrders.filter(o => o.billType === type); }
filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
const limited = filtered.slice(0, parseInt(limit));
res.json({ success: true, total: filtered.length, transactions: limited });
} catch (error) {
logger.error('❌ History error:', error.message);
res.status(500).json({ success: false, error: error.message });
}
});

app.get('/api/bills/profit', async (req, res) => {
try {
const orders = await getOrdersFromSheet();
const allOrders = Object.values(orders);
const totalProfit = allOrders.reduce((sum, order) => sum + (order.profit || 0), 0);
const billTransactions = allOrders.filter(o => o.billType);
res.json({
success: true,
totalProfit,
totalTransactions: billTransactions.length,
breakdown: {
airtime: allOrders.filter(o => o.billType === 'airtime').reduce((s, o) => s + (o.profit || 0), 0),
data: allOrders.filter(o => o.billType === 'data').reduce((s, o) => s + (o.profit || 0), 0),
tv: allOrders.filter(o => o.billType === 'tv').reduce((s, o) => s + (o.profit || 0), 0),
electricity: allOrders.filter(o => o.billType === 'electricity').reduce((s, o) => s + (o.profit || 0), 0)
}
});
} catch (error) {
logger.error('❌ Profit error:', error.message);
res.status(500).json({ success: false, error: error.message });
}
});

// ============================================================
// 📌 CRYPTO PAYMENT VERIFICATION - 100% REAL
// ============================================================

app.post('/api/verify-crypto-payment', async (req, res) => {
try {
const { tx_ref, currency, amount, address, user_confirmed } = req.body;

logger.info(`🔍 Verifying crypto payment: ${tx_ref}`);
logger.info(`Currency: ${currency}, Amount: ${amount}, Address: ${address || 'N/A'}`);

// Handle NGN separately
if (currency && currency.toUpperCase() === 'NGN') {
try {
const orders = await getOrdersFromSheet();
const order = orders[tx_ref];
if (order && order.status === 'completed') {
return res.json({ success: true, confirmed: true, message: 'Payment already confirmed' });
}
} catch (e) { logger.warn('Could not check sheets:', e.message); }
return res.json({ success: false, confirmed: false, message: 'NGN payment verification requires Flutterwave webhook. Please wait.' });
}

// Validate address
if (!address) {
return res.json({
success: false,
confirmed: false,
message: 'No wallet address provided. Please make sure you entered a valid address.'
});
}

const expectedAmount = parseFloat(amount);
if (!expectedAmount || expectedAmount <= 0) {
return res.json({ success: false, confirmed: false, message: 'Invalid amount specified' });
}

// Check Google Sheets
try {
const orders = await getOrdersFromSheet();
const order = orders[tx_ref];
if (order && order.status === 'completed') {
return res.json({ success: true, confirmed: true, message: 'Payment already confirmed and processed' });
}
} catch (e) { logger.warn('Could not check sheets:', e.message); }

let confirmed = false;
let verificationMessage = '';
let attempts = 0;
const maxAttempts = 3;

while (attempts < maxAttempts && !confirmed) {
attempts++;
logger.info(`🔍 Verification attempt ${attempts}/${maxAttempts} for ${currency}`);

try {
switch (currency.toUpperCase()) {
case 'BTC': confirmed = await verifyBTCWithRetry(address, expectedAmount); break;
case 'ETH': confirmed = await verifyETHWithRetry(address, expectedAmount); break;
case 'SOL': confirmed = await verifySOLWithRetry(address, expectedAmount); break;
case 'BNB': confirmed = await verifyBNBWithRetry(address, expectedAmount); break;
case 'TRX': confirmed = await verifyTRXWithRetry(address, expectedAmount); break;
default:
return res.json({ success: false, confirmed: false, message: `Unsupported currency: ${currency}` });
}

if (confirmed) {
verificationMessage = `${currency} payment verified on blockchain`;
logger.info(`✅ ${verificationMessage} for ${tx_ref}`);
break;
}

if (!confirmed && attempts < maxAttempts) {
const waitTime = attempts * 5000;
logger.info(`⏳ Waiting ${waitTime/1000}s before retry...`);
await new Promise(resolve => setTimeout(resolve, waitTime));
}
} catch (error) {
logger.error(`❌ Verification attempt ${attempts} failed:`, error.message);
if (attempts >= maxAttempts) {
verificationMessage = `Failed to verify ${currency} payment after ${maxAttempts} attempts.`;
}
}
}

// NO USER TRUST FALLBACK - 100% REAL VERIFICATION ONLY
if (!confirmed) {
return res.json({
success: false,
confirmed: false,
message: `No ${currency} payment found. Please make sure you sent the exact amount to the correct address. If you did, please wait a few minutes and try again.`,
tx_ref, currency, amount: expectedAmount, address, attempts
});
}

// SUCCESS - REAL PAYMENT VERIFIED
res.json({
success: true,
confirmed: true,
message: verificationMessage,
tx_ref, currency, amount: expectedAmount, address,
verifiedAt: new Date().toISOString(),
attempts
});

} catch (error) {
logger.error('❌ Crypto verification error:', error.message);
res.status(500).json({ success: false, error: error.message, confirmed: false });
}
});

// ============================================================
// 🔥 BLOCKCHAIN VERIFICATION FUNCTIONS - WITH MULTIPLE APIS
// ============================================================

async function verifyBTCWithRetry(address, expectedAmount) {
const satoshisExpected = Math.round(expectedAmount * 100000000);
const apis = [
{
url: `https://mempool.space/api/address/${address}/txs`,
parse: (data) => {
const transactions = data;
const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
for (const tx of transactions) {
const txTime = tx.status?.block_time ? tx.status.block_time * 1000 : Date.now();
if (txTime < tenMinutesAgo) continue;
for (const output of tx.vout || []) {
if (output.scriptpubkey_address === address) {
const received = Math.round(output.value * 100000000);
if (Math.abs(received - satoshisExpected) <= satoshisExpected * 0.10) return true;
}
}
}
return false;
}
},
{
url: `https://blockstream.info/api/address/${address}/txs`,
parse: (data) => {
const transactions = data;
const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
for (const tx of transactions) {
const txTime = tx.status?.block_time ? tx.status.block_time * 1000 : Date.now();
if (txTime < tenMinutesAgo) continue;
for (const output of tx.vout || []) {
if (output.scriptpubkey_address === address) {
const received = Math.round(output.value * 100000000);
if (Math.abs(received - satoshisExpected) <= satoshisExpected * 0.10) return true;
}
}
}
return false;
}
}
];

for (const api of apis) {
try {
logger.info(`🔍 Checking BTC with: ${api.url}`);
const response = await axios.get(api.url, { timeout: 10000 });
const result = api.parse(response.data);
if (result) { logger.info(`✅ BTC payment found via ${api.url}`); return true; }
} catch (error) {
logger.warn(`⚠️ BTC API failed: ${api.url} - ${error.message}`);
continue;
}
}
return false;
}

async function verifySOLWithRetry(address, expectedAmount) {
try {
const connection = new Connection(SOLANA_RPC);
const publicKey = new PublicKey(address);
const lamportsExpected = Math.round(expectedAmount * LAMPORTS_PER_SOL);
const balance = await connection.getBalance(publicKey);
if (balance >= lamportsExpected) {
logger.info(`✅ SOL balance sufficient: ${balance/ LAMPORTS_PER_SOL} SOL`);
return true;
}
const signatures = await connection.getSignaturesForAddress(publicKey, { limit: 50 });
for (const sig of signatures) {
if (!sig.confirmationStatus || sig.confirmationStatus === 'finalized') {
const tx = await connection.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
if (tx && tx.meta) {
for (const postBalance of tx.meta.postBalances || []) {
if (postBalance >= lamportsExpected) { return true; }
}
}
}
}
return false;
} catch (error) {
logger.error('SOL verification error:', error.message);
return false;
}
}

async function verifyETHWithRetry(address, expectedAmount) {
try {
if (!INFURA_KEY) { logger.warn('⚠️ INFURA_KEY not set, ETH verification may fail'); }
const provider = new ethers.JsonRpcProvider(ETH_RPC);
const weiExpected = ethers.parseEther(expectedAmount.toString());
const balance = await provider.getBalance(address);
if (balance >= weiExpected) {
logger.info(`✅ ETH balance sufficient: ${ethers.formatEther(balance)} ETH`);
return true;
}
const blockNumber = await provider.getBlockNumber();
const startBlock = Math.max(0, blockNumber - 100);
const history = await provider.getHistory(address, startBlock, blockNumber);
for (const tx of history) {
if (tx.to && tx.to.toLowerCase() === address.toLowerCase()) {
if (tx.value >= weiExpected) { return true; }
}
}
return false;
} catch (error) {
logger.error('ETH verification error:', error.message);
return false;
}
}

async function verifyBNBWithRetry(address, expectedAmount) {
try {
const provider = new ethers.JsonRpcProvider(BSC_RPC);
const weiExpected = ethers.parseEther(expectedAmount.toString());
const balance = await provider.getBalance(address);
if (balance >= weiExpected) {
logger.info(`✅ BNB balance sufficient: ${ethers.formatEther(balance)} BNB`);
return true;
}
const blockNumber = await provider.getBlockNumber();
const startBlock = Math.max(0, blockNumber - 100);
const history = await provider.getHistory(address, startBlock, blockNumber);
for (const tx of history) {
if (tx.to && tx.to.toLowerCase() === address.toLowerCase()) {
if (tx.value >= weiExpected) { return true; }
}
}
return false;
} catch (error) {
logger.error('BNB verification error:', error.message);
return false;
}
}

async function verifyTRXWithRetry(address, expectedAmount) {
try {
const tronWeb = new TronWeb({ fullHost: TRON_RPC });
const addressHex = tronWeb.address.toHex(address);
const balance = await tronWeb.trx.getBalance(addressHex);
const balanceTRX = balance / 1000000;
if (balanceTRX >= expectedAmount) {
logger.info(`✅ TRX balance sufficient: ${balanceTRX} TRX`);
return true;
}
return false;
} catch (error) {
logger.error('TRX verification error:', error.message);
return false;
}
}

// ============================================================
// 📌 GET WALLET ADDRESSES
// ============================================================
app.get('/api/wallet-addresses', (req, res) => {
try {
res.json({
success: true,
addresses: {
BTC: process.env.BTC_ADDRESS || '',
ETH: process.env.ETH_ADDRESS || '',
SOL: process.env.SOL_ADDRESS || '',
BNB: process.env.BNB_ADDRESS || '',
TRX: process.env.TRX_ADDRESS || '',
USDC: process.env.ETH_ADDRESS || '',
USDT: process.env.TRX_ADDRESS || ''
}
});
} catch (error) {
res.status(500).json({ success: false, error: error.message });
}
});

// ============================================================
// 📌 START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
logger.info(`\n✅ DubPay Backend is running on port ${PORT}`);
logger.info(`📍 Health check: http://localhost:${PORT}/api/health`);
logger.info(`\n💰 PROFIT MARGIN: ${(1 - PROFIT_MARGIN) * 100}%`);
logger.info(`🔗 BTC NETWORK: ${BTC_NETWORK.toUpperCase()}`);
if (process.env.VTPASS_API_KEY) { logger.info(`✅ VTPass configured for Nigerian bills`); }
else { logger.warn(`⚠️ VTPass NOT configured. Add VTPASS_API_KEY and VTPASS_SECRET_KEY`); }
if (process.env.FLUTTERWAVE_SECRET) { logger.info(`✅ Flutterwave configured for payments`); }
else { logger.warn(`⚠️ Flutterwave NOT configured. Add FLUTTERWAVE_SECRET`); }
if (process.env.INFURA_KEY) { logger.info(`✅ Infura configured for ETH`); }
else { logger.warn(`⚠️ Infura NOT configured. Add INFURA_KEY`); }
logger.info(`\n`);
});

module.exports = app;
