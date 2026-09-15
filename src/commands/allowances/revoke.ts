import {
  type CommandIO,
  CommandError,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { type Address, encodeFunctionData, type Hex } from "viem";
import { clampDecimals, erc20Abi, formatAllowance, parseAddress, parseChainId, resolveOwner, sanitizeSymbol, spenderLabel } from "../../lib/erc20.js";
import { parseGweiFlag } from "../../lib/inputs.js";
import { describeExpiration, encodeLockdown, formatPermit2Amount, parsePairs, PERMIT2_ADDRESS, permit2Abi, type TokenSpenderPair } from "../../lib/permit2.js";

const inputs = {
  token: {
    type: InputFieldType.Text,
    flag: "token",
    message: "ERC-20 token contract address (with --permit2: comma-separated list allowed)",
    required: true,
    prompt: true,
  },
  spender: {
    type: InputFieldType.Text,
    flag: "spender",
    message: "Spender address whose allowance should be set to zero (with --permit2: one per token, same order)",
    required: true,
    prompt: true,
  },
  chainId: {
    type: InputFieldType.Text,
    flag: "chain-id",
    message: "EVM chain id (e.g. 1, 8453)",
    required: true,
    prompt: true,
  },
  permit2: {
    type: InputFieldType.Boolean,
    flag: "permit2",
    message: "Revoke the allowance held inside Permit2 (Permit2.lockdown) instead of the token's ERC-20 approval",
    required: false,
    prompt: false,
    default: false,
  },
  dryRun: {
    type: InputFieldType.Boolean,
    flag: "dry-run",
    message: "Show the transaction that would be sent without submitting it",
    required: false,
    prompt: false,
    default: false,
  },
  gasSpeed: {
    type: InputFieldType.Select,
    flag: "gas-speed",
    message: "Gas fee tier for EIP-1559 chains (default medium)",
    required: false,
    prompt: false,
    options: [
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
    ],
  },
  maxFeeGwei: {
    type: InputFieldType.Text,
    flag: "max-fee-gwei",
    message: "Explicit maxFeePerGas in gwei (overrides the estimator, e.g. 5)",
    required: false,
    prompt: false,
  },
  priorityFeeGwei: {
    type: InputFieldType.Text,
    flag: "priority-fee-gwei",
    message: "Explicit maxPriorityFeePerGas in gwei (e.g. 1.5)",
    required: false,
    prompt: false,
  },
} satisfies InputSchema;

export type RevokedPair = {
  token: Address;
  symbol: string;
  spender: Address;
  spenderLabel?: string;
  previousAmount: string;
  previousAmountFormatted: string;
  expiration: string;
  expiresAt: string;
  expired: boolean;
};

export type RevokeResult = {
  chainId: number;
  owner: Address;
  /** "erc20": approve(spender, 0) sent to the token. "permit2": lockdown(pairs) sent to Permit2. */
  via: "erc20" | "permit2";
  /** Contract the transaction is sent to: the token (erc20) or Permit2 (permit2). */
  to: Address;
  /** ERC-20 mode only. */
  token?: Address;
  symbol?: string;
  spender?: Address;
  spenderLabel?: string;
  previousAllowance?: string;
  previousAllowanceFormatted?: string;
  /** Permit2 mode only: the allowances being zeroed. */
  pairs?: RevokedPair[];
  /** Permit2 mode only: pairs left out because their Permit2 amount is already 0. */
  skippedAlreadyZero?: TokenSpenderPair[];
  calldata: Hex;
  dryRun: boolean;
  gasSpeed?: "low" | "medium" | "high";
  maxFeePerGasWei?: string;
  maxPriorityFeePerGasWei?: string;
  status?: string;
  hash?: string;
  pollingId?: string;
  failure?: string;
};

type Client = ReturnType<PluginCommand["ctx"]["publicClient"]>;

export default class AllowancesRevoke extends PluginCommand<RevokeResult> {
  static override description =
    "Revoke an ERC-20 allowance by sending approve(spender, 0) from your wallet, or with --permit2 zero the allowance(s) held inside Permit2 via lockdown(). Goes through MetaMask's policy, threat scan and 2FA like any other transaction.";

  static override examples = [
    "<%= config.bin %> allowances revoke --chain-id 1 --token 0xA0b8...eB48 --spender 0x0000...78BA3",
    "<%= config.bin %> allowances revoke --chain-id 1 --token 0xA0b8...eB48 --spender 0x0000...78BA3 --dry-run --json",
    "<%= config.bin %> allowances revoke --chain-id 1 --permit2 --token 0xA0b8...eB48 --spender 0x3fC9...7FAD",
    "<%= config.bin %> allowances revoke --chain-id 1 --permit2 --token 0xA0b8...eB48,0xC02a...6Cc2 --spender 0x3fC9...7FAD,0x3fC9...7FAD",
    "<%= config.bin %> allowances revoke --chain-id 11155111 --token 0x1c7D...7238 --spender 0x0000...78BA3 --gas-speed high",
    "<%= config.bin %> allowances revoke --chain-id 11155111 --token 0x1c7D...7238 --spender 0x0000...78BA3 --max-fee-gwei 5 --priority-fee-gwei 1.5",
  ];

  static override requiresAuth = true;
  static override requiresInit = true;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "allowances:revoke";

  async execute(io: CommandIO): Promise<RevokeResult> {
    const r = await io.resolveInputs(inputs);
    const chainId = parseChainId(r.chainId);
    const owner = resolveOwner(this.ctx);
    const client = this.ctx.publicClient(chainId);

    const gasSpeed = (r.gasSpeed || undefined) as RevokeResult["gasSpeed"];
    const maxFeePerGas = parseGweiFlag(r.maxFeeGwei, "max-fee-gwei");
    const maxPriorityFeePerGas = parseGweiFlag(r.priorityFeeGwei, "priority-fee-gwei");
    if (maxPriorityFeePerGas !== undefined && maxFeePerGas !== undefined && maxPriorityFeePerGas > maxFeePerGas) {
      throw new CommandError("INVALID_INPUT", "priority-fee-gwei cannot exceed max-fee-gwei.", "Lower the priority fee or raise the max fee.");
    }
    const fees = {
      gasSpeed,
      maxFeePerGasWei: maxFeePerGas?.toString(),
      maxPriorityFeePerGasWei: maxPriorityFeePerGas?.toString(),
    };

    const { base, summary, details } = r.permit2
      ? await this.preparePermit2(client, chainId, owner, r.token, r.spender)
      : await this.prepareErc20(client, chainId, owner, r.token, r.spender);
    const result: RevokeResult = { ...base, ...fees, dryRun: Boolean(r.dryRun) };
    if (r.dryRun) return result;

    const executor = await this.ctx.walletExecutor(io, this.pluginCommandId);
    const outcome = await executor({
      kind: "transaction",
      chainId,
      transaction: {
        to: base.to,
        data: base.calldata,
        value: 0n,
        ...(maxFeePerGas !== undefined ? { maxFeePerGas } : {}),
        ...(maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas } : {}),
        ...(gasSpeed ? { options: { speed: gasSpeed } } : {}),
      },
      intent: { summary, action: "custom", details },
    });

    return {
      ...result,
      status: outcome.status,
      hash: outcome.kind === "transaction" ? outcome.hash || undefined : undefined,
      pollingId: outcome.pendingJob?.pollingId,
      failure: outcome.failureDescription,
    };
  }

  private async tokenMeta(client: Client, token: Address): Promise<{ symbol: string; decimals: number }> {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).then(sanitizeSymbol).catch(() => "?"),
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).then(clampDecimals).catch(() => 18),
    ]);
    return { symbol, decimals };
  }

  /** approve(spender, 0) on the token itself. */
  private async prepareErc20(client: Client, chainId: number, owner: Address, rawToken: string, rawSpender: string) {
    if (rawToken.includes(",") || rawSpender.includes(",")) {
      throw new CommandError("INVALID_INPUT", "ERC-20 revocation takes a single --token and --spender.", "Lists are only supported with --permit2 (one lockdown() covers several pairs). Without it, run one revoke per approval.");
    }
    const token = parseAddress(rawToken, "token");
    const spender = parseAddress(rawSpender, "spender");
    const [previous, { symbol, decimals }] = await Promise.all([
      client
        .readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] })
        .then((v: unknown) => v as bigint)
        .catch(() => {
          throw new CommandError("ALLOWANCES_NOT_ERC20", `${token} does not answer allowance(); is it an ERC-20 on chain ${chainId}?`, "Check the token address and chain id.");
        }),
      this.tokenMeta(client, token),
    ]);
    if (previous === 0n) {
      throw new CommandError("ALLOWANCES_ALREADY_ZERO", `${symbol} allowance for ${spender} is already 0.`, "Nothing to revoke. Run `mm allowances audit` to see active allowances.");
    }
    const label = spenderLabel(spender, chainId);
    const previousAllowanceFormatted = formatAllowance(previous, decimals);
    const base: Omit<RevokeResult, "dryRun"> = {
      chainId,
      owner,
      via: "erc20",
      to: token,
      token,
      symbol,
      spender,
      spenderLabel: label,
      previousAllowance: previous.toString(),
      previousAllowanceFormatted,
      calldata: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 0n] }),
    };
    return {
      base,
      summary: `Revoke ${symbol} allowance (${previousAllowanceFormatted}) granted to ${label ?? spender}`,
      details: { token, spender, previous: previousAllowanceFormatted },
    };
  }

  /** Permit2.lockdown([{token, spender}, …]) on the canonical Permit2 contract; the ERC-20 approval to Permit2 is left alone. */
  private async preparePermit2(client: Client, chainId: number, owner: Address, rawToken: string, rawSpender: string) {
    const requested = parsePairs(rawToken, rawSpender);
    if (requested.some((p) => p.spender.toLowerCase() === PERMIT2_ADDRESS.toLowerCase())) {
      throw new CommandError("INVALID_INPUT", "With --permit2, --spender is the app that spends through Permit2, not Permit2 itself.", "Run `mm allowances audit` and use the token/spender pairs listed under permit2[].");
    }
    const code = await client.getCode({ address: PERMIT2_ADDRESS }).catch(() => undefined);
    if (!code || code === "0x") {
      throw new CommandError("PERMIT2_NOT_DEPLOYED", `Permit2 (${PERMIT2_ADDRESS}) has no code on chain ${chainId}.`, "Check the chain id; Permit2 is deployed on Ethereum, Base, Arbitrum, Optimism, Polygon and most L2s.");
    }
    const now = Math.floor(Date.now() / 1000);
    const pairs: RevokedPair[] = [];
    const skippedAlreadyZero: TokenSpenderPair[] = [];
    for (const p of requested) {
      const [amount, expiration] = (await client.readContract({
        address: PERMIT2_ADDRESS,
        abi: permit2Abi,
        functionName: "allowance",
        args: [owner, p.token, p.spender],
      })) as readonly [bigint, number, number];
      if (amount === 0n) {
        skippedAlreadyZero.push(p);
        continue;
      }
      const { symbol, decimals } = await this.tokenMeta(client, p.token);
      pairs.push({
        token: p.token,
        symbol,
        spender: p.spender,
        spenderLabel: spenderLabel(p.spender, chainId),
        previousAmount: amount.toString(),
        previousAmountFormatted: formatPermit2Amount(amount, decimals),
        ...describeExpiration(BigInt(expiration), now),
      });
    }
    if (pairs.length === 0) {
      throw new CommandError("ALLOWANCES_ALREADY_ZERO", `Every requested Permit2 allowance is already 0 for ${owner}.`, "Nothing to revoke. Run `mm allowances audit` and use the pairs listed under permit2[].");
    }
    const described = pairs.map((p) => `${p.symbol} (${p.previousAmountFormatted}) → ${p.spenderLabel ?? p.spender}`);
    const base: Omit<RevokeResult, "dryRun"> = {
      chainId,
      owner,
      via: "permit2",
      to: PERMIT2_ADDRESS,
      pairs,
      skippedAlreadyZero: skippedAlreadyZero.length ? skippedAlreadyZero : undefined,
      calldata: encodeLockdown(pairs.map((p) => ({ token: p.token, spender: p.spender }))),
    };
    return {
      base,
      summary: pairs.length === 1
        ? `Revoke Permit2 allowance: ${described[0]}`
        : `Revoke ${pairs.length} Permit2 allowances: ${described.join(", ")}`,
      details: { permit2: PERMIT2_ADDRESS, pairs: pairs.map((p) => ({ token: p.token, spender: p.spender, previous: p.previousAmountFormatted })) },
    };
  }

  override successHint(data: RevokeResult): string {
    const what = data.via === "permit2"
      ? `lockdown(${data.pairs?.length ?? 0} pair${(data.pairs?.length ?? 0) === 1 ? "" : "s"}) to Permit2`
      : `approve(${data.spender}, 0) to ${data.symbol} (${data.token})`;
    const skipped = data.skippedAlreadyZero?.length ? ` ${data.skippedAlreadyZero.length} pair${data.skippedAlreadyZero.length === 1 ? "" : "s"} skipped (already 0).` : "";
    if (data.dryRun) return `Dry run: would send ${what} on chain ${data.chainId}.${skipped}`;
    const target = data.via === "permit2"
      ? `${data.pairs?.length ?? 0} Permit2 allowance${(data.pairs?.length ?? 0) === 1 ? "" : "s"}`
      : `${data.symbol} allowance for ${data.spenderLabel ?? data.spender}`;
    if (data.hash) return `Revoked ${target}: ${data.hash}${skipped}`;
    if (data.pollingId) return `Revocation submitted; awaiting approval. Track with: mm wallet requests watch ${data.pollingId}`;
    return `Revocation status: ${data.status ?? "unknown"}`;
  }
}
