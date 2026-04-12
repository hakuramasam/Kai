/**
 * Kai-AI MCP Server (Model Context Protocol)
 * Exposes Kai-AI tools as an MCP-compatible server so other AI agents
 * (Claude, GPT, etc.) can discover and call paid tools via MCP+x402.
 *
 * MCP Spec: https://spec.modelcontextprotocol.io/
 * Tools are gated behind x402 payment requirements.
 */
import { Hono } from "npm:hono@4";
import { getAvailableTools } from "./core.ts";
import {
  callThirdwebTool,
  getCachedThirdwebToolNames,
  getThirdwebGasSurchargeMultiplier,
  getThirdwebProxyPriceUsd,
  getThirdwebToolPriceUsd,
  invalidateThirdwebToolNameCache,
  isThirdwebGasSurchargeTool,
  isThirdwebMcpConfigured,
  isThirdwebToolFree,
  listThirdwebMcpTools,
  thirdwebProxyServiceId,
  thirdwebX402ResourcePath,
} from "./thirdwebMcpClient.ts";
import {
  buildPaymentAccepts,
  KAI_HUMAN_PER_USDC,
  logServiceCall,
  trackA2AAgent,
  verifyX402Payment,
} from "../payments/verifier.ts";

export const mcpRouter = new Hono();

async function isThirdwebToolName(name: string): Promise<boolean> {
  if (!isThirdwebMcpConfigured()) return false;
  if ((await getCachedThirdwebToolNames()).has(name)) return true;
  invalidateThirdwebToolNameCache();
  return (await getCachedThirdwebToolNames()).has(name);
}

function normalizeThirdwebInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema && typeof schema === "object" && (schema as { type?: string }).type === "object") {
    return schema;
  }
  return { type: "object", properties: {} };
}

// ── MCP Discovery ─────────────────────────────────────────────────────────

/**
 * GET /mcp — MCP server info and capabilities.
 */
mcpRouter.get("/", async (c) => {
  const tools = await getAvailableTools();
  return c.json({
    jsonrpc: "2.0",
    result: {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: { listChanged: false },
        resources: {},
        prompts: {},
      },
      serverInfo: {
        name: "Kai-AI MCP Server",
        version: "1.0.0",
        description: "Autonomous AI agent tools via MCP + x402 payments on Base Mainnet",
        homepage: "/",
        paymentProtocol: "x402",
        paymentNetwork: "eip155:8453",
        thirdwebProxy: isThirdwebMcpConfigured(),
      },
    },
  });
});

/**
 * POST /mcp — JSON-RPC 2.0 MCP handler.
 * Supports: initialize, tools/list, tools/call
 */
