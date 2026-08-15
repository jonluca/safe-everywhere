# Security policy

Safe Everywhere is experimental transaction-signing infrastructure. It has not been audited. Do not fund its deployer with assets beyond the amount you are prepared to spend on Safe proxy deployment gas.

## Deployment checklist

- Start in dry-run mode and inspect every target plan.
- Use a new, dedicated deployer that is not a Safe owner and holds no valuable tokens.
- Enroll exact source creators or precomputed Safe addresses. Never operate an unfiltered public mirror.
- Use authenticated, chain-correct RPC endpoints and run `doctor` before `--execute`.
- Tune confirmation depths, maximum fee, gas, daily deployment, and target limits for every environment.
- Keep `.env`, SQLite state, logs, and RPC credentials out of source control. SQLite contains signed deployment transactions that can be rebroadcast.
- Prefer a non-exportable KMS/Vault/relayer signer before production use.
- Monitor signer balances, pending nonces, retries, conflicts, and deep source reorgs.
- Stop the service immediately if an unexpected source or destination is observed.

## Trust boundaries

The official Safe deployment package is pinned and its declared runtime code hashes are checked on-chain. RPC providers still influence the logs, blocks, code, fee estimates, simulations, and receipts presented to the daemon. High-value deployments should confirm source events through an independent provider.

The daemon only supports a restricted `Safe.setup` shape by default. Enabling arbitrary setup delegatecalls, payments, modules, fallback handlers, or contract owners can execute target-chain-specific code or produce a wallet whose authorization differs from the source.

Target creation cannot be rolled back if the source event is later removed by a deep reorganization. Confirmation settings are a risk control, not a mathematical guarantee.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for the repository. Do not publish exploit details in a public issue before a fix is available.
