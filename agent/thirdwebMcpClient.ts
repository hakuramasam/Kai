/**
 * MCP client for thirdweb's hosted Streamable HTTP server.
 * Proxies thirdweb tools through Kai-AI's /mcp when THIRDWEB_SECRET_KEY is set.
 *
 * @see https://portal.thirdweb.com/ai/mcp
 */
import { Client } from "npm:@modelcontextprotocol/sdk@1.29.0/client";
import { StreamableHTTPClientTransport } from "npm:@modelcontextprotocol/sdk@1.29.0/client/streamableHttp.js";

const SDK_NAME = "kai-ai-thirdweb-proxy";
const SDK_VERSION = "1.0.0";
const TOOL_NAMES_CACHE_MS = 5 * 60 * 1000;

/** Comma-separated thirdweb tool names that skip Kai x402 (default: thirdweb AI chat). */
const DEFAULT_FREE_THIRDWEB_TOOLS = "chat";

/**
 * thirdweb tools that do not require X-PAYMENT on Kai (still use deployment THIRDWEB_SECRET_KEY upstream).
 */
export function getThirdwebFreeToolNames(): Set<string> {
  const raw = Deno.env.get("THIRDWEB_FREE_TOOLS") ?? DEFAULT_FREE_THIRDWEB_TOOLS;
  return new Set(
    raw.split(",").map((s) => s.trim()).filter(Boolean),
  );
}

export function isThirdwebToolFree(toolName: string): boolean {
  return getThirdwebFreeToolNames().has(toolName);
}

/**
 * USDC price per paid thirdweb proxied call on Kai (x402), excluding {@link isThirdwebToolFree} tools.
 */
export function getThirdwebProxyPriceUsd(): number {
  const raw = Deno.env.get("THIRDWEB_PROXY_PRICE_USD");
  if (raw == null || raw === "") return 0.01;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 0.01;
}

/**
 * Applied to {@link THIRDWEB_GAS_SURCHARGE_TOOLS} so Kai x402 matches:
 * `THIRDWEB_PROXY_PRICE_USD × multiplier` (default 0.01 × 1.5 for contract deploy / on-chain writes).
 */
export function getThirdwebGasSurchargeMultiplier(): number {
  const raw = Deno.env.get("THIRDWEB_GAS_SURCHARGE_MULTIPLIER");
  if (raw == null || raw === "") return 1.5;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 1.5;
}

/**
 * thirdweb tools that create contracts or submit on-chain transactions (gas-heavy).
 * Override with env `THIRDWEB_GAS_SURCHARGE_TOOLS` (comma-separated).
 */
export const THIRDWEB_GAS_SURCHARGE_TOOLS = [
  "deployContract",
  "writeContract",
  "sendTokens",
  "sendTransactions",
  "createToken",
  "bridgeSwap",
  "createPayment",
  "paymentsPurchase",
  "fetchWithPayment",
] as const;

function getThirdwebGasSurchargeToolNames(): Set<string> {
  const custom = Deno.env.get("THIRDWEB_GAS_SURCHARGE_TOOLS");
  if (custom?.trim()) {
    return new Set(custom.split(",").map((s) => s.trim()).filter(Boolean));
  }
  return new Set(THIRDWEB_GAS_SURCHARGE_TOOLS as unknown as string[]);
}

/** True if this tool uses base × gas surcharge (contract creation, writes, txs). */
export function isThirdwebGasSurchargeTool(toolName: string): boolean {
  return getThirdwebGasSurchargeToolNames().has(toolName);
}

