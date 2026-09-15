import {
  type CommandIO,
  CommandError,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { type Address, type Hex, numberToHex, parseEventLogs, type RpcLog } from "viem";
import {
  approvalEvent,
  clampDecimals,
  erc20Abi,
  expectedUnlimitedNote,
  formatAllowance,
  isUnlimited,
  parseAddress,
  parseBigInt,
  resolveOwner,
  sanitizeSymbol,
  spenderLabel,
} from "../../lib/erc20.js";
import { blocksForDays, parseChainIds, parseDays } from "../../lib/inputs.js";
import {
  describeExpiration,
  formatPermit2Amount,
  isUnlimitedPermit2,
  PERMIT2_ADDRESS,
  permit2Abi,
  permit2OwnerTopics,
} from "../../lib/permit2.js";

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
    message: "Only report allowances granted to this spender (ERC-20 and Permit2)",
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
  skipPermit2: {
    type: InputFieldType.Boolean,
    flag: "skip-permit2",
    message: "Do not scan the allowances held inside Permit2 (halves the eth_getLogs calls)",
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
  /** True for spenders designed to hold one unlimited approval (Permit2). Not counted in totals.unlimited. */
  expected: boolean;
  note?: string;
  lastApprovalBlock: string;
  lastApprovalTx?: string;
};

/** An allowance held inside Permit2: owner → spender for one token, with Permit2's own amount and expiration. */
export type Permit2AllowanceEntry = {
  chainId: number;
  token: Address;
  symbol: string;
  decimals: number;
  spender: Address;
  spenderLabel?: string;
  amount: string;
  amountFormatted: string;
  unlimited: boolean;
  expiration: string;
  expiresAt: string;
  expired: boolean;
  nonce: string;
  lastEventBlock: string;
  lastEventTx?: string;
};

export type ChainScan = {
  chainId: number;
  scanned?: {
    fromBlock: string;
    toBlock: string;
    approvalEvents: number;
    pairs: number;
    skippedNonErc20: number;
    permit2Deployed: boolean;
    permit2Events: number;
    permit2Pairs: number;
  };
  totals?: { active: number; unlimited: number; expected: number; permit2: Permit2Totals };
  error?: { code: string; message: string; hint?: string };
};

export type Permit2Totals = { active: number; unlimited: number; expired: number };

export type AuditResult = {
  owner: Address;
  chainIds: number[];
  chains: ChainScan[];
  totals: { active: number; unlimited: number; expected: number; permit2: Permit2Totals; chainsScanned: number; chainsFailed: number };
  allowances: AllowanceEntry[];
  permit2: Permit2AllowanceEntry[];
};

type Pair = { token: Address; spender: Address; lastBlock: bigint; lastTx?: string };
type ScanOptions = {
  lookbackBlocks?: bigint;
  lookbackDays: number;
  fromBlock?: bigint;
  chunk: bigint;
  spender?: Address;
  includeZero: boolean;
  permit2: boolean;
};
type Client = ReturnType<PluginCommand["ctx"]["publicClient"]>;

const permit2Totals = (entries: Permit2AllowanceEntry[]): Permit2Totals => ({
  active: entries.filter((e) => e.amount !== "0" && !e.expired).length,
  unlimited: entries.filter((e) => e.unlimited && !e.expired).length,
  expired: entries.filter((e) => e.amount !== "0" && e.expired).length,
});

/** Flagged unlimited first, ordinary next, expected (Permit2) last. */
const rank = (e: AllowanceEntry) => (e.unlimited && !e.expected ? 0 : e.expected ? 2 : 1);
/** Live unlimited first, live limited next, expired last. */
const rankPermit2 = (e: Permit2AllowanceEntry) => (e.expired ? 2 : e.unlimited ? 0 : 1);

export default class AllowancesAudit extends PluginCommand<AuditResult> {
  static override description =
    "List the ERC-20 allowances your wallet has granted, on one or several chains: scans Approval events, reads each live allowance() on-chain, and audits the per-app allowances held inside Permit2.";

  static override examples = [
    "<%= config.bin %> allowances audit --chain-id 1",
    "<%= config.bin %> allowances audit --chain-ids 1,8453,42161 --json",
    "<%= config.bin %> allowances audit --chain-id 8453 --lookback-days 90 --json",
    "<%= config.bin %> allowances audit --chain-id 1 --spender 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
    "<%= config.bin %> allowances audit --chain-id 1 --skip-permit2",
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
      permit2: !r.skipPermit2,
    };

    const chains: ChainScan[] = [];
    const allowances: AllowanceEntry[] = [];
    const permit2: Permit2AllowanceEntry[] = [];
    for (const chainId of chainIds) {
      try {
        const res = await this.scanChain(io, chainId, owner, opts, chainIds.length);
        chains.push(res.scan);
        allowances.push(...res.entries);
        permit2.push(...res.permit2Entries);
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

    allowances.sort((a, b) => rank(a) - rank(b) || a.chainId - b.chainId || a.symbol.localeCompare(b.symbol));
    permit2.sort((a, b) => rankPermit2(a) - rankPermit2(b) || a.chainId - b.chainId || a.symbol.localeCompare(b.symbol));
    return {
      owner,
      chainIds,
      chains,
      totals: {
        active: allowances.filter((e) => e.allowance !== "0").length,
        unlimited: allowances.filter((e) => e.unlimited && !e.expected).length,
        expected: allowances.filter((e) => e.expected && e.allowance !== "0").length,
        permit2: permit2Totals(permit2),
        chainsScanned: chains.length - failed.length,
        chainsFailed: failed.length,
      },
      allowances,
      permit2,
    };
  }

  private async scanChain(
    io: CommandIO,
    chainId: number,
    owner: Address,
    opts: ScanOptions,
    chainCount: number
  ): Promise<{ scan: ChainScan; entries: AllowanceEntry[]; permit2Entries: Permit2AllowanceEntry[] }> {
    const tag = chainCount > 1 ? `[chain ${chainId}] ` : "";
    const client = this.ctx.publicClient(chainId);
    const latest = await client.getBlockNumber();
    const lookback = opts.lookbackBlocks ?? blocksForDays(chainId, opts.lookbackDays);
    const fromBlock = opts.fromBlock ?? (latest > lookback ? latest - lookback : 0n);
    const wantSpender = (spender: Address) => !opts.spender || spender.toLowerCase() === opts.spender.toLowerCase();

    // Permit2 is a deterministic deployment but not present on every chain; one getCode saves a window of empty getLogs.
    let permit2Deployed = false;
    if (opts.permit2) {
      const code = await client.getCode({ address: PERMIT2_ADDRESS }).catch(() => undefined);
      permit2Deployed = Boolean(code && code !== "0x");
    }

    // 1. Approval events emitted for this owner → unique (token, spender) pairs. Permit2's Approval/Permit events
    //    are read in the same window (one extra eth_getLogs per chunk, on the Permit2 address only).
    const pairs = new Map<string, Pair>();
    const permit2Pairs = new Map<string, Pair>();
    let events = 0;
    let permit2Events = 0;
    const topics = permit2Deployed ? permit2OwnerTopics(owner) : undefined;
    for (let start = fromBlock; start <= latest; start += opts.chunk) {
      const end = start + opts.chunk - 1n < latest ? start + opts.chunk - 1n : latest;
      io.progress(`${tag}Scanning Approval events: blocks ${start} → ${end} of ${latest}`);
      let logs;
      let permit2Logs: RpcLog[] = [];
      try {
        [logs, permit2Logs] = await Promise.all([
          client.getLogs({ event: approvalEvent, args: { owner }, fromBlock: start, toBlock: end }),
          topics
            ? (client.request({
                method: "eth_getLogs",
                params: [{ address: PERMIT2_ADDRESS, fromBlock: numberToHex(start), toBlock: numberToHex(end), topics }],
              }) as Promise<RpcLog[]>)
            : Promise.resolve([] as RpcLog[]),
        ]);
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
      for (const log of parseEventLogs({ abi: permit2Abi, logs: permit2Logs, eventName: ["Approval", "Permit"] })) {
        const { token, spender } = log.args;
        if (!token || !spender) continue;
        permit2Events += 1;
        const key = `${token.toLowerCase()}|${spender.toLowerCase()}`;
        permit2Pairs.set(key, {
          token,
          spender,
          lastBlock: log.blockNumber ? BigInt(log.blockNumber) : start,
          lastTx: (log.transactionHash as Hex | null) ?? undefined,
        });
      }
    }

    // 2. Live allowance for each pair (events can be stale: spent, reset, or re-approved).
    const entries: AllowanceEntry[] = [];
    let skipped = 0;
    const candidates = [...pairs.values()].filter((p) => wantSpender(p.spender));
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

    // 3. Live Permit2 allowance (amount, expiration, nonce) for each (token, spender) seen inside Permit2.
    const permit2Entries: Permit2AllowanceEntry[] = [];
    const permit2Candidates = [...permit2Pairs.values()].filter((p) => wantSpender(p.spender));
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < permit2Candidates.length; i += batchSize) {
      io.progress(`${tag}Reading Permit2 allowances ${Math.min(i + batchSize, permit2Candidates.length)}/${permit2Candidates.length}`);
      const batch = permit2Candidates.slice(i, i + batchSize);
      const results = await Promise.all(batch.map((p) => this.readPermit2Entry(client, chainId, owner, p, now)));
      for (const entry of results) {
        if (!entry) continue;
        if (entry.amount === "0" && !opts.includeZero) continue;
        permit2Entries.push(entry);
      }
    }

    return {
      scan: {
        chainId,
        scanned: {
          fromBlock: fromBlock.toString(),
          toBlock: latest.toString(),
          approvalEvents: events,
          pairs: pairs.size,
          skippedNonErc20: skipped,
          permit2Deployed,
          permit2Events,
          permit2Pairs: permit2Pairs.size,
        },
        totals: {
          active: entries.filter((e) => e.allowance !== "0").length,
          unlimited: entries.filter((e) => e.unlimited && !e.expected).length,
          expected: entries.filter((e) => e.expected && e.allowance !== "0").length,
          permit2: permit2Totals(permit2Entries),
        },
      },
      entries,
      permit2Entries,
    };
  }

  private async tokenMeta(client: Client, token: Address): Promise<{ symbol: string; decimals: number }> {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).then(sanitizeSymbol).catch(() => "?"),
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).then(clampDecimals).catch(() => 18),
    ]);
    return { symbol, decimals };
  }

  private async readEntry(client: Client, chainId: number, owner: Address, p: Pair): Promise<AllowanceEntry | null> {
    let allowance: bigint;
    try {
      allowance = (await client.readContract({ address: p.token, abi: erc20Abi, functionName: "allowance", args: [owner, p.spender] })) as bigint;
    } catch {
      return null; // not a conforming ERC-20 (or self-destructed): skip silently
    }
    const { symbol, decimals } = await this.tokenMeta(client, p.token);
    const unlimited = isUnlimited(allowance);
    const note = expectedUnlimitedNote(p.spender);
    return {
      chainId,
      token: p.token,
      symbol,
      decimals,
      spender: p.spender,
      spenderLabel: spenderLabel(p.spender, chainId),
      allowance: allowance.toString(),
      allowanceFormatted: formatAllowance(allowance, decimals),
      unlimited,
      expected: Boolean(note) && unlimited,
      note: note && unlimited ? note : undefined,
      lastApprovalBlock: p.lastBlock.toString(),
      lastApprovalTx: p.lastTx,
    };
  }

  private async readPermit2Entry(client: Client, chainId: number, owner: Address, p: Pair, now: number): Promise<Permit2AllowanceEntry | null> {
    let amount: bigint;
    let expiration: bigint;
    let nonce: bigint;
    try {
      const res = (await client.readContract({
        address: PERMIT2_ADDRESS,
        abi: permit2Abi,
        functionName: "allowance",
        args: [owner, p.token, p.spender],
      })) as readonly [bigint, number, number];
      amount = res[0];
      expiration = BigInt(res[1]);
      nonce = BigInt(res[2]);
    } catch {
      return null;
    }
    const { symbol, decimals } = await this.tokenMeta(client, p.token);
    const exp = describeExpiration(expiration, now);
    return {
      chainId,
      token: p.token,
      symbol,
      decimals,
      spender: p.spender,
      spenderLabel: spenderLabel(p.spender, chainId),
      amount: amount.toString(),
      amountFormatted: formatPermit2Amount(amount, decimals),
      unlimited: isUnlimitedPermit2(amount),
      ...exp,
      nonce: nonce.toString(),
      lastEventBlock: p.lastBlock.toString(),
      lastEventTx: p.lastTx,
    };
  }

  override successHint(data: AuditResult): string {
    const { active, unlimited, expected, permit2, chainsScanned, chainsFailed } = data.totals;
    const pairs = data.chains.reduce((n, c) => n + (c.scanned?.pairs ?? 0) + (c.scanned?.permit2Pairs ?? 0), 0);
    const where = data.chainIds.length === 1 ? `chain ${data.chainIds[0]}` : `${chainsScanned} chain${chainsScanned === 1 ? "" : "s"}`;
    const failed = chainsFailed ? ` ${chainsFailed} chain${chainsFailed === 1 ? "" : "s"} failed (see chains[].error).` : "";
    if (pairs === 0) {
      return `No Approval events for ${data.owner} on ${where} in the scanned window. Widen --lookback-days to scan further back.${failed}`;
    }
    const parts: string[] = [];
    if (active > 0) {
      const exp = expected ? `, ${expected} expected (Permit2, unlimited by design)` : "";
      parts.push(`${active} active ERC-20 allowance${active === 1 ? "" : "s"} (${unlimited} unlimited${exp})`);
    }
    if (permit2.active > 0 || permit2.expired > 0) {
      const exp = permit2.expired ? `, ${permit2.expired} expired` : "";
      parts.push(`${permit2.active} live Permit2 allowance${permit2.active === 1 ? "" : "s"} (${permit2.unlimited} unlimited${exp})`);
    }
    if (parts.length === 0) {
      return `${pairs} token/spender pair${pairs === 1 ? "" : "s"} found on ${where}, none still active (all revoked or spent). Use --all to list them.${failed}`;
    }
    const how = permit2.active > 0
      ? " Revoke with: mm allowances revoke --chain-id <id> --token <token> --spender <spender>, adding --permit2 for the permit2[] entries."
      : " Revoke with: mm allowances revoke --chain-id <id> --token <token> --spender <spender>.";
    return `${parts.join("; ")} for ${data.owner} on ${where}.${how}${failed}`;
  }
}
