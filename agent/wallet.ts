/**
 * Kai-AI Wallet Manager
 * Manages the agent's Base blockchain wallet for receiving x402 payments.
 * Uses viem for on-chain reads. Private key is stored as an env var.
 */
import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

// Base Mainnet config
export const BASE_MAINNET = {
  chainId: 8453,
  name: "Base",
  network: "base",
  caip2: "eip155:8453",
  rpcUrl: "https://mainnet.base.org",
  blockExplorer: "https://basescan.org",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
  weth: "0x4200000000000000000000000000000000000006",
};

// ERC-20 ABI for balance checks
const ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
];

export interface WalletInfo {
  address: string;
  label: string;
  network: string;
  balanceETH: string;
  balanceUSDC: string;
  lastSynced: string;
  explorerUrl: string;
}

export async function getAgentWalletAddress(): Promise<string> {
  const address = Deno.env.get("AGENT_WALLET_ADDRESS");
  if (!address) {
    // Return a placeholder for demo mode
    return "0x0000000000000000000000000000000000000000";
  }
  return address;
}

export async function getWalletBalance(address: string): Promise<{
  eth: string;
  usdc: string;
}> {
  try {
    // Fetch ETH balance via Base RPC
    const ethResp = await fetch(BASE_MAINNET.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBalance",
        params: [address, "latest"],
      }),
    });
    const ethData = await ethResp.json();
    const ethBalanceWei = ethData.result
      ? BigInt(ethData.result)
      : BigInt(0);
    const ethBalance = (Number(ethBalanceWei) / 1e18).toFixed(6);

    // Fetch USDC balance
    const usdcCalldata = `0x70a08231000000000000000000000000${address.slice(2).toLowerCase().padStart(64, "0")}`;
    const usdcResp = await fetch(BASE_MAINNET.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "eth_call",
        params: [{ to: BASE_MAINNET.usdc, data: usdcCalldata }, "latest"],
      }),
    });
    const usdcData = await usdcResp.json();
    const usdcBalanceRaw = usdcData.result
      ? BigInt(usdcData.result)
      : BigInt(0);
    const usdcBalance = (Number(usdcBalanceRaw) / 1e6).toFixed(4);

    return { eth: ethBalance, usdc: usdcBalance };
  } catch (e) {
    console.error("Wallet balance fetch error:", e);
    return { eth: "0.000000", usdc: "0.0000" };
  }
}

export async function getFullWalletInfo(): Promise<WalletInfo> {
  const address = await getAgentWalletAddress();
  const { eth, usdc } = await getWalletBalance(address);

  // Update in DB
  await sqlite.execute({
    sql: `INSERT INTO agent_wallet (address, label, network, balance_usdc, last_synced)
          VALUES (?, 'Kai-AI Main Wallet', 'base', ?, datetime('now'))
          ON CONFLICT(address) DO UPDATE SET balance_usdc=excluded.balance_usdc, last_synced=excluded.last_synced`,
    args: [address, parseFloat(usdc)],
  });

  return {
    address,
    label: "Kai-AI Main Wallet",
    network: "Base Mainnet",
    balanceETH: eth,
    balanceUSDC: usdc,
    lastSynced: new Date().toISOString(),
    explorerUrl: `${BASE_MAINNET.blockExplorer}/address/${address}`,
  };
}

export async function lookupTransaction(txHash: string) {
  try {
    const resp = await fetch(BASE_MAINNET.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionByHash",
        params: [txHash],
      }),
    });
    const data = await resp.json();
    const tx = data.result;
    if (!tx) return null;

    // Get receipt for status
    const receiptResp = await fetch(BASE_MAINNET.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "eth_getTransactionReceipt",
        params: [txHash],
      }),
    });
    const receiptData = await receiptResp.json();
    const receipt = receiptData.result;

    return {
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      value: (Number(BigInt(tx.value || "0x0")) / 1e18).toFixed(8) + " ETH",
      gasUsed: receipt?.gasUsed
        ? parseInt(receipt.gasUsed, 16).toString()
        : "unknown",
      status: receipt?.status === "0x1" ? "success" : receipt?.status === "0x0" ? "failed" : "pending",
      blockNumber: tx.blockNumber ? parseInt(tx.blockNumber, 16) : null,
      explorerUrl: `${BASE_MAINNET.blockExplorer}/tx/${txHash}`,
    };
  } catch (e) {
    console.error("TX lookup error:", e);
    return null;
  }
}
