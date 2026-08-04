# Shopping replay-eval corpus

Each task JSON follows `docs/DESIGN-replay-eval-harness.md` §5 and points to a
sanitized Playwright HAR containing only a stable product-page capture. All
`repeat` and money-path records use real products from operator-owned
`whitejade.xyz`; third-party stores are `novel` MISS cases only. The checkout
redirect chain is intentionally absent: checkout runs live against whitejade
in Shopify test mode through `runLiveWhitejadeCheckout`.

`capture-log.json` is the required under-seeding ledger. It records the v1
target, every captured task, and aggregate skipped counts with reasons.
