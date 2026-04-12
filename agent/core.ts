/**
 * Kai-AI Agent Core
 * The brain of Kai-AI. Handles tool execution, AI responses, and A2A interactions.
 * Tools: ai_chat, market_data, base_tx_lookup, wallet_balance, text_analysis, web_search, code_review
 */
import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { lookupTransaction, getWalletBalance, BASE_MAINNET } from "./wallet.ts";

export const AGENT_NAME = "Kai-AI";
export const AGENT_VERSION = "1.0.0";
export const AGENT_DESCRIPTION =
  "An autonomous AI agent on Base Mainnet with x402 pay-per-use API services, MCP tools, and A2A capabilities.";

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  latencyMs?: number;
}

/**
 * Execute a named tool with given parameters.
 */
export async function executeTool(
  toolName: string,
  params: Record<string, any>,
): Promise<ToolResult> {
  const start = Date.now();
  try {
    let data: any;

    switch (toolName) {
      case "ai_chat":
        data = await toolAiChat(params);
        break;
      case "market_data":
        data = await toolMarketData(params);
        break;
      case "base_tx_lookup":
        data = await toolBaseTxLookup(params);
        break;
      case "wallet_balance":
        data = await toolWalletBalance(params);
        break;
      case "text_analysis":
        data = await toolTextAnalysis(params);
        break;
      case "web_search":
        data = await toolWebSearch(params);
        break;
      case "code_review":
        data = await toolCodeReview(params);
        break;
      case "image_caption":
        data = await toolImageCaption(params);
        break;
      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }

    return { success: true, data, latencyMs: Date.now() - start };
  } catch (err) {
    return { success: false, error: String(err), latencyMs: Date.now() - start };
  }
}

// ── Tool Implementations ─────────────────────────────────────────────────────

async function toolAiChat(params: { query: string; context?: string }): Promise<any> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const messages = [
    {
      role: "system",
      content: `You are Kai-AI, an intelligent autonomous agent deployed on the Base blockchain. 
You assist users and other AI agents with information, analysis, and blockchain-related tasks.
Be concise, accurate, and helpful. You are part of the x402 agent economy.`,
    },
  ];

  if (params.context) {
    messages.push({ role: "system", content: `Context: ${params.context}` });
  }
  messages.push({ role: "user", content: params.query });

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 1024,
      temperature: 0.7,
    }),
  });

  if (!resp.ok) throw new Error(`OpenAI error: ${resp.status}`);
  const json = await resp.json();
  return {
    response: json.choices[0].message.content,
    model: json.model,
    tokens: json.usage?.total_tokens,
  };
}

async function toolMarketData(params: {
  token: string;
  vs_currency?: string;
}): Promise<any> {
  const vs = params.vs_currency || "usd";
  const coinId = normalizeCoinId(params.token);

  const resp = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=${vs}&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true`,
  );
  if (!resp.ok) throw new Error(`CoinGecko error: ${resp.status}`);
  const json = await resp.json();
  const data = json[coinId];
  if (!data) throw new Error(`Token '${params.token}' not found`);

  return {
    token: params.token.toUpperCase(),
    coin_id: coinId,
    price: data[vs],
    market_cap: data[`${vs}_market_cap`],
    volume_24h: data[`${vs}_24h_vol`],
    change_24h: data[`${vs}_24h_change`],
    last_updated: new Date(data.last_updated_at * 1000).toISOString(),
    currency: vs.toUpperCase(),
  };
}

async function toolBaseTxLookup(params: { tx_hash: string }): Promise<any> {
  const tx = await lookupTransaction(params.tx_hash);
  if (!tx) throw new Error(`Transaction not found: ${params.tx_hash}`);
  return tx;
}

async function toolWalletBalance(params: {
  address: string;
  token?: string;
}): Promise<any> {
  const { eth, usdc } = await getWalletBalance(params.address);
  return {
    address: params.address,
    network: "Base Mainnet",
    balances: {
      ETH: eth,
      USDC: usdc,
    },
    explorer_url: `${BASE_MAINNET.blockExplorer}/address/${params.address}`,
  };
}

async function toolTextAnalysis(params: {
  text: string;
  analysis_type?: string;
}): Promise<any> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const analysisType = params.analysis_type || "full";
  const prompt = `Analyze the following text and return a JSON object with:
- sentiment: "positive" | "negative" | "neutral" | "mixed"
- sentiment_score: number between -1 (very negative) and 1 (very positive)
- entities: array of {name, type} (people, places, organizations, concepts)
- topics: array of main topics/themes
- keywords: top 5 keywords
- summary: one-sentence summary

Text: "${params.text}"

Return ONLY valid JSON, no markdown.`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 512,
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });

  if (!resp.ok) throw new Error(`OpenAI error: ${resp.status}`);
  const json = await resp.json();
  return JSON.parse(json.choices[0].message.content);
}

async function toolWebSearch(params: {
  query: string;
  num_results?: number;
}): Promise<any> {
  const apiKey = Deno.env.get("SERPER_API_KEY") || Deno.env.get("OPENAI_API_KEY");

  // Use Serper if available, otherwise use OpenAI's knowledge
  if (Deno.env.get("SERPER_API_KEY")) {
    const resp = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": Deno.env.get("SERPER_API_KEY")!,
      },
      body: JSON.stringify({ q: params.query, num: params.num_results || 5 }),
    });
    if (!resp.ok) throw new Error(`Serper error: ${resp.status}`);
    const json = await resp.json();
    return {
      query: params.query,
      results: (json.organic || []).slice(0, params.num_results || 5).map((r: any) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
      })),
      answer_box: json.answerBox?.answer || null,
    };
  }

  // Fallback: use AI knowledge
  if (!Deno.env.get("OPENAI_API_KEY")) throw new Error("No search API configured");
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${Deno.env.get("OPENAI_API_KEY")}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: `Search query: "${params.query}". Provide ${params.num_results || 3} relevant results with title, url (if known), and a brief summary as JSON array.`,
      }],
      max_tokens: 512,
      response_format: { type: "json_object" },
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI error: ${resp.status}`);
  const json = await resp.json();
  return JSON.parse(json.choices[0].message.content);
}

