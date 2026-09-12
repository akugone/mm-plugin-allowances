import { CommandError } from "@metamask/agent-wallet/plugin";
import { parseGwei } from "viem";
import { parseChainId } from "./erc20.js";

/** Approximate seconds per block, used to turn --lookback-days into a block window. Unknown chains assume 12 s. */
export const BLOCK_SECONDS: Record<number, number> = {
  1: 12, 11155111: 12,            // Ethereum, Sepolia
  8453: 2, 84532: 2,              // Base, Base Sepolia
  10: 2, 59144: 2, 43114: 2,      // Optimism, Linea, Avalanche
  137: 2, 80002: 2,               // Polygon, Amoy
  56: 1.5,                        // BNB Chain
  42161: 0.25, 421614: 0.25,      // Arbitrum One, Arbitrum Sepolia
  324: 1,                         // zkSync Era
};

export const DEFAULT_LOOKBACK_DAYS = 30;
export const MAX_LOOKBACK_DAYS = 3650;

export function blocksForDays(chainId: number, days: number): bigint {
  const perBlock = BLOCK_SECONDS[chainId] ?? 12;
  return BigInt(Math.ceil((days * 86_400) / perBlock));
}

export function parseDays(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_LOOKBACK_DAYS;
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0 || days > MAX_LOOKBACK_DAYS) {
    throw new CommandError("INVALID_INPUT", `lookback-days must be a positive number of days (max ${MAX_LOOKBACK_DAYS}).`, `Got '${value}'.`);
  }
  return days;
}

/** Union of --chain-ids (comma list) and --chain-id, de-duplicated, order preserved. */
export function parseChainIds(list: string | undefined, single: string | undefined): number[] {
  const raw = [...(list ?? "").split(","), single ?? ""].map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) {
    throw new CommandError("MISSING_CHAIN_ID", "Give at least one chain id.", "Use --chain-ids 1,8453 or --chain-id 1. Run `mm chains list` to see options.");
  }
  return [...new Set(raw.map(parseChainId))];
}

const GWEI_RE = /^\d+(\.\d{1,9})?$/;

export function parseGweiFlag(raw: string | undefined, what: string): bigint | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  if (!GWEI_RE.test(value) || Number(value) <= 0) {
    throw new CommandError("INVALID_INPUT", `${what} must be a positive number of gwei, e.g. 5 or 1.5.`, `Got '${value}'.`);
  }
  return parseGwei(value);
}
