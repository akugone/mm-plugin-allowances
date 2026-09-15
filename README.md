# mm-plugin-allowances

A [MetaMask Agent Wallet](https://docs.metamask.io/agent-wallet/) plugin that adds two commands to the
`mm` CLI:

| Command | Capability | What it does |
|---|---|---|
| `mm allowances audit --chain-ids <id,id,…>` | `wallet-read` | Scans `Approval` events for your wallet, then reads every live `allowance()` on-chain. Lists active approvals, flags unlimited ones, labels well-known spenders (Permit2, Uniswap, 1inch, 0x, Seaport, Aave, MetaMask Swaps…). Also audits the per-app allowances held **inside Permit2** (amount, spender, expiration). |
| `mm allowances revoke --chain-id <id> --token <addr> --spender <addr>` | `wallet-read`, `wallet-submit` | Sends `approve(spender, 0)` through the MetaMask wallet executor, so the revocation gets the same policy checks, Blockaid scan and 2FA as any transaction. With `--permit2`, sends `Permit2.lockdown([...])` instead, zeroing one or several Permit2 allowances in one transaction. `--dry-run` shows the calldata without sending. |

Why: unlimited token approvals left behind by DEXes and dapps are the most common way wallets get drained
after a spender contract is compromised. Agents that trade on your behalf create approvals all day; this
gives them (and you) a one-command way to see and clean them up, without leaving the MetaMask security
pipeline.

## Install

Plugins are a beta feature of the `mm` CLI (≥ 6.2.0). Until the package is on npm, install from source:

```bash
git clone https://github.com/akugone/mm-plugin-allowances && cd mm-plugin-allowances
npm install && npm run build
rm -rf node_modules/@metamask/agent-wallet
ln -s "$(npm root -g)/@metamask/agent-wallet" node_modules/@metamask/agent-wallet
mm config set experimentalPlugins true
mm config set experimentalAllowUnverifiedInstalls true
mm plugins install "file:$PWD" --accept-permissions
```

Once published, it will be `mm plugins install mm-plugin-allowances` and a consent screen listing the two
commands and their capabilities. Verified end to end on Sepolia with a MetaMask server wallet in Guard
Mode (email 2FA).

## Usage

```bash
mm allowances audit --chain-id 1
mm allowances audit --chain-ids 1,8453,42161 --json          # several chains in one call
mm allowances audit --chain-id 8453 --lookback-days 90 --json
mm allowances audit --chain-id 1 --spender 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD    # one spender (ERC-20 and Permit2)
mm allowances audit --chain-id 1 --skip-permit2                                            # ERC-20 approvals only

mm allowances revoke --chain-id 1 --token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --spender 0x1111111254EEB25477B68fb85Ed929f73A960582 --dry-run
mm allowances revoke --chain-id 1 --token 0xA0b8… --spender 0x1111…
mm allowances revoke --chain-id 1 --permit2 --token 0xA0b8… --spender 0x3fC9…                          # one Permit2 allowance
mm allowances revoke --chain-id 1 --permit2 --token 0xA0b8…,0xC02a… --spender 0x3fC9…,0x3fC9…          # several, one lockdown() tx
mm allowances revoke --chain-id 11155111 --token 0x1c7D… --spender 0x0000… --gas-speed high
mm allowances revoke --chain-id 11155111 --token 0x1c7D… --spender 0x0000… --max-fee-gwei 5 --priority-fee-gwei 1.5
```

Gas: `--gas-speed low|medium|high` picks the estimator tier; `--max-fee-gwei` / `--priority-fee-gwei` set
EIP-1559 fees explicitly, which is the fix when the server wallet answers `rpc_fee_too_low` (seen on
Sepolia, where the base fee moves faster than the estimate).

### Permit2

[Permit2](https://github.com/Uniswap/permit2) changes what "unlimited" means. The wallet gives Permit2 **one unlimited
ERC-20 approval per token**, once. Every app (Uniswap routers, aggregators…) then receives its own allowance *inside*
Permit2 by user signature, with an amount, an expiration (Uniswap defaults to 30 days) and a nonce. So:

- An unlimited ERC-20 approval to the canonical Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) is the
  **expected** state. `audit` still lists it, but with `"expected": true`, a note, and it is **not** counted in
  `totals.unlimited`. Revoking it breaks every Permit2-based app for no security gain.
- The real exposure is the list of Permit2-internal allowances. `audit` scans Permit2's `Approval` and `Permit`
  events for your wallet in the same window, reads each live `Permit2.allowance(owner, token, spender)` and reports
  them under `permit2[]` with amount, labelled spender, and whether they are **expired** (harmless) or live. An
  unlimited, unexpired Permit2 allowance towards an unknown spender is the red flag.
- `revoke --permit2 --token <t> --spender <s>` sends `Permit2.lockdown([{token, spender}])` to Permit2, not
  `approve(Permit2, 0)` to the token. Comma-separated `--token`/`--spender` lists (same length, same order) are
  zeroed in a single transaction. Pairs already at 0 are skipped and reported. Same wallet executor, policy,
  Blockaid scan and 2FA as an ERC-20 revoke.

`audit` output (JSON):

```json
{
  "owner": "0x…",
  "chainIds": [1, 8453],
  "chains": [
    { "chainId": 1,
      "scanned": { "fromBlock": "…", "toBlock": "…", "approvalEvents": 42, "pairs": 17, "skippedNonErc20": 0, "permit2Deployed": true, "permit2Events": 6, "permit2Pairs": 4 },
      "totals": { "active": 4, "unlimited": 2, "expected": 1, "permit2": { "active": 2, "unlimited": 1, "expired": 2 } } },
    { "chainId": 8453, "scanned": { "…": "…" }, "totals": { "…": "…" } }
  ],
  "totals": { "active": 5, "unlimited": 2, "expected": 1, "permit2": { "active": 2, "unlimited": 1, "expired": 2 }, "chainsScanned": 2, "chainsFailed": 0 },
  "allowances": [
    { "chainId": 1, "token": "0x…", "symbol": "USDC", "decimals": 6, "spender": "0x1111…", "spenderLabel": "1inch Aggregation Router v5",
      "allowance": "1157920892373161954235709850086879078532699846656405640394575840079131296399…",
      "allowanceFormatted": "unlimited", "unlimited": true, "expected": false, "lastApprovalBlock": "…", "lastApprovalTx": "0x…" },
    { "chainId": 1, "token": "0x…", "symbol": "USDC", "decimals": 6, "spender": "0x000000000022D473030F116dDEE9F6B43aC78BA3", "spenderLabel": "Uniswap Permit2",
      "allowance": "…", "allowanceFormatted": "unlimited", "unlimited": true, "expected": true,
      "note": "Canonical Permit2: unlimited by design. Apps spend through Permit2 allowances (see permit2[]), revoke those instead.",
      "lastApprovalBlock": "…", "lastApprovalTx": "0x…" }
  ],
  "permit2": [
    { "chainId": 1, "token": "0x…", "symbol": "USDC", "decimals": 6, "spender": "0x3fC9…", "spenderLabel": "Uniswap Universal Router",
      "amount": "1461501637330902918203684832716283019655932542975", "amountFormatted": "unlimited", "unlimited": true,
      "expiration": "1760400000", "expiresAt": "2025-10-14T00:00:00.000Z", "expired": false, "nonce": "3",
      "lastEventBlock": "…", "lastEventTx": "0x…" }
  ]
}
```

`allowances[]` is sorted flagged-unlimited first, then limited, then expected (Permit2) last; `permit2[]` live
unlimited first, expired last. `totals.active` counts every non-zero ERC-20 allowance, expected ones included;
`totals.unlimited` excludes them. `totals.permit2.active` and `.unlimited` only count unexpired Permit2 allowances.

`revoke` output (JSON) carries `via` (`"erc20"` or `"permit2"`) and `to` (the token, or Permit2). In Permit2 mode
the zeroed allowances are under `pairs[]` (with their previous amount and expiration) and any pair already at 0
under `skippedAlreadyZero[]`.

### With an AI agent

Any agent that drives `mm` (Claude Code, Codex, Cursor, Hermes…) can now be told *"audit my token
approvals on Base and revoke the unlimited ones I don't use"*. The agent gets the Permit2 distinction for free: the expected approval
to Permit2 is marked as such, and the `permit2[]` entries tell it to add `--permit2`. The revoke step still passes through
MetaMask's Guard Mode policy and 2FA, so the agent cannot skip your confirmation.

## Notes and limits

- Several chains: `--chain-ids 1,8453,42161` scans them one after the other; a chain that fails (unsupported, RPC error) is reported in `chains[].error` while the others still return. `--from-block` is single-chain only.
- The scan is event-based and windowed: by default it covers the last **30 days**, converted into blocks with the
  chain's block time (≈ 216 000 blocks on Ethereum, ≈ 1.3 M on Base, ≈ 10 M on Arbitrum). Widen with
  `--lookback-days`, pin an exact window with `--lookback <blocks>` or `--from-block`. Each `eth_getLogs` call covers
  `--chunk` blocks (default 10 000); lower it if your RPC rejects the range. Long windows on fast chains mean many
  calls: on Arbitrum, 30 days is about a thousand requests. In `--json` mode progress is only shown with `--verbose`.
  The Permit2 scan adds one `eth_getLogs` per chunk (on the Permit2 address only, skipped where Permit2 has no
  code); `--skip-permit2` turns it off.
- Standard ERC-20 `Approval` events and Permit2 `Approval` / `Permit` events are considered. ERC-721/1155
  `setApprovalForAll` and other approve-once contracts (Permit2 forks, custom relayers) are not: only the canonical
  Permit2 address is treated as expected. Natural follow-ups.
- Permit2 expirations are compared with the local clock, not the chain's `block.timestamp`; an allowance expiring
  within a few seconds may be reported live.
- Spender labels are informational and may be incomplete. Deterministic deployments (Permit2, Seaport, 1inch, 0x, ParaSwap) are labelled on every chain; others (Uniswap routers, Aave, MetaMask Swaps) only on the chains where that address is known.
- `revoke` always acts on the wallet `mm` has selected (`mm wallet select`); `audit` can read any address with `--address`.
- Token `symbol()` values are sanitised (control characters stripped, 24 chars max) so a hostile token cannot inject text into your terminal or an agent's context.

## Development

```bash
npm install
npm test
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
mm allowances revoke --permit2 --token 0x… --spender 0x… --chain-id 1 --dry-run --json
```

Installs from npm should not need the symlink step: according to MetaMask's plugin reference the package is
copied into mm's data dir and the host links its own `@metamask/agent-wallet` next to it (not verified yet,
the package is not published). All inputs
are named flags on purpose: explicit `--token` / `--spender` are less error-prone for agents than
positionals.

## License

MIT
