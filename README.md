# mm-plugin-allowances

A [MetaMask Agent Wallet](https://docs.metamask.io/agent-wallet/) plugin that adds two commands to the
`mm` CLI:

| Command | Capability | What it does |
|---|---|---|
| `mm allowances audit --chain-ids <id,id,…>` | `wallet-read` | Scans `Approval` events for your wallet, then reads every live `allowance()` on-chain. Lists active approvals, flags unlimited ones, labels well-known spenders (Permit2, Uniswap, 1inch, 0x, Seaport, Aave, MetaMask Swaps…). |
| `mm allowances revoke --chain-id <id> --token <addr> --spender <addr>` | `wallet-read`, `wallet-submit` | Sends `approve(spender, 0)` through the MetaMask wallet executor, so the revocation gets the same policy checks, Blockaid scan and 2FA as any transaction. `--dry-run` shows the calldata without sending. |

Why: unlimited token approvals left behind by DEXes and dapps are the most common way wallets get drained
after a spender contract is compromised. Agents that trade on your behalf create approvals all day; this
gives them (and you) a one-command way to see and clean them up, without leaving the MetaMask security
pipeline.

## Install

Plugins are a beta feature of the `mm` CLI (≥ 6.2.0):

```bash
mm config set experimentalPlugins true
mm plugins install mm-plugin-allowances
```

You will see a consent screen listing the two commands and their capabilities.

## Usage

```bash
mm allowances audit --chain-id 1
mm allowances audit --chain-ids 1,8453,42161 --json          # several chains in one call
mm allowances audit --chain-id 8453 --lookback-days 90 --json
mm allowances audit --chain-id 1 --spender 0x000000000022D473030F116dDEE9F6B43aC78BA3   # only Permit2

mm allowances revoke --chain-id 1 --token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --spender 0x000000000022D473030F116dDEE9F6B43aC78BA3 --dry-run
mm allowances revoke --chain-id 1 --token 0xA0b8… --spender 0x0000…
mm allowances revoke --chain-id 11155111 --token 0x1c7D… --spender 0x0000… --gas-speed high
mm allowances revoke --chain-id 11155111 --token 0x1c7D… --spender 0x0000… --max-fee-gwei 5 --priority-fee-gwei 1.5
```

Gas: `--gas-speed low|medium|high` picks the estimator tier; `--max-fee-gwei` / `--priority-fee-gwei` set
EIP-1559 fees explicitly, which is the fix when the server wallet answers `rpc_fee_too_low` (seen on
Sepolia, where the base fee moves faster than the estimate).

`audit` output (JSON):

```json
{
  "owner": "0x…",
  "chainIds": [1, 8453],
  "chains": [
    { "chainId": 1, "scanned": { "fromBlock": "…", "toBlock": "…", "approvalEvents": 42, "pairs": 17 }, "totals": { "active": 4, "unlimited": 3 } },
    { "chainId": 8453, "scanned": { "…": "…" }, "totals": { "active": 1, "unlimited": 0 } }
  ],
  "totals": { "active": 5, "unlimited": 3, "chainsScanned": 2, "chainsFailed": 0 },
  "allowances": [
    { "chainId": 1, "token": "0x…", "symbol": "USDC", "decimals": 6, "spender": "0x…", "spenderLabel": "Uniswap Permit2",
      "allowance": "1157920892373161954235709850086879078532699846656405640394575840079131296399…",
      "allowanceFormatted": "unlimited", "unlimited": true, "lastApprovalBlock": "…", "lastApprovalTx": "0x…" }
  ]
}
```

### With an AI agent

Any agent that drives `mm` (Claude Code, Codex, Cursor, Hermes…) can now be told *"audit my token
approvals on Base and revoke the unlimited ones I don't use"*. The revoke step still passes through
MetaMask's Guard Mode policy and 2FA, so the agent cannot skip your confirmation.

## Notes and limits

- Several chains: `--chain-ids 1,8453,42161` scans them one after the other; a chain that fails (unsupported, RPC error) is reported in `chains[].error` while the others still return. `--from-block` is single-chain only.
- The scan is event-based and windowed: by default it covers the last **30 days**, converted into blocks with the
  chain's block time (≈ 216 000 blocks on Ethereum, ≈ 1.3 M on Base, ≈ 10 M on Arbitrum). Widen with
  `--lookback-days`, pin an exact window with `--lookback <blocks>` or `--from-block`. Each `eth_getLogs` call covers
  `--chunk` blocks (default 10 000); lower it if your RPC rejects the range. Long windows on fast chains mean many
  calls: on Arbitrum, 30 days is about a thousand requests. In `--json` mode progress is only shown with `--verbose`.
- Only standard ERC-20 `Approval` events are considered (no Permit2 internal allowances, no ERC-721/1155
  `setApprovalForAll`). Those are natural follow-ups.
- Spender labels are informational and may be incomplete.

## Development

```bash
npm install
npm run build
# A local (file:) install is a symlink into this folder, so Node resolves imports from here and finds the
# devDependency copy of @metamask/agent-wallet before the host's copy (which mm links into its data dir).
# Two copies = two PluginCommand classes = "Plugin command must extend PluginCommand" in the consent hook.
# Build with the devDependency copy (types), then point the plugin at the host's copy before installing:
rm -rf node_modules/@metamask/agent-wallet
ln -s "$(npm root -g)/@metamask/agent-wallet" node_modules/@metamask/agent-wallet
mm config set experimentalPlugins true
mm config set experimentalAllowUnverifiedInstalls true
mm plugins install "file:$PWD" --accept-permissions
mm allowances audit --help
mm allowances revoke --token 0x… --spender 0x… --chain-id 1 --dry-run --json
```

Installs from npm (`mm plugins install mm-plugin-allowances`) do not need the symlink step: the package is
copied into mm's data dir, where the host's `@metamask/agent-wallet` is the one that resolves. All inputs
are named flags on purpose: explicit `--token` / `--spender` are less error-prone for agents than
positionals.

## License

MIT
