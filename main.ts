/**
 * Kai-AI — Autonomous Agent on Base Mainnet
 * ─────────────────────────────────────────
 * Features:
 *  ✅ x402 payment middleware (per-API-call USDC payments on Base)
 *  ✅ MCP server (Model Context Protocol for AI agent tool use)
 *  ✅ A2A protocol (Agent-to-Agent services)
 *  ✅ Payment verification system (on-chain via Coinbase facilitator)
 *  ✅ Payment ledger (SQLite)
 *  ✅ Agent wallet (Base Mainnet read)
 *  ✅ Dashboard UI
 *
 * Required env vars:
 *   AGENT_WALLET_ADDRESS  — 0x... address that receives payments
 *   OPENAI_API_KEY        — for AI tools (ai_chat, text_analysis, etc.)
 *   SERPER_API_KEY        — optional, for web_search tool
 *
 * Optional (thirdweb MCP proxy on POST /mcp):
 *   THIRDWEB_SECRET_KEY   — project secret; enables proxied thirdweb tools
 *   THIRDWEB_MCP_URL      — optional override, default https://api.thirdweb.com/mcp
 *   THIRDWEB_MCP_TOOLS    — optional comma-separated tool filter (thirdweb query param)
 *   THIRDWEB_FREE_TOOLS   — comma-separated thirdweb tool names with no Kai x402 (default: chat)
 *   THIRDWEB_PROXY_PRICE_USD — base USDC per paid thirdweb tool on Kai (default: 0.01)
 *   THIRDWEB_GAS_SURCHARGE_MULTIPLIER — multiply base for on-chain/contract tools (default: 1.5)
 *   THIRDWEB_GAS_SURCHARGE_TOOLS — optional comma list; defaults to deployContract, writeContract, sendTokens, …
 *
 * x402 alternate asset (Base Mainnet):
 *   KAI token 0x86aF9cB35a613992Ea552E0bA7419F1dAdA3084C — 1 USDC = 100,000 KAI (see payments/verifier.ts)
 *   KAI_TOKEN_DECIMALS — optional, default 18 (smallest-unit amount in accepts)
 */

import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { parseVal, readFile, httpEndpoint } from "https://esm.town/v/std/utils/index.ts";
import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { runMigrations } from "./database/migrations.ts";
import { mcpRouter } from "./agent/mcp.ts";
import { executeTool, getAvailableTools, getAgentCard } from "./agent/core.ts";
import { getFullWalletInfo, getAgentWalletAddress } from "./agent/wallet.ts";
import {
  verifyX402Payment,
  recordPayment,
  logServiceCall,
  trackA2AAgent,
  getPaymentStats,
  buildPaymentAccepts,
} from "./payments/verifier.ts";

// ── Init ─────────────────────────────────────────────────────────────────────
await runMigrations();

const app = new Hono();

app.onError((err) => Promise.reject(err));

// CORS for cross-origin agent calls
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "X-PAYMENT", "X-Agent-Address", "X-Agent-Name", "X-Agent-URL", "Authorization"],
  exposeHeaders: ["X-Payment-Response", "Content-Type"],
}));

// ── x402 Payment Middleware ───────────────────────────────────────────────────
/**
 * Applies x402 payment gating to /api/tools/* routes.
 * Returns 402 with payment requirements if no valid X-PAYMENT header.
 * On valid payment: verifies with Coinbase facilitator and proceeds.
 */
