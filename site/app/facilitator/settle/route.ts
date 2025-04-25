import { paymentDetailsSchema, PaymentDetails } from "x402/types";
import { settle } from "x402/facilitator";
import { evm } from "x402/shared";
import { Hex } from "viem";

type SettleRequest = {
  payload: string;
  details: PaymentDetails;
};

export async function POST(req: Request) {
  const privateKey = process.env.PRIVATE_KEY as Hex | undefined;
  if (!privateKey) {
    console.error("PRIVATE_KEY environment variable is not set.");
    return new Response(JSON.stringify({ error: "Server configuration error: Missing private key." }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const wallet = evm.wallet.createSignerSepolia(privateKey);

  const body: SettleRequest = await req.json();
  const paymentDetails = paymentDetailsSchema.parse(body.details);
  const response = await settle(wallet, body.payload, paymentDetails);
  return Response.json(response);
}

export async function GET() {
  return Response.json({
    endpoint: "/settle",
    description: "POST to settle x402 payments",
    body: {
      payload: "string",
      details: "PaymentDetails",
    },
  });
}
