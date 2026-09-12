import {
  type CommandIO,
  CommandError,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import type { Address } from "viem";
import {
  approvalEvent,
  clampDecimals,
  erc20Abi,
  formatAllowance,
  isUnlimited,
  parseAddress,
  parseBigInt,
  resolveOwner,
  sanitizeSymbol,
  spenderLabel,
} from "../../lib/erc20.js";
import { blocksForDays, parseChainIds, parseDays } from "../../lib/inputs.js";

const inputs = {
  chainIds: {
    type: InputFieldType.Text,
    flag: "chain-ids",
    message: "Comma-separated EVM chain ids to scan (e.g. 1,8453,42161)",
    required: false,
    prompt: false,
  },
  chainId: {
    type: InputFieldType.Text,
    flag: "chain-id",
    message: "Single EVM chain id to scan (shorthand for --chain-ids)",
    required: false,
    prompt: false,
  },
  address: {
    type: InputFieldType.Text,
    flag: "address",
    message: "Owner address to audit (defaults to the active wallet)",
    required: false,
    prompt: false,
  },
  spender: {
    type: InputFieldType.Text,
    flag: "spender",
    message: "Only report allowances granted to this spender",
    required: false,
    prompt: false,
  },
  lookbackDays: {
    type: InputFieldType.Text,
    flag: "lookback-days",
    message: "How many days back to scan for Approval events, converted with each chain's block time (default 30)",
    required: false,
    prompt: false,
  },
  lookback: {
    type: InputFieldType.Text,
    flag: "lookback",
    message: "How many blocks back to scan (overrides --lookback-days; applied to every chain)",
    required: false,
    prompt: false,
  },
  fromBlock: {
    type: InputFieldType.Text,
    flag: "from-block",
    message: "Scan from this block instead of latest - lookback (single chain only)",
    required: false,
    prompt: false,
  },
  chunk: {
    type: InputFieldType.Text,
    flag: "chunk",
    message: "Blocks per eth_getLogs call (default 10000; lower it if your RPC rejects the range)",
    required: false,
    prompt: false,
  },
  all: {
    type: InputFieldType.Boolean,
    flag: "all",
    message: "Include allowances that are currently zero",
    required: false,
    prompt: false,
    default: false,
  },
} satisfies InputSchema;

export type AllowanceEntry = {
  chainId: number;
  token: Address;
  symbol: string;
  decimals: number;
  spender: Address;
  spenderLabel?: string;
  allowance: string;
  allowanceFormatted: string;
  unlimited: boolean;
  lastApprovalBlock: string;
  lastApprovalTx?: string;
};

export type ChainScan = {
  chainId: number;
  scanned?: { fromBlock: string; toBlock: string; approvalEvents: number; pairs: number; skippedNonErc20: number };
  totals?: { active: number; unlimited: number };
  error?: { code: string; message: string; hint?: string };
};

export type AuditResult = {
  owner: Address;
  chainIds: number[];
  chains: ChainScan[];
  totals: { active: number; unlimited: number; chainsScanned: number; chainsFailed: number };
  allowances: AllowanceEntry[];
};

type Pair = { token: Address; spender: Address; lastBlock: bigint; lastTx?: string };
type ScanOptions = { lookbackBlocks?: bigint; lookbackDays: number; fromBlock?: bigint; chunk: bigint; spender?: Address; includeZero: boolean };

export default class AllowancesAudit extends PluginCommand<AuditResult> {
  static override description =
    "List the ERC-20 allowances your wallet has granted, on one or several chains: scans Approval events, then reads each live allowance() on-chain.";

  static override examples = [
    "<%= config.bin %> allowances audit --chain-id 1",
    "<%= config.bin %> allowances audit --chain-ids 1,8453,42161 --json",
    "<%= config.bin %> allowances audit --chain-id 8453 --lookback-days 90 --json",
    "<%= config.bin %> allowances audit --chain-id 1 --spender 0x000000000022D473030F116dDEE9F6B43aC78BA3",
  ];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "allowances:audit";

  async execute(io: CommandIO): Promise<AuditResult> {
    const r = await io.resolveInputs(inputs);
    const chainIds = parseChainIds(r.chainIds, r.chainId);
    const owner = resolveOwner(this.ctx, r.address);
    const chunk = parseBigInt(r.chunk, "chunk", 10_000n);
    if (chunk === 0n) throw new CommandError("INVALID_INPUT", "chunk must be at least 1.", "Try --chunk 2000.");
    if (r.fromBlock && chainIds.length > 1) {
      throw new CommandError("INVALID_INPUT", "--from-block only makes sense for a single chain.", "Use --lookback-days or --lookback with several chains.");
    }
    const opts: ScanOptions = {
      lookbackBlocks: r.lookback ? parseBigInt(r.lookback, "lookback", 0n) : undefined,
      lookbackDays: parseDays(r.lookbackDays),
      fromBlock: r.fromBlock ? parseBigInt(r.fromBlock, "from-block", 0n) : undefined,
      chunk,
      spender: r.spender ? parseAddress(r.spender, "spender") : undefined,
      includeZero: Boolean(r.all),
    };

    const chains: ChainScan[] = [];
    const allowances: AllowanceEntry[] = [];
    for (const chainId of chainIds) {
      try {
        const { scan, entries } = await this.scanChain(io, chainId, owner, opts, chainIds.length);
        chains.push(scan);
        allowances.push(...entries);
      } catch (error) {
        const e = error instanceof CommandError ? error : null;
        chains.push({
          chainId,
          error: {
            code: e?.code ?? "ALLOWANCES_CHAIN_FAILED",
            message: e?.message ?? (error instanceof Error ? error.message : String(error)),
            hint: e?.hint,
          },
        });
      }
    }
    io.progress(undefined);

    const failed = chains.filter((c) => c.error);
    if (failed.length === chains.length) {
      const first = failed[0].error!;
      throw new CommandError(first.code, `Every chain failed. First error (chain ${failed[0].chainId}): ${first.message}`, first.hint ?? "Check `mm chains list` and your network.");
    }

    allowances.sort((a, b) => Number(b.unlimited) - Number(a.unlimited) || a.chainId - b.chainId || a.symbol.localeCompare(b.symbol));
    return {
      owner,
      chainIds,
      chains,
      totals: {
        active: allowances.filter((e) => e.allowance !== "0").length,
        unlimited: allowances.filter((e) => e.unlimited).length,
        chainsScanned: chains.length - failed.length,
        chainsFailed: failed.length,
      },
      allowances,
    };
  }

  private async scanChain(io: CommandIO, chainId: number, owner: Address, opts: ScanOptions, chainCount: number): Promise<{ scan: ChainScan; entries: AllowanceEntry[] }> {
    const tag = chainCount > 1 ? `[chain ${chainId}] ` : "";
    const client = this.ctx.publicClient(chainId);
    const latest = await client.getBlockNumber();
    const lookback = opts.lookbackBlocks ?? blocksForDays(chainId, opts.lookbackDays);
    const fromBlock = opts.fromBlock ?? (latest > lookback ? latest - lookback : 0n);

    // 1. Approval events emitted for this owner → unique (token, spender) pairs.
    const pairs = new Map<string, Pair>();
    let events = 0;
    for (let start = fromBlock; start <= latest; start += opts.chunk) {
      const end = start + opts.chunk - 1n < latest ? start + opts.chunk - 1n : latest;
      io.progress(`${tag}Scanning Approval events: blocks ${start} → ${end} of ${latest}`);
      let logs;
      try {
        logs = await client.getLogs({ event: approvalEvent, args: { owner }, fromBlock: start, toBlock: end });
      } catch (error) {
        io.progress(undefined);
        throw new CommandError(
          "ALLOWANCES_RPC_ERROR",
          `eth_getLogs failed for blocks ${start}-${end} on chain ${chainId}: ${error instanceof Error ? error.message : String(error)}`,
          "Lower --chunk (e.g. 2000) or --lookback-days, or pass an explicit --from-block."
        );
      }
      for (const log of logs) {
        const spender = log.args.spender as Address | undefined;
        if (!spender || !log.address) continue;
        events += 1;
        const key = `${log.address.toLowerCase()}|${spender.toLowerCase()}`;
        pairs.set(key, { token: log.address, spender, lastBlock: log.blockNumber ?? start, lastTx: log.transactionHash ?? undefined });
      }
    }

    // 2. Live allowance for each pair (events can be stale: spent, reset, or re-approved).
    const entries: AllowanceEntry[] = [];
    let skipped = 0;
    const candidates = [...pairs.values()].filter((p) => !opts.spender || p.spender.toLowerCase() === opts.spender.toLowerCase());
    const batchSize = 6;
    for (let i = 0; i < candidates.length; i += batchSize) {
      io.progress(`${tag}Reading live allowances ${Math.min(i + batchSize, candidates.length)}/${candidates.length}`);
      const batch = candidates.slice(i, i + batchSize);
      const results = await Promise.all(batch.map((p) => this.readEntry(client, chainId, owner, p)));
      for (const entry of results) {
        if (!entry) {
          skipped += 1;
          continue;
        }
        if (entry.allowance === "0" && !opts.includeZero) continue;
        entries.push(entry);
      }
    }

    return {
      scan: {
        chainId,
        scanned: { fromBlock: fromBlock.toString(), toBlock: latest.toString(), approvalEvents: events, pairs: pairs.size, skippedNonErc20: skipped },
        totals: { active: entries.filter((e) => e.allowance !== "0").length, unlimited: entries.filter((e) => e.unlimited).length },
      },
      entries,
    };
  }

  private async readEntry(client: ReturnType<typeof this.ctx.publicClient>, chainId: number, owner: Address, p: Pair): Promise<AllowanceEntry | null> {
    let allowance: bigint;
    try {
      allowance = (await client.readContract({ address: p.token, abi: erc20Abi, functionName: "allowance", args: [owner, p.spender] })) as bigint;
    } catch {
      return null; // not a conforming ERC-20 (or self-destructed): skip silently
    }
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: p.token, abi: erc20Abi, functionName: "symbol" }).then(sanitizeSymbol).catch(() => "?"),
      client.readContract({ address: p.token, abi: erc20Abi, functionName: "decimals" }).then(clampDecimals).catch(() => 18),
    ]);
    return {
      chainId,
      token: p.token,
      symbol,
      decimals,
      spender: p.spender,
      spenderLabel: spenderLabel(p.spender, chainId),
      allowance: allowance.toString(),
      allowanceFormatted: formatAllowance(allowance, decimals),
      unlimited: isUnlimited(allowance),
      lastApprovalBlock: p.lastBlock.toString(),
      lastApprovalTx: p.lastTx,
    };
  }

  override successHint(data: AuditResult): string {
    const { active, unlimited, chainsScanned, chainsFailed } = data.totals;
    const pairs = data.chains.reduce((n, c) => n + (c.scanned?.pairs ?? 0), 0);
    const where = data.chainIds.length === 1 ? `chain ${data.chainIds[0]}` : `${chainsScanned} chain${chainsScanned === 1 ? "" : "s"}`;
    const failed = chainsFailed ? ` ${chainsFailed} chain${chainsFailed === 1 ? "" : "s"} failed (see chains[].error).` : "";
    if (pairs === 0) {
      return `No Approval events for ${data.owner} on ${where} in the scanned window. Widen --lookback-days to scan further back.${failed}`;
    }
    if (active === 0) {
      return `${pairs} token/spender pair${pairs === 1 ? "" : "s"} found on ${where}, none still active (all revoked or spent). Use --all to list them.${failed}`;
    }
    return `${active} active allowance${active === 1 ? "" : "s"} (${unlimited} unlimited) for ${data.owner} on ${where}. Revoke with: mm allowances revoke --chain-id <id> --token <token> --spender <spender>.${failed}`;
  }
}