async function x402PaymentMiddleware(c: any, next: () => Promise<void>) {
  const path = c.req.path;

  // Only gate /api/tools/* routes
  if (!path.startsWith("/api/tools/") || path === "/api/tools") {
    return next();
  }

  // Determine which tool is being called
  const toolSlug = path.replace("/api/tools/", "").split("?")[0];
  const toolName = toolSlug.replace(/-/g, "_");

  // Look up tool price from DB
  const toolResult = await sqlite.execute({
    sql: "SELECT * FROM mcp_tools WHERE name = ? AND enabled = 1",
    args: [toolName],
  });

  if (toolResult.rows.length === 0) {
    return c.json({ error: `Tool '${toolName}' not found or disabled` }, 404);
  }

  const tool = toolResult.rows[0] as any;
  const priceUsd = tool.price_usd;

  // Check for X-PAYMENT header (x402 protocol)
  const paymentHeader = c.req.header("X-PAYMENT");
  const caller = c.req.header("X-Agent-Address") ||
    c.req.header("X-Forwarded-For") ||
    "anonymous";

  if (!paymentHeader) {
    // Return 402 Payment Required with payment instructions
    const accepts = await buildPaymentAccepts({
      price: priceUsd,
      service: toolName,
      endpoint: path,
      description: tool.description,
    });

    // Log the unpaid call attempt
    await logServiceCall({
      caller,
      callerType: c.req.header("X-Agent-Address") ? "agent" : "unknown",
      service: toolName,
      status: "payment_required",
    });

    return c.json(
      {
        x402Version: 1,
        error: "Payment Required",
        accepts,
        message:
          `This endpoint requires $${priceUsd} equivalent on Base via x402 (USDC or $KAI at 1 USDC = 100,000 KAI).`,
        instructions: {
          step1: "Parse the 'accepts' field (USDC and KAI options)",
          step2: "Sign EIP-3009 TransferWithAuthorization for the chosen asset and amount",
          step3: "Encode payload as base64 JSON and set X-PAYMENT header",
          step4: "Retry the request with X-PAYMENT header",
          docs: "https://docs.cdp.coinbase.com/x402/welcome",
          facilitator: "https://facilitator.x402.org",
        },
      },
      402,
      { "X-Payment-Required": "true" },
    );
  }

  // Verify payment with Coinbase facilitator
  const verification = await verifyX402Payment(
    paymentHeader,
    priceUsd,
    toolName,
    path,
  );

  if (!verification.verified) {
    return c.json(
      {
        error: "Payment verification failed",
        reason: verification.error,
        x402Version: 1,
      },
      402,
    );
  }

  // Track A2A agent if present
  const agentAddress = c.req.header("X-Agent-Address");
  if (agentAddress) {
    await trackA2AAgent({
      address: agentAddress,
      name: c.req.header("X-Agent-Name") || undefined,
      url: c.req.header("X-Agent-URL") || undefined,
      amountPaid: priceUsd,
    });
  }

  // Store payment info in context for the handler
  c.set("payment", verification);
  c.set("toolName", toolName);
  c.set("caller", caller);

  await next();
}

app.use("/api/tools/*", x402PaymentMiddleware);

// ── MCP Router ────────────────────────────────────────────────────────────────
app.route("/mcp", mcpRouter);

/** x402 `resource` URLs for thirdweb MCP proxy tools point here (see agent/thirdwebMcpClient.ts). */
app.get("/api/thirdweb-proxy/:tool", (c) => {
  let name = c.req.param("tool");
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep raw */
  }
  return c.json({
    purpose: "x402 resource path for paid thirdweb tools invoked via POST /mcp",
    thirdwebTool: name,
    usage: "JSON-RPC tools/call to /mcp with matching X-PAYMENT (resource must equal this request path)",
  });
});

// ── Public API Routes ─────────────────────────────────────────────────────────

/** Agent card — discovery endpoint for A2A and MCP clients */
app.get("/.well-known/agent.json", (c) => c.json(getAgentCard()));
app.get("/agent-card", (c) => c.json(getAgentCard()));

/** Stats for the dashboard */
app.get("/api/stats", async (c) => {
  const stats = await getPaymentStats();
  return c.json(stats);
});

