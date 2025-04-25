import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import axios from 'axios';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { createWalletClient, http, publicActions, Hex, parseAbiItem, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

// --- Types for Payment Handling ---
type PaymentDetails = {
  scheme: string;
  networkId: string;
  maxAmountRequired: string; // Amount in wei
  resource: string;
  description: string;
  mimeType: string;
  outputSchema?: object | null;
  payToAddress: string;
  requiredDeadlineSeconds: number;
  usdcAddress: string;
  extra: object | null;
};
type ExactEvmPayload = {
  signature: Hex;
  authorization: {
    from: Hex;
    to: Hex;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
    version: string;
  };
};
type XPaymentHeader = {
  x402Version: number;
  scheme: string;
  networkId: string;
  payload: ExactEvmPayload;
  resource: string;
};
// ---------------------------

// --- Load .env ---
const __filename_env = fileURLToPath(import.meta.url);
const __dirname_env = path.dirname(__filename_env);
const envPath = path.resolve(__dirname_env, '../.env');
dotenv.config({ path: envPath });
// ---------------------------

// --- Environment Variable Checks ---
const resourceServerPrivateKey = process.env.RESOURCE_WALLET_PRIVATE_KEY;
const providerUrl = process.env.PROVIDER_URL;

if (!resourceServerPrivateKey || !providerUrl) {
  console.error('Missing RESOURCE_WALLET_PRIVATE_KEY or PROVIDER_URL in .env file');
  process.exit(1);
}
// ----------------------------------------

// --- Constants and Setup ---
const PORT = 4023;
const FACILITATOR_URL = "http://localhost:4020"; // Local facilitator URL
const NFT_CONTRACT_ADDRESS = '0xcD8841f9a8Dbc483386fD80ab6E9FD9656Da39A2' as Hex;
const USDC_CONTRACT_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Hex; // Base Sepolia USDC
const REQUIRED_USDC_PAYMENT = '50000'; // 0.05 USDC (50000 wei, assuming 6 decimals)
const PAYMENT_RECIPIENT_ADDRESS = '0x87002564F1C7b8F51e96CA7D545e43402BF0b4Ab' as Hex; // Resource server wallet
const MINT_ETH_VALUE_STR = '0.01'; // Estimated ETH needed for VRF fee
const NETWORK_ID = baseSepolia.id.toString();
const SCHEME = 'exact';

// --- Viem Client for Resource Server ---
const resourceServerAccount = privateKeyToAccount(resourceServerPrivateKey as Hex);
const resourceServerClient = createWalletClient({
  account: resourceServerAccount,
  chain: baseSepolia,
  transport: http(providerUrl),
}).extend(publicActions);

// --- NFT Contract ABI ---
const nftContractAbi = [
  parseAbiItem('function requestNFT(address _recipient) external payable returns (uint256 requestId)'),
];

// --- Payment Details object sent in 402 responses ---
const paymentDetailsRequired: PaymentDetails = {
  scheme: SCHEME,
  networkId: NETWORK_ID,
  maxAmountRequired: REQUIRED_USDC_PAYMENT,
  resource: `http://localhost:${PORT}/request-mint`,
  description: "Request to mint a VRF NFT",
  mimeType: "application/json",
  payToAddress: PAYMENT_RECIPIENT_ADDRESS,
  requiredDeadlineSeconds: 60,
  usdcAddress: USDC_CONTRACT_ADDRESS,
  outputSchema: null,
  extra: null,
};

// --- Hono App ---
const app = new Hono();
app.use('*', logger());

// --- POST /request-mint Endpoint ---
app.post('/request-mint', async (c) => {
  console.log('INFO ResourceServer: Received POST /request-mint');
  const paymentHeaderBase64 = c.req.header('X-PAYMENT');

  // 1. Check for Payment Header
  if (!paymentHeaderBase64) {
    console.log('INFO ResourceServer: No X-PAYMENT header found. Responding 402.');
    return c.json({ paymentDetails: paymentDetailsRequired, error: 'Payment required' }, 402);
  }

  // 2. Decode Payment Header
  let paymentHeader: XPaymentHeader;
  try {
    const paymentHeaderJson = Buffer.from(paymentHeaderBase64, 'base64').toString('utf-8');
    paymentHeader = JSON.parse(paymentHeaderJson);
    // Basic validation
    if (paymentHeader.scheme !== SCHEME || paymentHeader.networkId !== NETWORK_ID || !paymentHeader.payload?.authorization?.from) {
      throw new Error('Invalid or incomplete payment header content.');
    }
  } catch (err: any) {
    console.error('ERROR ResourceServer: Error decoding/parsing X-PAYMENT header:', err);
    return c.json({ error: 'Invalid payment header format.', details: err.message }, 400);
  }

  // 3. Verify Payment with Facilitator
  try {
    console.log(`INFO ResourceServer: Verifying payment with Facilitator at ${FACILITATOR_URL}...`);
    const verifyResponse = await axios.post(`${FACILITATOR_URL}/verify`, {
      payload: paymentHeaderBase64,
      details: paymentDetailsRequired
    });
    const verificationResult: { isValid: boolean; invalidReason: string | null } = verifyResponse.data;
    console.log('INFO ResourceServer: Facilitator /verify response:', verificationResult);
    if (!verificationResult?.isValid) {
      console.log('INFO ResourceServer: Payment verification failed. Responding 402.');
      return c.json({ paymentDetails: paymentDetailsRequired, error: 'Payment verification failed.', details: verificationResult?.invalidReason || 'Unknown' }, 402);
    }
  } catch (err: any) {
    console.error('ERROR ResourceServer: Error calling facilitator /verify:', err.response?.data || err.message);
    return c.json({ error: 'Facilitator verification call failed.' }, 500);
  }

  // 4. Mint NFT (Verification Passed)
  const recipientAddress = paymentHeader.payload.authorization.from;
  let mintTxHash: Hex | null = null;
  try {
    console.log(`INFO ResourceServer: Initiating NFT mint for ${recipientAddress} on contract ${NFT_CONTRACT_ADDRESS}...`);
    mintTxHash = await resourceServerClient.writeContract({
      address: NFT_CONTRACT_ADDRESS,
      abi: nftContractAbi,
      functionName: 'requestNFT',
      args: [recipientAddress],
      value: parseEther(MINT_ETH_VALUE_STR) // Include estimated ETH value
    });
    console.log(`INFO ResourceServer: NFT Mint transaction sent: ${mintTxHash}`);
  } catch (err: any) {
    console.error('ERROR ResourceServer: Error sending NFT mint transaction:', err);
    return c.json({ error: 'Failed to initiate NFT minting.', details: err.message }, 500);
  }

  // 5. Settle Payment with Facilitator
  let settlementResult: { success: boolean; error: string | null; txHash: Hex | null } = { success: false, error: 'Settlement not attempted', txHash: null };
  try {
    console.log(`INFO ResourceServer: Settling payment with Facilitator at ${FACILITATOR_URL}...`);
    const settleResponse = await axios.post(`${FACILITATOR_URL}/settle`, {
      payload: paymentHeaderBase64,
      details: paymentDetailsRequired
    });
    settlementResult = settleResponse.data;
    console.log('INFO ResourceServer: Facilitator /settle response:', settlementResult);
    if (!settlementResult?.success) {
      console.error('WARN ResourceServer: Facilitator settlement failed:', settlementResult?.error);
    }
  } catch (err: any) {
    // Log settlement error but don't necessarily fail the request for the client
    console.error('ERROR ResourceServer: Error calling facilitator /settle:', err.response?.data || err.message);
  }

  // 6. Respond to Client
  console.log('INFO ResourceServer: Responding 200 OK to client.');
  return c.json({
    message: "NFT mint request initiated successfully.",
    nftMintTxHash: mintTxHash,
  });
});

// --- Fallback Handler ---
// Catches any requests not matching defined routes
app.all('*', (c) => {
  console.log(`INFO ResourceServer: Received ${c.req.method} on unhandled path ${c.req.url}. Responding 404.`);
  return c.json({ error: 'Not Found' }, 404);
});

// --- Start Server ---
console.log(`VRF NFT Resource Server running on port ${PORT}`);
console.log(` - Resource Server Wallet: ${resourceServerAccount.address}`);
console.log(` - NFT Contract: ${NFT_CONTRACT_ADDRESS}`);
console.log(` - Payment Required: ${REQUIRED_USDC_PAYMENT} wei USDC (${USDC_CONTRACT_ADDRESS}) to ${PAYMENT_RECIPIENT_ADDRESS}`);
console.log(` - Facilitator URL: ${FACILITATOR_URL}`);

serve({
  port: PORT,
  fetch: app.fetch,
}); 