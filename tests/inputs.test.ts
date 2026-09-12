import { describe, expect, it } from "vitest";
import { blocksForDays, parseChainIds, parseDays, parseGweiFlag } from "../src/lib/inputs";

describe("lookback window", () => {
  it("converts days to blocks with the chain's block time", () => {
    expect(blocksForDays(1, 30)).toBe(216_000n); // 12 s blocks
    expect(blocksForDays(8453, 30)).toBe(1_296_000n); // 2 s blocks
    expect(blocksForDays(42161, 1)).toBe(345_600n); // 0.25 s blocks
    expect(blocksForDays(999_999, 1)).toBe(7_200n); // unknown chain, 12 s assumed
  });
  it("parses days with a default and bounds", () => {
    expect(parseDays(undefined)).toBe(30);
    expect(parseDays("")).toBe(30);
    expect(parseDays("0.5")).toBe(0.5);
    expect(() => parseDays("0")).toThrow(/lookback-days/);
    expect(() => parseDays("-3")).toThrow();
    expect(() => parseDays("4000")).toThrow();
    expect(() => parseDays("abc")).toThrow();
  });
});

describe("chain id lists", () => {
  it("merges --chain-ids and --chain-id, de-duplicates, keeps order", () => {
    expect(parseChainIds("1, 8453,42161", undefined)).toEqual([1, 8453, 42161]);
    expect(parseChainIds("1,8453", "8453")).toEqual([1, 8453]);
    expect(parseChainIds(undefined, "10")).toEqual([10]);
  });
  it("rejects empty and malformed lists", () => {
    expect(() => parseChainIds(undefined, undefined)).toThrow(/at least one chain id/);
    expect(() => parseChainIds(" , ", "")).toThrow();
    expect(() => parseChainIds("1,foo", undefined)).toThrow(/chain id/);
  });
});

describe("gas flags", () => {
  it("parses gwei into wei", () => {
    expect(parseGweiFlag("5", "max-fee-gwei")).toBe(5_000_000_000n);
    expect(parseGweiFlag("1.5", "priority-fee-gwei")).toBe(1_500_000_000n);
    expect(parseGweiFlag(undefined, "x")).toBeUndefined();
    expect(parseGweiFlag("  ", "x")).toBeUndefined();
  });
  it("rejects non-positive and malformed values", () => {
    expect(() => parseGweiFlag("0", "x")).toThrow(/positive number of gwei/);
    expect(() => parseGweiFlag("-1", "x")).toThrow();
    expect(() => parseGweiFlag("1e9", "x")).toThrow();
    expect(() => parseGweiFlag("0x5", "x")).toThrow();
  });
});