async function toolCodeReview(params: {
  code: string;
  language?: string;
}): Promise<any> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const lang = params.language || "auto-detect";
  const prompt = `Review the following ${lang} code and return a JSON object with:
- language: detected programming language
- issues: array of {severity: "critical"|"warning"|"info", line: number|null, description: string, suggestion: string}
- security: array of security vulnerabilities found
- performance: array of performance issues
- score: overall code quality score 0-100
- summary: brief overall assessment

Code:
\`\`\`
${params.code.slice(0, 3000)}
\`\`\`

Return ONLY valid JSON.`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });

  if (!resp.ok) throw new Error(`OpenAI error: ${resp.status}`);
  const json = await resp.json();
  return JSON.parse(json.choices[0].message.content);
}

async function toolImageCaption(params: { image_url: string }): Promise<any> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image in detail. Return JSON with: caption (string), objects (array of detected objects), scene_type, confidence (0-1)" },
          { type: "image_url", image_url: { url: params.image_url } },
        ],
      }],
      max_tokens: 512,
      response_format: { type: "json_object" },
    }),
  });

  if (!resp.ok) throw new Error(`OpenAI error: ${resp.status}`);
  const json = await resp.json();
  return JSON.parse(json.choices[0].message.content);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeCoinId(token: string): string {
  const map: Record<string, string> = {
    BTC: "bitcoin",
    ETH: "ethereum",
    USDC: "usd-coin",
    USDT: "tether",
    BASE: "base",
    CBETH: "coinbase-wrapped-staked-eth",
    SOL: "solana",
    DOGE: "dogecoin",
    MATIC: "matic-network",
    LINK: "chainlink",
    UNI: "uniswap",
    AAVE: "aave",
  };
  return map[token.toUpperCase()] || token.toLowerCase();
}

/**
 * Get all available tools from the database.
 */
export async function getAvailableTools() {
  const result = await sqlite.execute(
    "SELECT * FROM mcp_tools WHERE enabled = 1 ORDER BY category, name",
  );
  return result.rows;
}

/**
 * Get the agent card for A2A discovery.
 */
export function getAgentCard() {
  return {
    name: AGENT_NAME,
    version: AGENT_VERSION,
    description: AGENT_DESCRIPTION,
    protocol: "x402+A2A",
    blockchain: "Base Mainnet (eip155:8453)",
    payment_token: "USDC",
    facilitator: "https://facilitator.x402.org",
    mcp_endpoint: "/mcp",
    a2a_endpoint: "/a2a",
    capabilities: [
      "ai_chat",
      "market_data",
      "base_tx_lookup",
      "wallet_balance",
      "text_analysis",
      "web_search",
      "code_review",
      "image_caption",
    ],
    supported_schemes: ["exact"],
    links: {
      tools: "/api/tools",
      docs: "/docs",
      dashboard: "/dashboard",
    },
  };
}
