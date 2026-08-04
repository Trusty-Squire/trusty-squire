# Shopping replay-eval corpus

Each task JSON follows `docs/DESIGN-replay-eval-harness.md` §5 and points to a
sanitized Playwright HAR containing only a stable product-page capture. The
checkout redirect chain is intentionally absent: checkout runs live against
`whitejade.xyz` in Shopify test mode through `runLiveWhitejadeCheckout`.

`capture-log.json` is the required under-seeding ledger. It records the v1
target, every captured task, and aggregate skipped counts with reasons.
