import { type Address, encodeEventTopics, encodeFunctionData, formatUnits, getAddress, type Hex, parseAbi } from "viem";
import { CommandError } from "@metamask/agent-wallet/plugin";
import { clampDecimals, parseAddress, PERMIT2_ADDRESS } from "./erc20.js";

/**
 * Uniswap Permit2 (deterministic deployment, same address on every chain).
 * Allowance model: the wallet gives Permit2 one unlimited ERC-20 approval per token, then each app
 * receives its own (amount, expiration, nonce) allowance inside Permit2 through a signature. The ERC-20
 * approval is expected; the Permit2-internal allowances are where the real exposure lives.
 */
export const permit2Abi = parseAbi([
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function lockdown((address token, address spender)[] approvals)",
  "event Approval(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration)",
  "event Permit(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration, uint48 nonce)",
  "event Lockdown(address indexed owner, address token, address spender)",
]);

/** Permit2 amounts are uint160; anything at or above 2^159 is treated as unlimited (covers type(uint160).max). */
export const UNLIMITED_UINT160_THRESHOLD = 1n << 159n;

export function isUnlimitedPermit2(amount: bigint): boolean {
  return amount >= UNLIMITED_UINT160_THRESHOLD;
}

export function formatPermit2Amount(amount: bigint, decimals: number): string {
  return isUnlimitedPermit2(amount) ? "unlimited" : formatUnits(amount, clampDecimals(decimals));
}

/** Beyond this many seconds from now, an expiration is reported as "never" (uint48 max is year ~8.9 million). */
const NEVER_HORIZON_SECONDS = 100 * 365 * 86_400;

export type ExpirationInfo = { expiration: string; expiresAt: string; expired: boolean };

/**
 * Permit2 stores `expiration` as a unix timestamp and rejects transfers once `block.timestamp > expiration`.
 * `expiresAt` is ISO-8601, or "never" for a horizon beyond a century (Uniswap's default is 30 days).
 */
export function describeExpiration(expiration: bigint, nowSeconds: number = Math.floor(Date.now() / 1000)): ExpirationInfo {
  const expired = BigInt(nowSeconds) > expiration;
  const far = expiration > BigInt(nowSeconds + NEVER_HORIZON_SECONDS);
  const expiresAt = far ? "never" : new Date(Number(expiration) * 1000).toISOString();
  return { expiration: expiration.toString(), expiresAt, expired };
}

/** eth_getLogs topics selecting Permit2 `Approval` and `Permit` events emitted for `owner` (first indexed arg of both). */
export function permit2OwnerTopics(owner: Address): [[Hex, Hex], Hex] {
  const [approvalTopic, ownerTopic] = encodeEventTopics({ abi: permit2Abi, eventName: "Approval", args: { owner } });
  const [permitTopic] = encodeEventTopics({ abi: permit2Abi, eventName: "Permit", args: { owner } });
  return [[approvalTopic, permitTopic], ownerTopic as Hex];
}

export type TokenSpenderPair = { token: Address; spender: Address };

/**
 * Revoke pairs for `--permit2`: `--token` and `--spender` may be comma-separated lists of equal length,
 * matched position by position. Duplicates are dropped, order preserved.
 */
export function parsePairs(tokens: string | undefined, spenders: string | undefined): TokenSpenderPair[] {
  const split = (raw: string | undefined) => (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const t = split(tokens);
  const s = split(spenders);
  if (t.length === 0 || s.length === 0) {
    throw new CommandError("INVALID_INPUT", "Give at least one --token and one --spender.", "With --permit2 both may be comma-separated lists of the same length.");
  }
  if (t.length !== s.length) {
    throw new CommandError("INVALID_INPUT", `--token lists ${t.length} address${t.length === 1 ? "" : "es"} but --spender lists ${s.length}.`, "Give one spender per token, in the same order (e.g. --token A,B --spender X,Y).");
  }
  const seen = new Set<string>();
  const pairs: TokenSpenderPair[] = [];
  t.forEach((rawToken, i) => {
    const pair = { token: parseAddress(rawToken, "token"), spender: parseAddress(s[i], "spender") };
    const key = `${pair.token.toLowerCase()}|${pair.spender.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push(pair);
  });
  return pairs;
}

/** Calldata for `Permit2.lockdown(pairs)`: zeroes every listed allowance in one transaction (what revoke.cash sends). */
export function encodeLockdown(pairs: TokenSpenderPair[]): Hex {
  return encodeFunctionData({
    abi: permit2Abi,
    functionName: "lockdown",
    args: [pairs.map((p) => ({ token: getAddress(p.token), spender: getAddress(p.spender) }))],
  });
}

export { PERMIT2_ADDRESS };
