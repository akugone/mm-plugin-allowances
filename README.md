# mm-plugin-allowances

A [MetaMask Agent Wallet](https://docs.metamask.io/agent-wallet/) plugin that adds two commands to the
`mm` CLI:

| Command | Capability | What it does |
|---|---|---|
| `mm allowances audit --chain-id <id>` | `wallet-read` | Scans `Approval` events for your wallet, then reads every live `allowance()` on-chain. Lists active approvals, flags unlimited ones, labels well-known spenders (Permit2, Uniswap, 1inch, 0x, Seaport, Aave, MetaMask Swaps…). |
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
mm allowances audit --chain-id 8453 --lookback 500000 --json
mm allowances audit --chain-id 1 --spender 0x000000000022D473030F116dDEE9F6B43aC78BA3   # only Permit2

mm allowances revoke --chain-id 1 --token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --spender 0x000000000022D473030F116dDEE9F6B43aC78BA3 --dry-run
mm allowances revoke --chain-id 1 --token 0xA0b8… --spender 0x0000…
```

`audit` output (JSON):

```json
{
  "owner": "0x…",
  "chainId": 1,
  "scanned": { "fromBlock": "…", "toBlock": "…", "approvalEvents": 42, "pairs": 17 },
  "totals": { "active": 5, "unlimited": 3 },
  "allowances": [
    { "token": "0x…", "symbol": "USDC", "decimals": 6, "spender": "0x…", "spenderLabel": "Uniswap Permit2",
      "allowance": "1157920892373161954235709850086879078532699846656405640394575840079131296399…",
      "allowanceFormatted": "unlimited", "unlimited": true, "lastApprovalBlock": "…", "lastApprovalTx": "0x…" }
  ],
  "hint": "Revoke one with: mm allowances revoke --chain-id <id> --token <token> --spender <spender>"
}
```

### With an AI agent

Any agent that drives `mm` (Claude Code, Codex, Cursor, Hermes…) can now be told *"audit my token
approvals on Base and revoke the unlimited ones I don't use"*. The revoke step still passes through
MetaMask's Guard Mode policy and 2FA, so the agent cannot skip your confirmation.

## Notes and limits

- The scan is event-based: approvals older than `--lookback` blocks (default 250 000) are not found. Widen the
  window or pass `--from-block` for a full history. Each `eth_getLogs` call covers `--chunk` blocks (default 5000);
  lower it if your RPC rejects the range.
- Only standard ERC-20 `Approval` events are considered (no Permit2 internal allowances, no ERC-721/1155
  `setApprovalForAll`). Those are natural follow-ups.
- Spender labels are informational and may be incomplete.

## Development

```bash
npm install
npm run build
mm config set experimentalPlugins true
mm config set experimentalAllowUnverifiedInstalls true
mm plugins link .          # or: mm plugins install "file:$PWD" --accept-permissions
mm allowances audit --help
```

## License

MIT
