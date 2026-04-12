/**
 * Kai-AI Payment Verifier
 * Verifies x402 payment headers and records payments to the ledger.
 * Uses Coinbase's x402 facilitator on Base Mainnet.
 */
import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { getAgentWalletAddress } from "../agent/wallet.ts";

export const FACILITATOR_URL = "https://facilitator.x402.org";
export const BASE_MAINNET_CAIP2 = "eip155:8453";

/** USDC on Base Mainnet (6 decimals). */
export const USDC_BASE_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/**
 * $KAI on Base Mainnet — alternate x402 asset.
 * Ratio: 1 USDC = 100,000 KAI (human units); smallest-unit math uses {@link kaiMaxAmountRequiredFromUsd}.
 */
export const KAI_TOKEN_BASE_MAINNET = "0x86aF9cB35a613992Ea552E0bA7419F1dAdA3084C";

/** Human KAI tokens per 1 USDC (not wei). */
export const KAI_HUMAN_PER_USDC = 100_000n;

export function getKaiTokenDecimals(): number {
  const raw = Deno.env.get("KAI_TOKEN_DECIMALS");
  if (raw == null || raw === "") return 18;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 && n <= 36 ? n : 18;
}

/**
 * x402 `maxAmountRequired` for KAI: micro-USD-equivalent price × 100_000 KAI/USDC × 10^decimals / 1e6.
 */
export function kaiMaxAmountRequiredFromUsd(priceUsd: number): string {
  const decimals = BigInt(getKaiTokenDecimals());
  const microUsd = BigInt(Math.round(priceUsd * 1_000_000));
  const raw = (microUsd * KAI_HUMAN_PER_USDC * (10n ** decimals)) / 1_000_000n;
  return raw.toString();
}

function normAddr(a: string): string {
  return a.toLowerCase().replace(/^0x/, "");
}

/**
 * Decide whether the client paid with USDC or KAI (EIP-712 domain, payload hints, or JSON scan).
 */
export function classifyPaymentToken(paymentPayload: any): "USDC" | "KAI" {
  const wantKai = normAddr(KAI_TOKEN_BASE_MAINNET);
  const wantUsdc = normAddr(USDC_BASE_MAINNET);
  const candidates: unknown[] = [
    paymentPayload?.asset,
    paymentPayload?.token,
    paymentPayload?.tokenAddress,
    paymentPayload?.payload?.asset,
    paymentPayload?.payload?.domain?.verifyingContract,
    paymentPayload?.payload?.message?.token,
    paymentPayload?.payment?.asset,
  ];
  for (const c of candidates) {
    if (typeof c !== "string" || !c.startsWith("0x")) continue;
    const n = normAddr(c);
    if (n === wantKai) return "KAI";
    if (n === wantUsdc) return "USDC";
  }
  try {
    const blob = JSON.stringify(paymentPayload).toLowerCase();
    if (blob.includes(wantKai)) return "KAI";
    if (blob.includes(wantUsdc)) return "USDC";
  } catch {
    /* ignore */
  }
  return "USDC";
}

export interface PaymentVerificationResult {
  verified: boolean;
  txHash?: string;
  payer?: string;
  amount?: number;
  error?: string;
}

/**
 * Verifies an x402 payment by calling the facilitator's verify endpoint.
 * The payment header is the X-PAYMENT header from the request.
 */
