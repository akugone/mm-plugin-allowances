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
  erc20Abi,
  formatAllowance,
  isUnlimited,
  parseAddress,
  parseBigInt,
  parseChainId,
  resolveOwner,
  spenderLabel,
} from "../../lib/erc20.js";

const inputs = {
  chainId: {
    type: InputFieldType.Text,
    flag: "chain-id",
    message: "EVM chain id to scan (e.g. 1, 8453)",
    required: true,
    prompt: true,
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
  lookback: {
    type: InputFieldType.Text,
    flag: "lookback",
    message: "How many blocks back to scan for Approval events (default 250000)",
    required: false,
    prompt: false,
  },
  fromBlock: {
    type: InputFieldType.Text,
    flag: "from-block",
    message: "Scan from this block instead of latest - lookback",
    required: false,
    prompt: false,
  },
  chunk: {
    type: InputFieldType.Text,
    flag: "chunk",
    message: "Blocks per eth_getLogs call (default 5000; lower it if your RPC rejects the range)",
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

export type AuditResult = {
  owner: Address;
  chainId: number;
  scanned: { fromBlock: string; toBlock: string; approvalEvents: number; pairs: number };
  totals: { active: number; unlimited: number };
  allowances: AllowanceEntry[];
  hint: string;
};

type Pair = { token: Address; spender: Address; lastBlock: bigint; lastTx?: string };

export default class AllowancesAudit extends PluginCommand<AuditResult> {
  static override description =
    "List the ERC-20 allowances your wallet has granted: scans Approval events, then reads each live allowance() on-chain.";

  static override examples = [
    "<%= config.bin %> allowances audit --chain-id 1",
    "<%= config.bin %> allowances audit --chain-id 8453 --lookback 500000 --json",
    "<%= config.bin %> allowances audit --chain-id 1 --spender 0x000000000022D473030F116dDEE9F6B43aC78BA3",
  ];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "allowances:audit";

  async execute(io: CommandIO): Promise<AuditResult> {
    const r = await io.resolveInputs(inputs);
    const chainId = parseChainId(r.chainId);
    const owner = resolveOwner(this.ctx, r.address);
    const spenderFilter = r.spender ? parseAddress(r.spender, "spender") : undefined;
    const lookback = parseBigInt(r.lookback, "lookback", 250_000n);
    const chunk = parseBigInt(r.chunk, "chunk", 5_000n);
    if (chunk === 0n) throw new CommandError("INVALID_INPUT", "chunk must be at least 1.", "Try --chunk 2000.");

    const client = this.ctx.publicClient(chainId);
    const latest = await client.getBlockNumber();
    const fromBlock = r.fromBlock ? parseBigInt(r.fromBlock, "from-block", 0n) : latest > lookback ? latest - lookback : 0n;

    // 1. Approval events emitted for this owner → unique (token, spender) pairs.
    const pairs = new Map<string, Pair>();
    let events = 0;
    for (let start = fromBlock; start <= latest; start += chunk) {
      const end = start + chunk - 1n < latest ? start + chunk - 1n : latest;
      io.progress(`Scanning Approval events: blocks ${start} → ${end} of ${latest}`);
      let logs;
      try {
        logs = await client.getLogs({ event: approvalEvent, args: { owner }, fromBlock: start, toBlock: end });
      } catch (error) {
        io.progress(undefined);
        throw new CommandError(
          "ALLOWANCES_RPC_ERROR",
          `eth_getLogs failed for blocks ${start}-${end}: ${error instanceof Error ? error.message : String(error)}`,
          "Lower --chunk (e.g. 2000) or --lookback, or pass an explicit --from-block."
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
    io.progress(undefined);

    // 2. Live allowance for each pair (events can be stale: spent, reset, or re-approved).
    const entries: AllowanceEntry[] = [];
    const candidates = [...pairs.values()].filter((p) => !spenderFilter || p.spender.toLowerCase() === spenderFilter.toLowerCase());
    const batchSize = 6;
    for (let i = 0; i < candidates.length; i += batchSize) {
      io.progress(`Reading live allowances ${Math.min(i + batchSize, candidates.length)}/${candidates.length}`);
      const batch = candidates.slice(i, i + batchSize);
      const results = await Promise.all(batch.map((p) => this.readEntry(client, owner, p)));
      for (const entry of results) {
        if (!entry) continue;
        if (entry.allowance === "0" && !r.all) continue;
        entries.push(entry);
      }
    }
    io.progress(undefined);

    entries.sort((a, b) => Number(b.unlimited) - Number(a.unlimited) || a.symbol.localeCompare(b.symbol));
    const unlimited = entries.filter((e) => e.unlimited).length;
    return {
      owner,
      chainId,
      scanned: { fromBlock: fromBlock.toString(), toBlock: latest.toString(), approvalEvents: events, pairs: pairs.size },
      totals: { active: entries.filter((e) => e.allowance !== "0").length, unlimited },
      allowances: entries,
      hint:
        entries.length === 0
          ? "No active allowances found in the scanned range. Widen --lookback to scan further back."
          : "Revoke one with: mm allowances revoke --chain-id <id> --token <token> --spender <spender>",
    };
  }

  private async readEntry(client: ReturnType<typeof this.ctx.publicClient>, owner: Address, p: Pair): Promise<AllowanceEntry | null> {
    let allowance: bigint;
    try {
      allowance = (await client.readContract({ address: p.token, abi: erc20Abi, functionName: "allowance", args: [owner, p.spender] })) as bigint;
    } catch {
      return null; // not a conforming ERC-20 (or self-destructed): skip silently
    }
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: p.token, abi: erc20Abi, functionName: "symbol" }).then(String).catch(() => "?"),
      client.readContract({ address: p.token, abi: erc20Abi, functionName: "decimals" }).then(Number).catch(() => 18),
    ]);
    return {
      token: p.token,
      symbol,
      decimals,
      spender: p.spender,
      spenderLabel: spenderLabel(p.spender),
      allowance: allowance.toString(),
      allowanceFormatted: formatAllowance(allowance, decimals),
      unlimited: isUnlimited(allowance),
      lastApprovalBlock: p.lastBlock.toString(),
      lastApprovalTx: p.lastTx,
    };
  }

  override successHint(data: AuditResult): string {
    const { active, unlimited } = data.totals;
    if (active === 0) return `No active allowances for ${data.owner} on chain ${data.chainId} in the scanned range.`;
    return `${active} active allowance${active === 1 ? "" : "s"} (${unlimited} unlimited) for ${data.owner} on chain ${data.chainId}.`;
  }
}
