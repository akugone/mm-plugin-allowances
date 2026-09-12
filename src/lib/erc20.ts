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
export const UNLIMITED_THRESHOLD = 1n << 255n;

export function isUnlimited(value: bigint): boolean {
  return value >= UNLIMITED_THRESHOLD;
}

/** Token contracts control `decimals()`; keep the value in a range formatUnits handles sensibly. */
export function clampDecimals(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 36 ? n : 18;
}

export function formatAllowance(value: bigint, decimals: number): string {
  return isUnlimited(value) ? "unlimited" : formatUnits(value, clampDecimals(decimals));
}

const MAX_SYMBOL_LENGTH = 24;

/**
 * Token contracts control `symbol()`. Strip control characters (terminal escape sequences included),
 * collapse whitespace and cap the length so a hostile token cannot inject text into the terminal or
 * an agent's context. Returns "?" for an empty or unusable value.
 */
export function sanitizeSymbol(raw: unknown): string {
  if (typeof raw !== "string") return "?";
  const cleaned = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "?";
  return cleaned.length > MAX_SYMBOL_LENGTH ? `${cleaned.slice(0, MAX_SYMBOL_LENGTH - 1)}…` : cleaned;
}

/** Contracts deployed at the same address on every chain (deterministic deployments). Lower-cased keys. */
export const SPENDER_LABELS: Record<string, string> = {
  "0x000000000022d473030f116ddee9f6b43ac78ba3": "Uniswap Permit2",
  "0x0000000000000068f116a894984e2db1123eb395": "OpenSea Seaport 1.6",
  "0x1111111254eeb25477b68fb85ed929f73a960582": "1inch Aggregation Router v5",
  "0x111111125421ca6dc452d289314280a0f8842a65": "1inch Aggregation Router v6",
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff": "0x Exchange Proxy",
  "0x6a000f20005980200259b80c5102003040001068": "ParaSwap Augustus v6.2",
};

const UNISWAP_V3_ROUTERS: Record<string, string> = {
  "0xe592427a0aece92de3edee1f18e0157c05861564": "Uniswap V3 SwapRouter",
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": "Uniswap V3 SwapRouter02",
};

/** Chain-specific deployments. Lower-cased keys. Informational only. */
export const CHAIN_SPENDER_LABELS: Record<number, Record<string, string>> = {
  1: {
    ...UNISWAP_V3_ROUTERS,
    "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": "Uniswap Universal Router",
    "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": "Aave V3 Pool",
    "0x881d40237659c251811cec9c364ef91dc08d300c": "MetaMask Swaps Router",
  },
  10: { ...UNISWAP_V3_ROUTERS },
  42161: { ...UNISWAP_V3_ROUTERS },
  137: { ...UNISWAP_V3_ROUTERS },
  8453: {
    "0x2626664c2603336e57b271c5c0b26f421741e481": "Uniswap V3 SwapRouter02",
    "0x6ff5693b99212da76ad316178a184ab56d299b43": "Uniswap Universal Router",
  },
};

export function spenderLabel(spender: string, chainId?: number): string | undefined {
  const key = spender.toLowerCase();
  return SPENDER_LABELS[key] ?? (chainId !== undefined ? CHAIN_SPENDER_LABELS[chainId]?.[key] : undefined);
}

export function parseAddress(raw: string | undefined, what: string): Address {
  const value = (raw ?? "").trim();
  if (!isAddress(value)) {
    throw new CommandError("INVALID_EVM_ADDRESS", `${what} '${value}' is not a valid 0x address.`, "Pass a 40-hex-character 0x address (ENS names are not resolved here).");
  }
  return getAddress(value);
}

export function parseChainId(raw: string | undefined): number {
  const text = (raw ?? "").trim();
  const n = Number.parseInt(text, 10);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== text) {
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

/** Minimal view of the host's wallet snapshot the plugin relies on. */
export type WalletLike = { address: string; name?: string; id?: string; walletId?: string | null };
export type WalletRefLike = { address?: string; id?: string; name?: string };
export type WalletStateLike = {
  byokWallets: WalletLike[];
  remoteWallets: WalletLike[];
  selectedWallet?: { ref: WalletRefLike } | null;
};

/** The wallet `mm` will sign with: the selected one when the snapshot records it, else the first known wallet. */
export function pickActiveWallet(state: WalletStateLike): WalletLike | undefined {
  const wallets = [...state.byokWallets, ...state.remoteWallets];
  const ref = state.selectedWallet?.ref;
  if (ref) {
    const match = wallets.find((w) =>
      (ref.address !== undefined && w.address.toLowerCase() === ref.address.toLowerCase()) ||
      (ref.id !== undefined && (w.id === ref.id || w.walletId === ref.id)) ||
      (ref.name !== undefined && w.name === ref.name)
    );
    if (match) return match;
  }
  return wallets[0];
}

/** Active wallet address from the host's local wallet snapshot, unless the user passed one explicitly. */
export function resolveOwner(ctx: { walletStateManager: { read(): WalletStateLike } }, explicit?: string): Address {
  if (explicit && explicit.trim()) return parseAddress(explicit, "address");
  const active = pickActiveWallet(ctx.walletStateManager.read());
  if (!active?.address) {
    throw new CommandError("WALLET_NOT_FOUND", "No active wallet found.", "Run `mm init` / `mm wallet create`, or pass --address.");
  }
  return parseAddress(active.address, "active wallet address");
}
