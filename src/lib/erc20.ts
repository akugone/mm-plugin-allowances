import { type Address, formatUnits, getAddress, isAddress, maxUint256, parseAbiItem } from "viem";
import { CommandError } from "@metamask/agent-wallet/plugin";

export const approvalEvent = parseAbiItem(
  "event Approval(address indexed owner, address indexed spender, uint256 value)"
);

export const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
] as const;

/** Anything at or above 2^255 is treated as an unlimited approval (covers maxUint256 and "type(uint256).max - 1" styles). */
export const UNLIMITED_THRESHOLD = maxUint256 >> 1n;

export function isUnlimited(value: bigint): boolean {
  return value >= UNLIMITED_THRESHOLD;
}

export function formatAllowance(value: bigint, decimals: number): string {
  return isUnlimited(value) ? "unlimited" : formatUnits(value, decimals);
}

/** Best-effort labels for well-known spenders (lower-cased keys). Purely informational. */
export const SPENDER_LABELS: Record<string, string> = {
  "0x000000000022d473030f116ddee9f6b43ac78ba3": "Uniswap Permit2",
  "0xe592427a0aece92de3edee1f18e0157c05861564": "Uniswap V3 SwapRouter",
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": "Uniswap V3 SwapRouter02",
  "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": "Uniswap Universal Router",
  "0x1111111254eeb25477b68fb85ed929f73a960582": "1inch Aggregation Router v5",
  "0x111111125421ca6dc452d289314280a0f8842a65": "1inch Aggregation Router v6",
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff": "0x Exchange Proxy",
  "0x0000000000000068f116a894984e2db1123eb395": "OpenSea Seaport 1.6",
  "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": "Aave V3 Pool (Ethereum)",
  "0x881d40237659c251811cec9c364ef91dc08d300c": "MetaMask Swaps Router",
  "0x6a000f20005980200259b80c5102003040001068": "ParaSwap Augustus v6.2",
};

export function spenderLabel(spender: string): string | undefined {
  return SPENDER_LABELS[spender.toLowerCase()];
}

export function parseAddress(raw: string | undefined, what: string): Address {
  const value = (raw ?? "").trim();
  if (!isAddress(value)) {
    throw new CommandError("INVALID_EVM_ADDRESS", `${what} '${value}' is not a valid 0x address.`, "Pass a 40-hex-character 0x address (ENS names are not resolved here).");
  }
  return getAddress(value);
}

export function parseChainId(raw: string | undefined): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CommandError("INVALID_CHAIN", `'${raw}' is not a valid EVM chain id.`, "Use a positive integer such as 1 (Ethereum) or 8453 (Base). Run `mm chains list` to see options.");
  }
  return n;
}

export function parseBigInt(raw: string | undefined, what: string, fallback: bigint): bigint {
  const value = (raw ?? "").trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new CommandError("INVALID_INPUT", `${what} must be a non-negative integer.`, `Got '${value}'.`);
  }
  return BigInt(value);
}

/** Active wallet address from the host's local wallet snapshot, unless the user passed one explicitly. */
export function resolveOwner(ctx: { walletStateManager: { read(): { byokWallets: { address: string }[]; remoteWallets: { address: string }[] } } }, explicit?: string): Address {
  if (explicit && explicit.trim()) return parseAddress(explicit, "address");
  const state = ctx.walletStateManager.read();
  const first = [...state.byokWallets, ...state.remoteWallets][0]?.address;
  if (!first) {
    throw new CommandError("WALLET_NOT_FOUND", "No active wallet found.", "Run `mm init` / `mm wallet create`, or pass --address.");
  }
  return parseAddress(first, "active wallet address");
}
