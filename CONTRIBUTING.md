# Contributing

Pull requests are welcome. Keep the default-deny safety model intact and include tests for every new factory method, Safe version, policy exception, or wallet adapter.

```bash
pnpm install
pnpm check
pnpm build
```

Changes that can sign or broadcast transactions must document their crash-recovery behavior, idempotency key, fee/budget enforcement, and post-transaction verification. New wallet-family adapters must state which address and authorization guarantees they preserve and must reject unsupported features instead of silently dropping them.