/** Wallet info */
app.get("/api/wallet", async (c) => {
  try {
    const wallet = await getFullWalletInfo();
    return c.json(wallet);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

/** List all available tools */
app.get("/api/tools", async (c) => {
  const tools = await getAvailableTools();
  return c.json({ tools });
});

/** Payment ledger */
app.get("/api/payments", async (c) => {
  const limit = parseInt(c.req.query("limit") || "20");
  const result = await sqlite.execute({
    sql: `SELECT * FROM payment_ledger ORDER BY created_at DESC LIMIT ?`,
    args: [Math.min(limit, 100)],
  });
  return c.json({ payments: result.rows });
});

/** A2A agent registry */
app.get("/api/agents", async (c) => {
  const result = await sqlite.execute(
    "SELECT * FROM a2a_agents ORDER BY last_seen DESC LIMIT 50",
  );
  return c.json({ agents: result.rows });
});

/** Demo endpoint (no payment required, limited functionality) */
app.post("/api/demo", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const { tool, input } = body;
  if (!tool || !input) return c.json({ error: "Missing tool or input" }, 400);

  // Demo mode: run with simplified parameters, limited output
  const params: Record<string, any> = {};
  switch (tool) {
    case "ai_chat":
      params.query = input;
      params.context = "Demo mode. Keep response brief (2-3 sentences).";
      break;
    case "market_data":
      params.token = input.toUpperCase();
      break;
    case "wallet_balance":
      params.address = input;
      break;
    case "text_analysis":
      params.text = input;
      break;
    default:
      return c.json({ error: `Tool '${tool}' not available in demo mode` }, 400);
  }

  const result = await executeTool(tool, params);

  // Log demo call
  await logServiceCall({
    caller: "demo-user",
    callerType: "human",
    service: `${tool}__demo`,
    status: result.success ? "success" : "failed",
    latencyMs: result.latencyMs,
  });

  return c.json({
    tool,
    mode: "demo",
    note: "Full API calls require USDC payment via x402 on Base Mainnet",
    ...result,
  });
});

// ── Paid Tool Routes ──────────────────────────────────────────────────────────
// These are protected by the x402 middleware above.

app.post("/api/tools/:tool", async (c) => {
  const toolName = c.get("toolName") || c.req.param("tool").replace(/-/g, "_");
  const payment = c.get("payment");
  const caller = c.get("caller") || "unknown";

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {}

  const start = Date.now();
  const result = await executeTool(toolName, body);
  const latencyMs = Date.now() - start;

  // Log the successful call
  await logServiceCall({
    caller,
    callerType: c.req.header("X-Agent-Address") ? "agent" : "human",
    service: toolName,
    status: result.success ? "success" : "failed",
    latencyMs,
    requestMeta: { params: Object.keys(body) },
    responseMeta: { success: result.success },
  });

  if (!result.success) {
    return c.json({ error: result.error }, 500);
  }

  return c.json({
    tool: toolName,
    result: result.data,
    latencyMs,
    payment: {
      verified: true,
      txHash: payment?.txHash,
      payer: payment?.payer,
      amount: payment?.amount,
      network: "base",
      token: "USDC",
    },
  });
});

// ── A2A Endpoint ──────────────────────────────────────────────────────────────
/**
 * A2A Agent-to-Agent service endpoint.
 * Other agents POST here to execute tasks.
 * Requires x402 payment for paid tasks.
 */
app.post("/a2a", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { task, params, callback_url, agent_id } = body;
  const agentAddress = c.req.header("X-Agent-Address") || agent_id || "unknown";
  const agentName = c.req.header("X-Agent-Name") || "Unknown Agent";

  if (!task) {
    return c.json({ error: "Missing 'task' field" }, 400);
  }

  // Look up task/tool
  const toolResult = await sqlite.execute({
    sql: "SELECT * FROM mcp_tools WHERE name = ? AND enabled = 1",
    args: [task],
  });

  if (toolResult.rows.length === 0) {
    return c.json({
      error: `Unknown task: '${task}'`,
      available_tasks: (await getAvailableTools()).map((t: any) => t.name),
    }, 404);
  }

  const tool = toolResult.rows[0] as any;

  // Check payment
  const paymentHeader = c.req.header("X-PAYMENT");
  if (!paymentHeader) {
    const accepts = await buildPaymentAccepts({
      price: tool.price_usd,
      service: task,
      endpoint: "/a2a",
      description: `A2A task: ${tool.description}`,
    });

    return c.json({
      x402Version: 1,
      error: "Payment Required for A2A task",
      task,
      accepts,
      agent_info: getAgentCard(),
    }, 402);
  }

  // Verify payment
  const verification = await verifyX402Payment(
    paymentHeader,
    tool.price_usd,
    task,
    "/a2a",
  );

  if (!verification.verified) {
    return c.json({ error: "Payment failed", reason: verification.error }, 402);
  }

  // Track agent
  await trackA2AAgent({
    address: agentAddress,
    name: agentName,
    url: c.req.header("X-Agent-URL") || undefined,
    amountPaid: tool.price_usd,
  });

  // Execute the task
  const result = await executeTool(task, params || {});

  await logServiceCall({
    caller: agentAddress,
    callerType: "agent",
    service: task,
    status: result.success ? "success" : "failed",
    latencyMs: result.latencyMs,
  });

  if (!result.success) {
    return c.json({ error: result.error, task }, 500);
  }

  return c.json({
    task,
    status: "completed",
    result: result.data,
    agent: { name: "Kai-AI", version: "1.0.0" },
    payment: {
      verified: true,
      txHash: verification.txHash,
      amount: tool.price_usd,
      token: "USDC",
      network: "base",
    },
    latencyMs: result.latencyMs,
  });
});

// ── Dashboard & Docs ──────────────────────────────────────────────────────────

app.get("/source", (c) => c.redirect(parseVal().links.self.val));

app.get("/docs", async (c) => {
  const walletAddress = await getAgentWalletAddress();
  return c.html(`<!DOCTYPE html>
<html><head><title>Kai-AI API Docs</title>
<script src="https://cdn.twind.style" crossorigin></script></head>
<body class="bg-gray-950 text-gray-200 p-8 font-mono max-w-4xl mx-auto">
<h1 class="text-3xl font-bold text-white mb-2">Kai-AI API Documentation</h1>
<p class="text-gray-400 mb-8">x402 Payment Protocol · Base Mainnet · MCP + A2A</p>

<h2 class="text-xl font-bold text-indigo-400 mb-3">Payment Flow</h2>
<pre class="bg-gray-900 p-4 rounded-xl text-sm mb-6 overflow-auto">
1. GET /api/tools/ai-chat  →  402 + payment requirements
2. Client signs USDC transfer (EIP-3009) on Base Mainnet
3. POST /api/tools/ai-chat  + X-PAYMENT: base64(payload)
4. Kai-AI verifies via https://facilitator.x402.org
5. 200 OK + tool result
</pre>

<h2 class="text-xl font-bold text-indigo-400 mb-3">Available Tools</h2>
<table class="w-full text-sm mb-6">
<tr class="text-gray-400 border-b border-gray-700"><th class="text-left p-2">Tool</th><th class="text-left p-2">Endpoint</th><th class="text-left p-2">Price</th><th class="text-left p-2">Description</th></tr>
<tr class="border-b border-gray-800"><td class="p-2 text-yellow-300">ai_chat</td><td class="p-2">/api/tools/ai-chat</td><td class="p-2 text-green-400">$0.005</td><td class="p-2 text-gray-300">GPT-4o chat</td></tr>
<tr class="border-b border-gray-800"><td class="p-2 text-yellow-300">market_data</td><td class="p-2">/api/tools/market-data</td><td class="p-2 text-green-400">$0.002</td><td class="p-2 text-gray-300">Crypto prices</td></tr>
<tr class="border-b border-gray-800"><td class="p-2 text-yellow-300">base_tx_lookup</td><td class="p-2">/api/tools/base-tx-lookup</td><td class="p-2 text-green-400">$0.001</td><td class="p-2 text-gray-300">Base tx lookup</td></tr>
<tr class="border-b border-gray-800"><td class="p-2 text-yellow-300">wallet_balance</td><td class="p-2">/api/tools/wallet-balance</td><td class="p-2 text-green-400">$0.001</td><td class="p-2 text-gray-300">On-chain balance</td></tr>
<tr class="border-b border-gray-800"><td class="p-2 text-yellow-300">text_analysis</td><td class="p-2">/api/tools/text-analysis</td><td class="p-2 text-green-400">$0.003</td><td class="p-2 text-gray-300">AI text analysis</td></tr>
<tr class="border-b border-gray-800"><td class="p-2 text-yellow-300">web_search</td><td class="p-2">/api/tools/web-search</td><td class="p-2 text-green-400">$0.005</td><td class="p-2 text-gray-300">AI web search</td></tr>
<tr class="border-b border-gray-800"><td class="p-2 text-yellow-300">code_review</td><td class="p-2">/api/tools/code-review</td><td class="p-2 text-green-400">$0.020</td><td class="p-2 text-gray-300">AI code review</td></tr>
<tr><td class="p-2 text-yellow-300">image_caption</td><td class="p-2">/api/tools/image-caption</td><td class="p-2 text-green-400">$0.010</td><td class="p-2 text-gray-300">Vision AI caption</td></tr>
</table>

<h2 class="text-xl font-bold text-indigo-400 mb-3">Agent Wallet (Payment Recipient)</h2>
<p class="bg-gray-900 p-3 rounded-xl text-green-400 mb-6">${walletAddress}</p>

<h2 class="text-xl font-bold text-indigo-400 mb-3">Endpoints</h2>
<pre class="bg-gray-900 p-4 rounded-xl text-sm mb-6">
GET  /                        — Dashboard UI
GET  /.well-known/agent.json  — Agent card (A2A discovery)
GET  /mcp                     — MCP server info
POST /mcp                     — MCP JSON-RPC (tools/list, tools/call)
POST /a2a                     — A2A task execution
GET  /api/tools               — List all tools
POST /api/tools/:tool         — Execute tool (requires x402 payment)
GET  /api/stats               — Payment stats
GET  /api/payments            — Payment ledger
GET  /api/wallet              — Agent wallet info
GET  /api/agents              — A2A agent registry
GET  /docs                    — This page
GET  /source                  — Source code
</pre>
<a href="/" class="text-indigo-400">← Back to Dashboard</a>
</body></html>`);
});

// ── Root → Dashboard ─────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const html = await readFile("/frontend/index.html", import.meta.url);
  return new Response(html, { headers: { "Content-Type": "text/html" } });
});

export default app.fetch;
