# Shopping replay-eval corpus

Each task JSON follows `docs/DESIGN-replay-eval-harness.md` §5 and points to a
sanitized Playwright HAR containing only a stable product-page capture. All
`repeat` and money-path records use real products from operator-owned
`whitejade.xyz`; third-party stores are `novel` MISS cases only. The checkout
redirect chain is intentionally absent: checkout runs live against whitejade
in Shopify test mode through `runLiveWhitejadeCheckout`.

`capture-log.json` is the authoritative under-seeding ledger. It records the v1
target, every captured task, aggregate skipped counts with reasons, and the
live-verified checkout-review totals and completion gap.

Re-run the constrained all-cold capture from the MCP package:

```bash
pnpm -F @trusty-squire/mcp eval:replay:capture
```

Pass `-- --task <task-id>` to capture one record. The command prints measured
recordings; it does not update task JSON automatically.