function buildSinglePaymentRequirement(opts: {
  priceUsd: number;
  service: string;
  endpoint: string;
  description: string;
  asset: "USDC" | "KAI";
  agentAddress: string;
}) {
  if (opts.asset === "USDC") {
    return {
      scheme: "exact",
      network: BASE_MAINNET_CAIP2,
      maxAmountRequired: Math.floor(opts.priceUsd * 1_000_000).toString(),
      resource: opts.endpoint,
      description: opts.description,
      mimeType: "application/json",
      payTo: opts.agentAddress,
      maxTimeoutSeconds: 300,
      asset: USDC_BASE_MAINNET,
      extra: { name: "USD Coin", version: "2" },
    };
  }
  return {
    scheme: "exact",
    network: BASE_MAINNET_CAIP2,
    maxAmountRequired: kaiMaxAmountRequiredFromUsd(opts.priceUsd),
    resource: opts.endpoint,
    description: opts.description,
    mimeType: "application/json",
    payTo: opts.agentAddress,
    maxTimeoutSeconds: 300,
    asset: KAI_TOKEN_BASE_MAINNET,
    extra: { name: "KAI", version: "1" },
  };
}

export async function verifyX402Payment(
  paymentHeader: string,
  expectedAmount: number,
  service: string,
  endpoint: string,
): Promise<PaymentVerificationResult> {
  try {
    const agentAddress = await getAgentWalletAddress();

    // Parse the payment header (base64-encoded JSON)
    let paymentPayload: any;
    try {
      paymentPayload = JSON.parse(atob(paymentHeader));
    } catch {
      return { verified: false, error: "Invalid payment header format" };
    }

    const token = classifyPaymentToken(paymentPayload);
    const paymentRequirements = [
      buildSinglePaymentRequirement({
        priceUsd: expectedAmount,
        service,
        endpoint,
        description: service,
        asset: token,
        agentAddress,
      }),
    ];

    // Call facilitator to verify
    const verifyResp = await fetch(`${FACILITATOR_URL}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payment: paymentPayload,
        paymentRequirements,
      }),
    });

    if (!verifyResp.ok) {
      const errText = await verifyResp.text();
      return { verified: false, error: `Facilitator error: ${errText}` };
    }

    const verifyResult = await verifyResp.json();

    if (!verifyResult.isValid) {
      return { verified: false, error: verifyResult.invalidReason || "Payment invalid" };
    }

    // Settle the payment
    const settleResp = await fetch(`${FACILITATOR_URL}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payment: paymentPayload,
        paymentRequirements,
      }),
    });

    const settleResult = settleResp.ok ? await settleResp.json() : {};
    const txHash = settleResult.transaction || paymentPayload?.payload?.authorization?.value || null;
    const payer = paymentPayload?.payload?.authorization?.from ||
      paymentPayload?.from ||
      "unknown";

    // Record to ledger
    await recordPayment({
      txHash,
      payer,
      amountUsd: expectedAmount,
      service,
      endpoint,
      status: "verified",
      paymentToken: token,
    });

    return {
      verified: true,
      txHash,
      payer,
      amount: expectedAmount,
    };
  } catch (err) {
    console.error("Payment verification error:", err);
    return { verified: false, error: String(err) };
  }
}

/**
 * Record a payment to the SQLite ledger.
 */
export async function recordPayment(opts: {
  txHash?: string;
  payer: string;
  amountUsd: number;
  service: string;
  endpoint: string;
  status: string;
  blockNumber?: number;
  metadata?: Record<string, any>;
  /** Ledger label: USDC or KAI (amount_usd remains USD-equivalent for stats). */
  paymentToken?: "USDC" | "KAI";
}): Promise<number> {
  const tokenLabel = opts.paymentToken ?? "USDC";
  const meta: Record<string, unknown> = { ...(opts.metadata ?? {}) };
  if (opts.paymentToken === "KAI") {
    meta.kaiHumanEquivalent = opts.amountUsd * 100_000;
    meta.kaiUsdParity = "1 USDC = 100000 KAI";
  }
  const result = await sqlite.execute({
    sql: `INSERT INTO payment_ledger
            (tx_hash, payer, amount_usd, token, network, service, endpoint, status, block_number, metadata)
          VALUES (?, ?, ?, ?, 'base', ?, ?, ?, ?, ?)`,
    args: [
      opts.txHash ?? null,
      opts.payer,
      opts.amountUsd,
      tokenLabel,
      opts.service,
      opts.endpoint,
      opts.status,
      opts.blockNumber ?? null,
      Object.keys(meta).length ? JSON.stringify(meta) : null,
    ],
  });

  // Update tool revenue stats
  await sqlite.execute({
    sql: `UPDATE mcp_tools SET call_count = call_count + 1, total_earned = total_earned + ?
          WHERE name = ?`,
    args: [opts.amountUsd, opts.service],
  });

  return Number(result.lastInsertRowid);
}

