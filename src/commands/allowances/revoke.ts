import {
  type CommandIO,
  CommandError,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { type Address, encodeFunctionData } from "viem";
import { clampDecimals, erc20Abi, formatAllowance, parseAddress, parseChainId, resolveOwner, sanitizeSymbol, spenderLabel } from "../../lib/erc20.js";
import { parseGweiFlag } from "../../lib/inputs.js";

const inputs = {
  token: {
    type: InputFieldType.Text,
    flag: "token",
    message: "ERC-20 token contract address",
    required: true,
    prompt: true,
  },
  spender: {
    type: InputFieldType.Text,
    flag: "spender",
    message: "Spender address whose allowance should be set to zero",
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

export type RevokeResult = {
  chainId: number;
  owner: Address;
  token: Address;
  symbol: string;
  spender: Address;
  spenderLabel?: string;
  previousAllowance: string;
  previousAllowanceFormatted: string;
  calldata: `0x${string}`;
  dryRun: boolean;
  gasSpeed?: "low" | "medium" | "high";
  maxFeePerGasWei?: string;
  maxPriorityFeePerGasWei?: string;
  status?: string;
  hash?: string;
  pollingId?: string;
  failure?: string;
};

export default class AllowancesRevoke extends PluginCommand<RevokeResult> {
  static override description =
    "Revoke an ERC-20 allowance by sending approve(spender, 0) from your wallet. Goes through MetaMask's policy, threat scan and 2FA like any other transaction.";

  static override examples = [
    "<%= config.bin %> allowances revoke --chain-id 1 --token 0xA0b8...eB48 --spender 0x0000...78BA3",
    "<%= config.bin %> allowances revoke --chain-id 1 --token 0xA0b8...eB48 --spender 0x0000...78BA3 --dry-run --json",
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
    const token = parseAddress(r.token, "token");
    const spender = parseAddress(r.spender, "spender");
    const owner = resolveOwner(this.ctx);

    const client = this.ctx.publicClient(chainId);
    const [previous, symbol, decimals] = await Promise.all([
      client
        .readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] })
        .then((v: unknown) => v as bigint)
        .catch(() => {
          throw new CommandError("ALLOWANCES_NOT_ERC20", `${token} does not answer allowance(); is it an ERC-20 on chain ${chainId}?`, "Check the token address and chain id.");
        }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).then(sanitizeSymbol).catch(() => "?"),
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).then(clampDecimals).catch(() => 18),
    ]);

    const calldata = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 0n] });
    const label = spenderLabel(spender, chainId);
    const gasSpeed = (r.gasSpeed || undefined) as RevokeResult["gasSpeed"];
    const maxFeePerGas = parseGweiFlag(r.maxFeeGwei, "max-fee-gwei");
    const maxPriorityFeePerGas = parseGweiFlag(r.priorityFeeGwei, "priority-fee-gwei");
    if (maxPriorityFeePerGas !== undefined && maxFeePerGas !== undefined && maxPriorityFeePerGas > maxFeePerGas) {
      throw new CommandError("INVALID_INPUT", "priority-fee-gwei cannot exceed max-fee-gwei.", "Lower the priority fee or raise the max fee.");
    }
    const base: RevokeResult = {
      chainId,
      owner,
      token,
      symbol,
      spender,
      spenderLabel: label,
      previousAllowance: previous.toString(),
      previousAllowanceFormatted: formatAllowance(previous, decimals),
      calldata,
      dryRun: Boolean(r.dryRun),
      gasSpeed,
      maxFeePerGasWei: maxFeePerGas?.toString(),
      maxPriorityFeePerGasWei: maxPriorityFeePerGas?.toString(),
    };

    if (previous === 0n) {
      throw new CommandError("ALLOWANCES_ALREADY_ZERO", `${symbol} allowance for ${spender} is already 0.`, "Nothing to revoke. Run `mm allowances audit` to see active allowances.");
    }
    if (r.dryRun) return base;

    const executor = await this.ctx.walletExecutor(io, this.pluginCommandId);
    const result = await executor({
      kind: "transaction",
      chainId,
      transaction: {
        to: token,
        data: calldata,
        value: 0n,
        ...(maxFeePerGas !== undefined ? { maxFeePerGas } : {}),
        ...(maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas } : {}),
        ...(gasSpeed ? { options: { speed: gasSpeed } } : {}),
      },
      intent: {
        summary: `Revoke ${symbol} allowance (${base.previousAllowanceFormatted}) granted to ${label ?? spender}`,
        action: "custom",
        details: { token, spender, previous: base.previousAllowanceFormatted },
      },
    });

    return {
      ...base,
      status: result.status,
      hash: result.kind === "transaction" ? result.hash || undefined : undefined,
      pollingId: result.pendingJob?.pollingId,
      failure: result.failureDescription,
    };
  }

  override successHint(data: RevokeResult): string {
    if (data.dryRun) return `Dry run: would send approve(${data.spender}, 0) to ${data.symbol} (${data.token}) on chain ${data.chainId}.`;
    if (data.hash) return `Revoked ${data.symbol} allowance for ${data.spenderLabel ?? data.spender}: ${data.hash}`;
    if (data.pollingId) return `Revocation submitted; awaiting approval. Track with: mm wallet requests watch ${data.pollingId}`;
    return `Revocation status: ${data.status ?? "unknown"}`;
  }
}
