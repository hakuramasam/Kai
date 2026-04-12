/**
 * Kai-AI Database Migrations
 * Sets up all tables for payment ledger, agent sessions, MCP tools, and A2A registry.
 */
import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

export async function runMigrations() {
  // Payment ledger: records every x402 payment received
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS payment_ledger (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_hash      TEXT,
      payer        TEXT NOT NULL,
      amount_usd   REAL NOT NULL,
      token        TEXT NOT NULL DEFAULT 'USDC',
      network      TEXT NOT NULL DEFAULT 'base',
      service      TEXT NOT NULL,
      endpoint     TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'verified',
      block_number INTEGER,
      metadata     TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Agent wallet: stores the agent's own wallet info (no private keys stored here)
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS agent_wallet (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      address      TEXT NOT NULL UNIQUE,
      label        TEXT NOT NULL DEFAULT 'Kai-AI Main Wallet',
      network      TEXT NOT NULL DEFAULT 'base',
      balance_usdc REAL NOT NULL DEFAULT 0,
      last_synced  TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // MCP tools registry: available tools/services and their prices
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS mcp_tools (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL UNIQUE,
      description  TEXT NOT NULL,
      endpoint     TEXT NOT NULL,
      price_usd    REAL NOT NULL DEFAULT 0.01,
      category     TEXT NOT NULL DEFAULT 'general',
      input_schema TEXT,
      output_schema TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      call_count   INTEGER NOT NULL DEFAULT 0,
      total_earned REAL NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // A2A agent registry: other agents that have called Kai-AI
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS a2a_agents (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_address TEXT NOT NULL UNIQUE,
      agent_name    TEXT,
      agent_url     TEXT,
      capabilities  TEXT,
      total_calls   INTEGER NOT NULL DEFAULT 0,
      total_paid    REAL NOT NULL DEFAULT 0,
      first_seen    TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Service call log: detailed log of every API call (paid or free)
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS service_calls (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      caller       TEXT NOT NULL,
      caller_type  TEXT NOT NULL DEFAULT 'unknown',
      service      TEXT NOT NULL,
      payment_id   INTEGER,
      status       TEXT NOT NULL DEFAULT 'success',
      latency_ms   INTEGER,
      request_meta TEXT,
      response_meta TEXT,
      called_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Seed default MCP tools if not already present
  await sqlite.execute(`
    INSERT OR IGNORE INTO mcp_tools (name, description, endpoint, price_usd, category, input_schema, output_schema) VALUES
    ('ai_chat', 'Chat with Kai-AI using GPT-4o. Ask any question, get intelligent responses.', '/api/tools/ai-chat', 0.005, 'ai', '{"query": "string", "context": "string?"}', '{"response": "string", "tokens": "number"}'),
    ('market_data', 'Get real-time crypto market data for any token on Base/Ethereum.', '/api/tools/market-data', 0.002, 'blockchain', '{"token": "string", "vs_currency": "string?"}', '{"price": "number", "market_cap": "number", "volume": "number"}'),
    ('base_tx_lookup', 'Look up any transaction on Base blockchain mainnet by hash.', '/api/tools/tx-lookup', 0.001, 'blockchain', '{"tx_hash": "string"}', '{"status": "string", "from": "string", "to": "string", "value": "string"}'),
    ('wallet_balance', 'Check USDC/ETH balance of any wallet on Base mainnet.', '/api/tools/wallet-balance', 0.001, 'blockchain', '{"address": "string", "token": "string?"}', '{"balance": "number", "token": "string"}'),
    ('text_analysis', 'Analyze text for sentiment, entities, and key topics using AI.', '/api/tools/text-analysis', 0.003, 'ai', '{"text": "string", "analysis_type": "string?"}', '{"sentiment": "string", "entities": "array", "topics": "array"}'),
    ('image_caption', 'Generate descriptive captions for images using AI vision.', '/api/tools/image-caption', 0.010, 'ai', '{"image_url": "string"}', '{"caption": "string", "objects": "array", "confidence": "number"}'),
    ('web_search', 'Search the web and return summarized results via AI.', '/api/tools/web-search', 0.005, 'research', '{"query": "string", "num_results": "number?"}', '{"results": "array", "summary": "string"}'),
    ('code_review', 'AI-powered code review: bugs, security, performance suggestions.', '/api/tools/code-review', 0.020, 'ai', '{"code": "string", "language": "string?"}', '{"issues": "array", "suggestions": "array", "score": "number"}')
  `);

  console.log("✅ Kai-AI database migrations completed");
}
