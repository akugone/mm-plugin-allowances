import { describe, expect, it } from "vitest";
import { decodeFunctionData, keccak256, maxUint256, pad, toBytes } from "viem";
import { expectedUnlimitedNote, PERMIT2_ADDRESS, spenderLabel } from "../src/lib/erc20";
import {
  describeExpiration,
  encodeLockdown,
  formatPermit2Amount,
  isUnlimitedPermit2,
  parsePairs,
  permit2Abi,
  permit2OwnerTopics,
  UNLIMITED_UINT160_THRESHOLD,
} from "../src/lib/permit2";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const UNIVERSAL_ROUTER = "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";
const OWNER = "0x" + "ab".repeat(20);
const MAX_UINT160 = (1n << 160n) - 1n;

describe("expected unlimited spenders", () => {
  it("marks the canonical Permit2 as expected, on any chain, in any case", () => {
    expect(expectedUnlimitedNote(PERMIT2_ADDRESS)).toMatch(/Permit2/);
    expect(expectedUnlimitedNote(PERMIT2_ADDRESS.toLowerCase())).toMatch(/unlimited by design/);
    expect(spenderLabel(PERMIT2_ADDRESS, 42161)).toBe("Uniswap Permit2");
  });
  it("leaves ordinary spenders alone", () => {
    expect(expectedUnlimitedNote(UNIVERSAL_ROUTER)).toBeUndefined();
    expect(expectedUnlimitedNote("0x" + "00".repeat(20))).toBeUndefined();
  });
});

describe("Permit2 amounts (uint160)", () => {
  it("treats type(uint160).max and anything at or above 2^159 as unlimited", () => {
    expect(UNLIMITED_UINT160_THRESHOLD).toBe(1n << 159n);
    expect(isUnlimitedPermit2(MAX_UINT160)).toBe(true);
    expect(isUnlimitedPermit2(1n << 159n)).toBe(true);
    expect(isUnlimitedPermit2((1n << 159n) - 1n)).toBe(false);
    expect(isUnlimitedPermit2(5_000_000n)).toBe(false);
    // An ERC-20 style maxUint256 never reaches Permit2 storage, but the helper must not choke on it.
    expect(isUnlimitedPermit2(maxUint256)).toBe(true);
  });
  it("formats with the token decimals", () => {
    expect(formatPermit2Amount(5_000_000n, 6)).toBe("5");
    expect(formatPermit2Amount(MAX_UINT160, 18)).toBe("unlimited");
    expect(formatPermit2Amount(0n, 6)).toBe("0");
  });
});

describe("Permit2 expiration", () => {
  const now = 1_757_900_000; // 2025-09-15T02:13:20Z
  it("reports a past timestamp as expired", () => {
    const info = describeExpiration(BigInt(now - 60), now);
    expect(info.expired).toBe(true);
    expect(info.expiresAt).toBe(new Date((now - 60) * 1000).toISOString());
    expect(info.expiration).toBe(String(now - 60));
  });
  it("reports a future timestamp as live, with an ISO date", () => {
    const in30d = now + 30 * 86_400;
    const info = describeExpiration(BigInt(in30d), now);
    expect(info.expired).toBe(false);
    expect(info.expiresAt).toBe(new Date(in30d * 1000).toISOString());
  });
  it("treats the exact expiration second as still valid (Permit2 rejects only block.timestamp > expiration)", () => {
    expect(describeExpiration(BigInt(now), now).expired).toBe(false);
  });
  it("reports uint48 max (and anything beyond a century) as never", () => {
    const maxUint48 = (1n << 48n) - 1n;
    expect(describeExpiration(maxUint48, now)).toMatchObject({ expired: false, expiresAt: "never" });
    expect(describeExpiration(BigInt(now + 101 * 365 * 86_400), now).expiresAt).toBe("never");
    expect(describeExpiration(BigInt(now + 10 * 365 * 86_400), now).expiresAt).not.toBe("never");
  });
  it("treats expiration 0 (stored by one-block permits) as expired", () => {
    expect(describeExpiration(0n, now).expired).toBe(true);
  });
});

describe("Permit2 event topics", () => {
  it("selects Approval and Permit emitted for the owner", () => {
    const [selectors, ownerTopic] = permit2OwnerTopics(OWNER as `0x${string}`);
    expect(selectors).toEqual([
      keccak256(toBytes("Approval(address,address,address,uint160,uint48)")),
      keccak256(toBytes("Permit(address,address,address,uint160,uint48,uint48)")),
    ]);
    expect(ownerTopic).toBe(pad(OWNER as `0x${string}`, { size: 32 }).toLowerCase());
  });
  it("does not collide with the ERC-20 Approval selector", () => {
    const [selectors] = permit2OwnerTopics(OWNER as `0x${string}`);
    expect(selectors).not.toContain(keccak256(toBytes("Approval(address,address,uint256)")));
  });
});

describe("revoke pairs", () => {
  it("zips equal-length lists, checksums and de-duplicates", () => {
    const pairs = parsePairs(` ${USDC.toLowerCase()}, ${WETH}, ${USDC}`, `${UNIVERSAL_ROUTER},${UNIVERSAL_ROUTER.toLowerCase()},${UNIVERSAL_ROUTER}`);
    expect(pairs).toEqual([
      { token: USDC, spender: UNIVERSAL_ROUTER },
      { token: WETH, spender: UNIVERSAL_ROUTER },
    ]);
  });
  it("accepts a single pair", () => {
    expect(parsePairs(USDC, UNIVERSAL_ROUTER)).toEqual([{ token: USDC, spender: UNIVERSAL_ROUTER }]);
  });
  it("rejects mismatched lengths, empty lists and bad addresses", () => {
    expect(() => parsePairs(`${USDC},${WETH}`, UNIVERSAL_ROUTER)).toThrow(/lists 2 addresses but --spender lists 1/);
    expect(() => parsePairs("", UNIVERSAL_ROUTER)).toThrow(/at least one/);
    expect(() => parsePairs(USDC, undefined)).toThrow(/at least one/);
    expect(() => parsePairs("0x123", UNIVERSAL_ROUTER)).toThrow(/not a valid 0x address/);
  });
});

describe("lockdown calldata", () => {
  it("encodes Permit2.lockdown with every pair, in order", () => {
    const data = encodeLockdown([
      { token: USDC, spender: UNIVERSAL_ROUTER },
      { token: WETH.toLowerCase() as `0x${string}`, spender: UNIVERSAL_ROUTER },
    ]);
    expect(data.slice(0, 10)).toBe(keccak256(toBytes("lockdown((address,address)[])")).slice(0, 10));
    const decoded = decodeFunctionData({ abi: permit2Abi, data });
    expect(decoded.functionName).toBe("lockdown");
    expect(decoded.args).toEqual([
      [
        { token: USDC, spender: UNIVERSAL_ROUTER },
        { token: WETH, spender: UNIVERSAL_ROUTER },
      ],
    ]);
  });
});