mcpRouter.post("/", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }

  const { method, params, id } = body;

  try {
    switch (method) {
      case "initialize":
        return c.json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: { listChanged: false },
            },
            serverInfo: {
              name: "Kai-AI MCP Server",
              version: "1.0.0",
              thirdwebProxy: isThirdwebMcpConfigured(),
            },
          },
        });

      case "tools/list": {
        const tools = await getAvailableTools();
        const kaiMapped = tools.map((t: any) => ({
          name: t.name,
          description: `${t.description} [Price: $${t.price_usd} USDC via x402 on Base Mainnet]`,
          inputSchema: {
            type: "object",
            properties: parseSchemaToProperties(t.input_schema),
            required: getRequiredFields(t.input_schema),
          },
          annotations: {
            x402: {
              price: t.price_usd,
              network: "eip155:8453",
              token: "USDC",
              paymentEndpoint: `/api/tools/${t.name.replace(/_/g, "-")}`,
            },
          },
        }));

        let thirdwebMapped: Array<{
          name: string;
          description: string;
          inputSchema: Record<string, unknown>;
          annotations: Record<string, unknown>;
        }> = [];

        if (isThirdwebMcpConfigured()) {
          try {
            const tw = await listThirdwebMcpTools();
            const baseUsd = getThirdwebProxyPriceUsd();
            thirdwebMapped = tw.map((t) => {
              const free = isThirdwebToolFree(t.name);
              const toolPrice = getThirdwebToolPriceUsd(t.name);
              const gasHeavy = !free && isThirdwebGasSurchargeTool(t.name);
              const baseDesc = t.description ?? "thirdweb tool";
              const desc = free
                ? `${baseDesc} [thirdweb MCP — free on Kai (x402 waived); upstream usage uses deployment THIRDWEB_SECRET_KEY]`
                : gasHeavy
                ? `${baseDesc} [thirdweb MCP + $${toolPrice} USDC x402 on Kai: $${baseUsd} base × ${getThirdwebGasSurchargeMultiplier()} gas/on-chain contract surcharge; pay via X-PAYMENT on POST /mcp]`
                : `${baseDesc} [thirdweb MCP + $${toolPrice} USDC x402 on Kai per call; pay via X-PAYMENT on POST /mcp]`;
              const annotations: Record<string, unknown> = {
                ...(typeof t.annotations === "object" && t.annotations ? t.annotations : {}),
                thirdwebProxied: true,
              };
              if (free) {
                annotations.kaiX402 = "waived";
              } else {
                annotations.x402 = {
                  price: toolPrice,
                  basePrice: baseUsd,
                  gasSurcharge: gasHeavy
                    ? {
                      multiplier: getThirdwebGasSurchargeMultiplier(),
                      note:
                        "USDC on Base; surcharge approximates extra cost for contract creation/interaction vs reads",
                    }
                    : undefined,
                  network: "eip155:8453",
                  acceptsAssets: ["USDC", "KAI"],
                  kaiPerUsdc: Number(KAI_HUMAN_PER_USDC),
                  resource: thirdwebX402ResourcePath(t.name),
                  note:
                    "Pay with X-PAYMENT on POST /mcp — USDC or KAI (1 USDC = 100,000 KAI on Base)",
                };
              }
              return {
                name: t.name,
                description: desc,
                inputSchema: normalizeThirdwebInputSchema(t.inputSchema),
                annotations,
              };
            });
          } catch (twErr) {
            console.error("thirdweb MCP tools/list:", twErr);
          }
        }

        return c.json({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [...kaiMapped, ...thirdwebMapped],
          },
        });
      }

      case "tools/call": {
        const { name, arguments: args } = params || {};
        if (!name) {
          return c.json({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Missing tool name" },
          });
        }

        const { sqlite } = await import("https://esm.town/v/std/sqlite/main.ts");
        const toolResult = await sqlite.execute({
          sql: "SELECT * FROM mcp_tools WHERE name = ?",
          args: [name],
        });
        const kaiTool = toolResult.rows[0] as any;

        // thirdweb-proxied tools (not in mcp_tools): optional Kai x402 except free tools (e.g. `chat`)
        if (!kaiTool && (await isThirdwebToolName(name))) {
          const caller = c.req.header("X-Agent-Address") ||
            c.req.header("X-Forwarded-For") ||
            "anonymous";

          if (isThirdwebToolFree(name)) {
            try {
              const twResult = await callThirdwebTool(name, args || {});
              await logServiceCall({
                caller,
                callerType: c.req.header("X-Agent-Address") ? "agent" : "unknown",
                service: thirdwebProxyServiceId(name),
                status: "success",
                requestMeta: { thirdwebFree: true },
              });
              return c.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: twResult.content,
                  isError: twResult.isError ?? false,
                },
              });
            } catch (twErr) {
              return c.json({
                jsonrpc: "2.0",
                id,
                error: { code: -32603, message: String(twErr) },
              });
            }
          }

          const priceUsd = getThirdwebToolPriceUsd(name);
          const endpoint = thirdwebX402ResourcePath(name);
          const service = thirdwebProxyServiceId(name);
          const paymentHeader = c.req.header("X-PAYMENT");

          if (!paymentHeader) {
            const accepts = await buildPaymentAccepts({
              price: priceUsd,
              service,
              endpoint,
              description: isThirdwebGasSurchargeTool(name)
                ? `thirdweb MCP: ${name} (base × ${getThirdwebGasSurchargeMultiplier()} gas/contract surcharge)`
                : `thirdweb MCP tool: ${name}`,
            });
            await logServiceCall({
              caller,
              callerType: c.req.header("X-Agent-Address") ? "agent" : "unknown",
              service,
              status: "payment_required",
            });
            return c.json({
              jsonrpc: "2.0",
              id,
              error: {
                code: 402,
                message: "Payment Required",
                data: {
                  x402Version: 1,
                  accepts,
                  error:
                    `X-PAYMENT required for "${name}" ($${priceUsd} equivalent: USDC or KAI 1:100000 on Base).`,
                },
              },
            });
          }

          const verification = await verifyX402Payment(
            paymentHeader,
            priceUsd,
            service,
            endpoint,
          );

          if (!verification.verified) {
            return c.json({
              jsonrpc: "2.0",
              id,
              error: {
                code: 402,
                message: "Payment verification failed",
                data: {
                  x402Version: 1,
                  reason: verification.error,
                },
              },
            });
          }

          const agentAddress = c.req.header("X-Agent-Address");
          if (agentAddress) {
            await trackA2AAgent({
              address: agentAddress,
              name: c.req.header("X-Agent-Name") || undefined,
              url: c.req.header("X-Agent-URL") || undefined,
              amountPaid: priceUsd,
            });
          }

          try {
            const twResult = await callThirdwebTool(name, args || {});
            await logServiceCall({
              caller,
              callerType: agentAddress ? "agent" : "unknown",
              service,
              status: "success",
              requestMeta: { thirdwebProxied: true, x402: true },
            });
            return c.json({
              jsonrpc: "2.0",
              id,
              result: {
                content: twResult.content,
                isError: twResult.isError ?? false,
              },
            });
          } catch (twErr) {
            return c.json({
              jsonrpc: "2.0",
              id,
              error: { code: -32603, message: String(twErr) },
            });
          }
        }

        if (!kaiTool) {
          return c.json({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Tool '${name}' not found` },
          });
        }

        // Kai native tools — MCP calls require payment header or return x402 instructions
        const paymentHeader = c.req.header("X-PAYMENT");
        const kaiEndpoint = `/api/tools/${name.replace(/_/g, "-")}`;
        if (!paymentHeader) {
          const accepts = await buildPaymentAccepts({
            price: kaiTool.price_usd,
            service: name,
            endpoint: kaiEndpoint,
            description: kaiTool.description,
          });
          return c.json({
            jsonrpc: "2.0",
            id,
            error: {
              code: 402,
              message: "Payment Required",
              data: {
                x402Version: 1,
                accepts,
                error:
                  "X-PAYMENT required (USDC or KAI on Base; 1 USDC = 100,000 KAI).",
              },
            },
          });
        }

        const verification = await verifyX402Payment(
          paymentHeader,
          kaiTool.price_usd,
          name,
          kaiEndpoint,
        );
        if (!verification.verified) {
          return c.json({
            jsonrpc: "2.0",
            id,
            error: {
              code: 402,
              message: verification.error || "Payment verification failed",
              data: { x402Version: 1 },
            },
          });
        }

        const { executeTool } = await import("./core.ts");
        const result = await executeTool(name, args || {});

        if (!result.success) {
          return c.json({
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: result.error || "Tool execution failed" },
          });
        }

        return c.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result.data, null, 2),
              },
            ],
            isError: false,
          },
        });
      }

      default:
        return c.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
    }
  } catch (err) {
    console.error("MCP error:", err);
    return c.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: "Internal error", data: String(err) },
    });
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseSchemaToProperties(schemaStr: string | null): Record<string, any> {
  if (!schemaStr) return {};
  try {
    const schema = JSON.parse(schemaStr);
    const props: Record<string, any> = {};
    for (const [key, type] of Object.entries(schema)) {
      const t = String(type);
      const optional = t.endsWith("?");
      const baseType = t.replace("?", "");
      props[key] = {
        type: baseType === "number" ? "number" : baseType === "array" ? "array" : "string",
        description: `${key} (${optional ? "optional" : "required"})`,
      };
    }
    return props;
  } catch {
    return {};
  }
}

function getRequiredFields(schemaStr: string | null): string[] {
  if (!schemaStr) return [];
  try {
    const schema = JSON.parse(schemaStr);
    return Object.entries(schema)
      .filter(([_, type]) => !String(type).endsWith("?"))
      .map(([key]) => key);
  } catch {
    return [];
  }
}
