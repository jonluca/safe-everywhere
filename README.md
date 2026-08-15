# Safe Everywhere

[![CI](https://github.com/jonluca/safe-everywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/jonluca/safe-everywhere/actions/workflows/ci.yml)

Safe Everywhere watches canonical Safe proxy factories and automatically replays an opted-in Safe deployment on other compatible EVM chains. When the CREATE2 prerequisites match, every replica has the same address, creation-time owners, threshold, singleton, and fallback handler as the source.

The daemon is dry-run by default. Real transactions require `--execute`, a dedicated funded gas-payer key, and an enrolled source creator or Safe address.

> This is early-stage infrastructure that can spend native tokens on multiple chains. Test with fresh keys and testnets before enabling mainnet execution. It is not affiliated with Safe.

## What it does

1. Scans finalized blocks for creation events from factory addresses in [`@safe-global/safe-deployments`](https://github.com/safe-global/safe-deployments).
2. Fetches and decodes the direct factory transaction to recover the original singleton, byte-identical initializer, and salt nonce.
3. Accepts only `createProxyWithNonce` and `createProxyWithNonceL2` for Safe v1.3.0, v1.4.1, and v1.5.0.
4. Applies a default-deny policy: source enrollment, no setup delegatecall, no setup payment, official fallback handler, no contract owners, and bounded gas/spend rate.
5. Verifies factory, singleton, and handler runtime code hashes on both chains.
6. Simulates the exact target call and requires its returned address to equal the source Safe address.
7. Signs and persists the exact transaction before broadcast, reconciles it without blocking later polling cycles, waits for confirmations, then verifies the target singleton, owner set, and threshold.
8. Persists cursors, observations, fingerprints, jobs, transaction hashes, and replayable signed transactions in SQLite so restarts and duplicate logs are idempotent.

Safe’s [multi-chain deployment documentation](https://docs.safe.global/advanced/smart-account-multi-chain-deployment) explains why the factory, singleton, initializer, salt, and proxy creation code must all match.

## Default chain set

The example configuration includes these major production networks:

| Network           | Chain ID | Safe versions discovered at runtime |
| ----------------- | -------: | ----------------------------------- |
| Ethereum          |        1 | 1.3.0, 1.4.1, 1.5.0                 |
| OP Mainnet        |       10 | 1.3.0, 1.4.1, 1.5.0                 |
| BNB Smart Chain   |       56 | 1.3.0, 1.4.1, 1.5.0                 |
| Gnosis Chain      |      100 | 1.3.0, 1.4.1, 1.5.0                 |
| Polygon           |      137 | 1.3.0, 1.4.1, 1.5.0                 |
| Mantle            |     5000 | 1.3.0, 1.4.1, 1.5.0                 |
| Base              |     8453 | 1.3.0, 1.4.1, 1.5.0                 |
| Arbitrum One      |    42161 | 1.3.0, 1.4.1, 1.5.0                 |
| Celo              |    42220 | 1.3.0, 1.4.1, 1.5.0                 |
| Avalanche C-Chain |    43114 | 1.3.0, 1.4.1, 1.5.0                 |
| Linea             |    59144 | 1.3.0, 1.4.1, 1.5.0                 |
| Scroll            |   534352 | 1.3.0, 1.4.1, 1.5.0                 |

Contract support is not hard-coded in that table. The pinned official deployment registry supplies addresses, ABIs, deployment variants, and code hashes at runtime. Any additional EVM chain can be added to YAML, but the bot fails closed unless the exact observed factory/singleton tuple exists and verifies on the destination.

zkSync Era is intentionally excluded from same-address mode because Safe documents its nonstandard CREATE2 environment as incompatible with ordinary replay. Non-EVM equivalents are discussed under [Scope and roadmap](#scope-and-roadmap).

## Quick start

Requirements: Node.js 24+ and pnpm 11.22.0.

```bash
pnpm install
cp .env.example .env
cp config/chains.example.yaml config/chains.yaml
```

Set a reliable RPC URL for each enabled network and replace `SAFE_CREATOR_ADDRESS` with the transaction sender that is permitted to create source Safes. For sources deployed by a relayer, pre-enroll the predicted Safe address under `allowedSafeAddresses` instead of trusting a shared relayer.

Run the full preflight. It checks every configured RPC chain ID and every registered Safe contract code hash:

```bash
pnpm dev -- doctor --config config/chains.yaml
```

Scan, simulate, and print plans without signing anything:

```bash
pnpm dev -- once --config config/chains.yaml
pnpm dev -- start --config config/chains.yaml
```

After testnet validation, fund a dedicated gas-payer address on each destination, set its private key, and explicitly enable execution:

```bash
DEPLOYER_PRIVATE_KEY=0x... pnpm dev -- start --config config/chains.yaml --execute
```

The deployer pays gas only. It is rejected if it appears in the Safe owner set.

## Configuration and safety controls

`config/chains.example.yaml` is the canonical starting point. Important controls:

- `allowedCreators` / `allowedSafeAddresses`: at least one enrollment is mandatory in execute mode. Mirroring every public Safe would let an attacker drain the bot by creating cheap source Safes.
- `confirmations`: source events are ignored until this depth. Tune this per network; an L2 confirmation count is not automatically equivalent to L1 finality.
- `startBlock`: `latest` scans only a small overlap near startup. Use an explicit block for controlled backfills. Historical backfills require an archive-capable RPC because source owner/threshold/code checks are performed at the creation block.
- `maxDeploymentsPerRun` and `maxDeploymentsPerDay`: circuit breakers for transaction volume.
- `maxEstimatedGas` and `maxFeePerGasGwei`: reject expensive plans and defer execution during fee spikes.
- `maxTargetsPerSafe`: caps fan-out.
- `requireCanonicalSetup`: rejects deployment-time delegatecalls, payments, and unknown handlers.
- `allowContractOwners`: false by default because the corresponding contract may not exist on the target.
- `create2Compatible`: set false for chains whose address derivation is not ordinary EVM CREATE2.

Every destination signer must use the same private key environment variable, but the key is never stored in SQLite or logged. SQLite does contain signed deployment transactions so a crash can safely rebroadcast them; protect the database as operationally sensitive. Use a low-balance hot key only for development; production should replace the signer layer with KMS, Vault, or a managed relayer.

## Commands

```text
safe-everywhere doctor [--config PATH]
safe-everywhere once   [--config PATH] [--execute]
safe-everywhere start  [--config PATH] [--execute]
safe-everywhere status [--config PATH]
```

`status` reads persisted job counts without contacting RPC endpoints. `once` is useful for cron or supervised batch operation. `start` continuously polls with bounded `eth_getLogs` ranges; it does not depend on lossy WebSocket subscriptions.

## Docker

The Compose service deliberately starts in dry-run mode:

```bash
cp config/chains.example.yaml config/chains.yaml
cp .env.example .env
docker compose up --build
```

Add `--execute` to the Compose command only after `doctor` and dry-run output have been reviewed.

## Supported and rejected creations

Automatic replay currently requires all of the following:

- a direct transaction to a registered Safe proxy factory;
- Safe v1.3.0 or later;
- `createProxyWithNonce` or `createProxyWithNonceL2`;
- the exact source factory and singleton addresses/code on the destination;
- a canonical `Safe.setup` initializer with owners, a valid threshold, no delegatecall, zero payment, and an official or zero fallback handler;
- an enrolled source creator or exact Safe address; and
- ordinary CREATE2 behavior on the destination.

The bot detects and records, but does not automatically replay:

- `createChainSpecificProxyWithNonce*`, whose salt includes the chain ID;
- legacy `createProxy`, deprecated callback deployments, and Safe versions before 1.3;
- creations nested inside EntryPoint, multicall, a wrapper, or another contract (the event omits the salt; trace recovery is not implemented yet);
- arbitrary setup modules/guards/delegatecalls or nonzero setup payments;
- nonofficial fallback handlers and contract owners under the default policy; and
- target addresses containing incompatible code.

## Important semantics

- This clones deployment-time state only. Later owner, threshold, guard, or module changes are independent on every chain.
- Owner ordering remains byte-identical in the initializer even though verification compares the semantic owner set.
- Replaying an Ethereum `Safe.sol` singleton onto an L2 preserves the address, but Safe warns that event-only L2 services may not index it like `SafeL2.sol`.
- Waiting for confirmations reduces source-reorg risk but cannot make an irreversible target deployment undoable. A deep source reorg requires operator intervention.
- SQLite supports a single daemon instance. Multi-worker operation needs a leased PostgreSQL job backend and durable nonce reservations.

## Architecture

```text
finalized factory logs
        │
        ▼
version-aware decoder ──► enrollment + initializer policy
        │
        ▼
SQLite observation / deterministic fingerprint
        │
        ▼
per-chain replication jobs
        │
        ▼
registry code-hash check ──► exact-address simulation
        │
        ▼
sign + submit ──► receipt reconciliation ──► on-chain verification
```

The `AccountAdapter` interface keeps discovery, translation guarantees, deployment planning, and verification explicit for future wallet families.

## Scope and roadmap

“Equivalent multisig” is not a portable on-chain standard. Solana Squads, Stellar weighted signers, Cosmos multisigs, and Bitcoin policies use different account identifiers, signature rules, thresholds, and deployment models. Guessing a key mapping would be unsafe.

The current MVP therefore implements Safe-to-Safe replication across compatible EVM chains. A future non-EVM adapter must take an explicit user-provided identity map, label the result as a policy translation at a different address, and state which security guarantees it preserves. It must never claim to be an address-preserving clone.

Near-term work:

- signed Safe-owner enrollment rather than static allowlists;
- trace-based recovery for batched/EntryPoint creation;
- PostgreSQL workers, durable nonce lanes, replacement transactions, and per-chain native-token budgets;
- explicit finality adapters and source-orphan incident reconciliation;
- metrics/alerts and KMS/relayer signer backends;
- Anvil multi-chain integration and reorg tests; and
- opt-in translated adapters, beginning with a separately configured Solana key map.

## Development

```bash
pnpm check
pnpm build
```

The repository uses strict TypeScript, Vitest, Oxlint, and Oxfmt. See [SECURITY.md](SECURITY.md) before deploying with funded keys.

## License

MIT