/**
 * Record a service call in the log.
 */
export async function logServiceCall(opts: {
  caller: string;
  callerType: "human" | "agent" | "unknown";
  service: string;
  paymentId?: number;
  status: "success" | "failed" | "payment_required";
  latencyMs?: number;
  requestMeta?: Record<string, any>;
  responseMeta?: Record<string, any>;
}) {
  await sqlite.execute({
    sql: `INSERT INTO service_calls
            (caller, caller_type, service, payment_id, status, latency_ms, request_meta, response_meta)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      opts.caller,
      opts.callerType,
      opts.service,
      opts.paymentId ?? null,
      opts.status,
      opts.latencyMs ?? null,
      opts.requestMeta ? JSON.stringify(opts.requestMeta) : null,
      opts.responseMeta ? JSON.stringify(opts.responseMeta) : null,
    ],
  });
}

/**
 * Track or update an A2A agent in the registry.
 */
export async function trackA2AAgent(opts: {
  address: string;
  name?: string;
  url?: string;
  amountPaid?: number;
}) {
  await sqlite.execute({
    sql: `INSERT INTO a2a_agents (agent_address, agent_name, agent_url, total_calls, total_paid)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(agent_address) DO UPDATE SET
            agent_name = COALESCE(excluded.agent_name, agent_name),
            agent_url = COALESCE(excluded.agent_url, agent_url),
            total_calls = total_calls + 1,
            total_paid = total_paid + excluded.total_paid,
            last_seen = datetime('now')`,
    args: [opts.address, opts.name ?? null, opts.url ?? null, opts.amountPaid ?? 0],
  });
}

/**
 * Get payment ledger summary stats.
 */
export async function getPaymentStats() {
  const totals = await sqlite.execute(`
    SELECT
      COUNT(*) as total_payments,
      SUM(amount_usd) as total_revenue,
      COUNT(DISTINCT payer) as unique_payers,
      COUNT(DISTINCT service) as services_used
    FROM payment_ledger WHERE status = 'verified'
  `);

  const recent = await sqlite.execute(`
    SELECT id, tx_hash, payer, amount_usd, service, status, created_at
    FROM payment_ledger
    ORDER BY created_at DESC
    LIMIT 20
  `);

  const byService = await sqlite.execute(`
    SELECT service, COUNT(*) as calls, SUM(amount_usd) as revenue
    FROM payment_ledger
    WHERE status = 'verified'
    GROUP BY service
    ORDER BY revenue DESC
  `);

  return { totals: totals.rows[0], recent: recent.rows, byService: byService.rows };
}

/**
 * Build x402 `accepts` entries: USDC (6 decimals) and $KAI on Base (1 USDC = 100,000 KAI human units).
 */
export async function buildPaymentAccepts(opts: {
  price: number; // USD-equivalent
  service: string;
  endpoint: string;
  description: string;
}) {
  const agentAddress = await getAgentWalletAddress();
  return [
    buildSinglePaymentRequirement({
      priceUsd: opts.price,
      service: opts.service,
      endpoint: opts.endpoint,
      description: opts.description,
      asset: "USDC",
      agentAddress,
    }),
    buildSinglePaymentRequirement({
      priceUsd: opts.price,
      service: opts.service,
      endpoint: opts.endpoint,
      description: opts.description,
      asset: "KAI",
      agentAddress,
    }),
  ];
}
