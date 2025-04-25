# VRF NFT Minting Example (via x402 Payment)

This example demonstrates how a client pays USDC via the `x402` protocol (`exact` scheme) to a custom resource server. This resource server, upon successful payment verification and settlement via a facilitator, then uses its own funds to pay ETH and mint a VRF NFT to the client's address.

Based on the value returned by the VRF result, one of four characters will be selected for the NFT. The NFT and its image can be viewed on [OpenSea](https://testnets.opensea.io/) by connecting to Base Sepolia and searching for the NFT contract address.

## Architecture

This example involves three components running concurrently:

1.  **Facilitator (`example/facilitator.ts`):** A standard x402 facilitator server responsible for verifying payment signatures (`/verify`) and settling USDC payments (`/settle`) by calling `transferWithAuthorization` on the USDC contract.
2.  **VRF Resource Server (`example/vrfnft/vrf-resource-server.ts`):** A custom HTTP server (using Hono) that:
    *   Exposes a `/request-mint` endpoint.
    *   Handles initial requests by responding with `402 Payment Required`, providing the necessary `PaymentDetails` (USDC amount, recipient address, etc.).
    *   Receives subsequent requests containing the `X-PAYMENT` header (sent by the client's interceptor).
    *   Calls the **Facilitator's** `/verify` endpoint to validate the client's payment authorization.
    *   If valid, it extracts the client's address (`from`) from the payment payload.
    *   Uses its *own wallet* (funded with ETH) and `viem` to call `requestNFT(address _recipient)` on the target NFT contract, passing the client's address and the required ETH value.
    *   Calls the **Facilitator's** `/settle` endpoint to trigger the actual USDC transfer from the client to the resource server's wallet.
    *   Responds to the client with the outcome (including minting and settlement transaction hashes).
3.  **Client (`example/vrfnft/vrf-client.ts`):** A script that:
    *   Uses `axios` with the `x402/axios` interceptor.
    *   Makes a request to the **Resource Server's** `/request-mint` endpoint.
    *   The interceptor automatically handles the `402` response, prompts the client's wallet (via `viem`) to sign the EIP-3009 authorization for the USDC payment, constructs the `X-PAYMENT` header, and retries the request.

## Setup

1. **Install Parent Dependencies:**
    ```bash
    npm install
    ```

2. **Build the Project:**
    ```bash
    npm build
    ```

3.  **Navigate to Example Directory:**
    ```bash
    cd example
    ```

4.  **Install Dependencies:**
    ```bash
    npm install
    ```

5.  **Environment Variables (`example/.env`):**
    Create a `.env` file in the `example` directory with the following variables (replace placeholder values, it's okay to use the same wallet for all three values):
    ```dotenv
    # Wallet that pays the USDC (needs USDC and ETH for gas)
    PRIVATE_KEY=0xYOUR_CLIENT_PRIVATE_KEY

    # Wallet that runs the facilitator (needs ETH for gas to settle USDC)
    FACILITATOR_WALLET_PRIVATE_KEY=0xYOUR_FACILITATOR_PRIVATE_KEY

    # Wallet that runs the resource server (needs ETH for gas to mint NFT)
    RESOURCE_WALLET_PRIVATE_KEY=0xYOUR_RESOURCE_SERVER_PRIVATE_KEY

    # HTTP RPC endpoint for the blockchain network (e.g., Base Sepolia)
    # Must be accessible by all components
    PROVIDER_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
    ```

6.  **Verify Constants (`example/vrfnft/vrf-resource-server.ts`):**
    *   Check the hardcoded constant values near the top of the file:
        *   `NFT_CONTRACT_ADDRESS`: Address of your deployed VRF NFT contract.
        *   `USDC_CONTRACT_ADDRESS`: Address of the USDC contract on Base Sepolia (currently set).
        *   `REQUIRED_USDC_PAYMENT`: Amount of USDC (in wei) the client must pay (currently set to `50000` for 0.05 USDC).
        *   `PAYMENT_RECIPIENT_ADDRESS`: The EOA address where the facilitator should settle the USDC payment to (usually the resource server's wallet).
        *   `MINT_ETH_VALUE_STR`: Estimated ETH required by the `requestNFT` function (currently set to `0.01`).
    *   Ensure the `chain` setting (e.g., `baseSepolia`) in `facilitator.ts` and `vrf-resource-server.ts` matches your target network.
    *   Ensure the `nftContractAbi` in `vrf-resource-server.ts` matches your contract's NFT minting function.

## Running the Example

You need three separate terminals, all navigated to the `example` directory.

1.  **Terminal 1: Start Facilitator:**
    ```bash
    npm run facilitator
    ```

2.  **Terminal 2: Start VRF Resource Server:**
    ```bash
    npm run vrfnft:resource
    ```

3.  **Terminal 3: Run VRF Client:**
    ```bash
    npm run vrfnft:client
    ```

## Expected Output

*   **Facilitator Terminal:** Logs for starting, receiving `/verify` and `/settle` requests, and the results.
*   **Resource Server Terminal:** Logs for starting, receiving the client request, calling facilitator `/verify`, calling the NFT contract `requestNFT`, calling facilitator `/settle`, and responding 200 OK to the client.
*   **Client Terminal:** Logs attempting the request, followed by the success response (Status 200) from the resource server, including the NFT mint transaction hash and USDC settlement details.