function roundUsdcAmount(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Final Kai x402 price (USDC on Base) for a thirdweb proxied tool.
 * - Free tools (e.g. `chat`): 0 (no x402 on Kai).
 * - Gas-heavy tools: `getThirdwebProxyPriceUsd() × getThirdwebGasSurchargeMultiplier()` (e.g. 0.01 × 1.5).
 * - Other paid tools: base only.
 */
export function getThirdwebToolPriceUsd(toolName: string): number {
  if (isThirdwebToolFree(toolName)) return 0;
  const base = getThirdwebProxyPriceUsd();
  if (isThirdwebGasSurchargeTool(toolName)) {
    return roundUsdcAmount(base * getThirdwebGasSurchargeMultiplier());
  }
  return base;
}

/**
 * Stable x402 `resource` path for a thirdweb tool (must match verify + 402 accepts).
 */
export function thirdwebX402ResourcePath(toolName: string): string {
  return `/api/thirdweb-proxy/${encodeURIComponent(toolName)}`;
}

/** Ledger / analytics service id for a proxied thirdweb tool. */
export function thirdwebProxyServiceId(toolName: string): string {
  return `thirdweb_${toolName}`;
}

let cachedClient: Client | null = null;
let connectInflight: Promise<Client> | null = null;
let toolNamesCache: { names: Set<string>; expiresAt: number } | null = null;

export function isThirdwebMcpConfigured(): boolean {
  const k = Deno.env.get("THIRDWEB_SECRET_KEY");
  return typeof k === "string" && k.length > 0;
}

function buildThirdwebMcpUrl(): string {
  const secret = Deno.env.get("THIRDWEB_SECRET_KEY");
  if (!secret) throw new Error("THIRDWEB_SECRET_KEY is not set");

  const base = Deno.env.get("THIRDWEB_MCP_URL")?.replace(/\/$/, "") ||
    "https://api.thirdweb.com/mcp";
  const toolsFilter = Deno.env.get("THIRDWEB_MCP_TOOLS");
  const u = new URL(base);
  u.searchParams.set("secretKey", secret);
  if (toolsFilter?.trim()) {
    u.searchParams.set("tools", toolsFilter.trim());
  }
  return u.toString();
}

/** Clear cached tool names (e.g. after thirdweb dashboard changes) without dropping the MCP session. */
export function invalidateThirdwebToolNameCache(): void {
  toolNamesCache = null;
}

export async function resetThirdwebMcpConnection(): Promise<void> {
  invalidateThirdwebToolNameCache();
  const c = cachedClient;
  cachedClient = null;
  connectInflight = null;
  if (c) {
    await c.close().catch(() => undefined);
  }
}

async function connectThirdwebClient(): Promise<Client> {
  const url = buildThirdwebMcpUrl();
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client(
    { name: SDK_NAME, version: SDK_VERSION },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

/**
 * Singleton MCP client to thirdweb (same isolate / warm instance).
 */
export async function getThirdwebMcpClient(): Promise<Client | null> {
  if (!isThirdwebMcpConfigured()) return null;
  if (cachedClient) return cachedClient;
  if (connectInflight) return await connectInflight;

  connectInflight = (async () => {
    try {
      const c = await connectThirdwebClient();
      cachedClient = c;
      return c;
    } catch (e) {
      await resetThirdwebMcpConnection();
      throw e;
    } finally {
      connectInflight = null;
    }
  })();

  return await connectInflight;
}

export async function listThirdwebMcpTools(): Promise<
  Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  }>
> {
  const client = await getThirdwebMcpClient();
  if (!client) return [];

  const tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  }> = [];
  let cursor: string | undefined;

  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    for (const t of page.tools) {
      tools.push({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
        annotations: t.annotations as Record<string, unknown> | undefined,
      });
    }
    cursor = page.nextCursor;
  } while (cursor);

  toolNamesCache = {
    names: new Set(tools.map((t) => t.name)),
    expiresAt: Date.now() + TOOL_NAMES_CACHE_MS,
  };

  return tools;
}

export async function getCachedThirdwebToolNames(): Promise<Set<string>> {
  const now = Date.now();
  if (toolNamesCache && toolNamesCache.expiresAt > now) {
    return toolNamesCache.names;
  }
  const list = await listThirdwebMcpTools();
  const names = new Set(list.map((t) => t.name));
  toolNamesCache = { names, expiresAt: now + TOOL_NAMES_CACHE_MS };
  return names;
}

export async function callThirdwebTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const run = async () => {
    const client = await getThirdwebMcpClient();
    if (!client) {
      throw new Error("Thirdweb MCP is not configured (THIRDWEB_SECRET_KEY)");
    }
    return await client.callTool({
      name,
      arguments: args,
    });
  };

  try {
    return await run();
  } catch (first) {
    await resetThirdwebMcpConnection();
    return await run();
  }
}
