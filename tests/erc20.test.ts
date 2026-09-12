import { describe, expect, it } from "vitest";
import { maxUint256 } from "viem";
import {
  clampDecimals,
  formatAllowance,
  isUnlimited,
  parseAddress,
  parseBigInt,
  parseChainId,
  pickActiveWallet,
  resolveOwner,
  sanitizeSymbol,
  spenderLabel,
} from "../src/lib/erc20";

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

describe("unlimited detection and formatting", () => {
  it("treats maxUint256 and anything at or above 2^255 as unlimited", () => {
    expect(isUnlimited(maxUint256)).toBe(true);
    expect(isUnlimited(maxUint256 - 1n)).toBe(true);
    expect(isUnlimited(2n ** 255n)).toBe(true);
    expect(isUnlimited(2n ** 255n - 1n)).toBe(false);
    expect(isUnlimited(5_000_000n)).toBe(false);
  });
  it("formats with the token decimals", () => {
    expect(formatAllowance(5_000_000n, 6)).toBe("5");
    expect(formatAllowance(1_500_000_000_000_000_000n, 18)).toBe("1.5");
    expect(formatAllowance(maxUint256, 18)).toBe("unlimited");
    expect(formatAllowance(0n, 6)).toBe("0");
  });
  it("clamps hostile decimals", () => {
    expect(clampDecimals(6)).toBe(6);
    expect(clampDecimals(255)).toBe(18);
    expect(clampDecimals(-1)).toBe(18);
    expect(clampDecimals("abc")).toBe(18);
  });
});

describe("sanitizeSymbol", () => {
  it("keeps ordinary symbols", () => {
    expect(sanitizeSymbol("USDC")).toBe("USDC");
    expect(sanitizeSymbol(" WETH ")).toBe("WETH");
  });
  it("strips terminal escape sequences and control characters", () => {
    expect(sanitizeSymbol(`${ESC}[31mUSDC${ESC}[0m`)).toBe("[31mUSDC[0m");
    expect(sanitizeSymbol(`US${NUL}DC\n`)).toBe("USDC");
    expect(sanitizeSymbol(`a${ZERO_WIDTH_SPACE}b`)).toBe("ab");
  });
  it("caps the length and handles junk", () => {
    expect(sanitizeSymbol("X".repeat(100))).toHaveLength(24);
    expect(sanitizeSymbol("")).toBe("?");
    expect(sanitizeSymbol(undefined)).toBe("?");
    expect(sanitizeSymbol(42)).toBe("?");
  });
});

describe("spender labels", () => {
  it("labels deterministic deployments on any chain", () => {
    expect(spenderLabel(PERMIT2, 1)).toBe("Uniswap Permit2");
    expect(spenderLabel(PERMIT2.toLowerCase(), 8453)).toBe("Uniswap Permit2");
    expect(spenderLabel(PERMIT2)).toBe("Uniswap Permit2");
  });
  it("labels chain-specific deployments only on their chain", () => {
    const universalMainnet = "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";
    expect(spenderLabel(universalMainnet, 1)).toBe("Uniswap Universal Router");
    expect(spenderLabel(universalMainnet, 8453)).toBeUndefined();
    expect(spenderLabel(universalMainnet)).toBeUndefined();
  });
  it("returns undefined for unknown spenders", () => {
    expect(spenderLabel("0x" + "ab".repeat(20), 1)).toBeUndefined();
  });
});

describe("input parsing", () => {
  it("checksums valid addresses and rejects the rest", () => {
    expect(parseAddress(PERMIT2.toLowerCase(), "x")).toBe(PERMIT2);
    expect(() => parseAddress("vitalik.eth", "to")).toThrow(/not a valid 0x address/);
    expect(() => parseAddress("0x123", "to")).toThrow();
    expect(() => parseAddress(undefined, "to")).toThrow();
  });
  it("parses chain ids strictly", () => {
    expect(parseChainId("8453")).toBe(8453);
    expect(parseChainId(" 1 ")).toBe(1);
    expect(() => parseChainId("0")).toThrow(/chain id/);
    expect(() => parseChainId("1.5")).toThrow();
    expect(() => parseChainId("8453abc")).toThrow();
    expect(() => parseChainId("")).toThrow();
  });
  it("parses block counts", () => {
    expect(parseBigInt("5000", "x", 1n)).toBe(5000n);
    expect(parseBigInt("", "x", 7n)).toBe(7n);
    expect(() => parseBigInt("-1", "x", 1n)).toThrow(/non-negative integer/);
    expect(() => parseBigInt("1e3", "x", 1n)).toThrow();
  });
});

describe("active wallet resolution", () => {
  const a = { address: "0x" + "aa".repeat(20), name: "Server EVM Wallet 1" };
  const b = { address: "0x" + "bb".repeat(20), name: "Server EVM Wallet 2", walletId: "w-2" };
  it("prefers the selected wallet over the first one", () => {
    expect(pickActiveWallet({ byokWallets: [], remoteWallets: [a, b], selectedWallet: { ref: { address: b.address.toUpperCase().replace("0X", "0x") } } })).toBe(b);
    expect(pickActiveWallet({ byokWallets: [], remoteWallets: [a, b], selectedWallet: { ref: { id: "w-2" } } })).toBe(b);
    expect(pickActiveWallet({ byokWallets: [], remoteWallets: [a, b], selectedWallet: { ref: { name: "Server EVM Wallet 2" } } })).toBe(b);
  });
  it("falls back to the first wallet when nothing is selected or the ref is stale", () => {
    expect(pickActiveWallet({ byokWallets: [], remoteWallets: [a, b] })).toBe(a);
    expect(pickActiveWallet({ byokWallets: [], remoteWallets: [a, b], selectedWallet: { ref: { address: "0x" + "cc".repeat(20) } } })).toBe(a);
  });
  it("resolveOwner honours an explicit address and errors with no wallet", () => {
    const ctx = { walletStateManager: { read: () => ({ byokWallets: [], remoteWallets: [a, b], selectedWallet: { ref: { address: b.address } } }) } };
    expect(resolveOwner(ctx).toLowerCase()).toBe(b.address);
    expect(resolveOwner(ctx, PERMIT2.toLowerCase())).toBe(PERMIT2);
    expect(() => resolveOwner({ walletStateManager: { read: () => ({ byokWallets: [], remoteWallets: [] }) } })).toThrow(/No active wallet/);
  });
});
