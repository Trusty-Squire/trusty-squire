# Eval corpus — post-OAuth navigation planner

The committed, **redacted** corpus for the navigation-planner eval
(`docs/DESIGN-planner-navigation-eval.md`, Workstream A). Two sets, two jobs:

```
corpus/eval/
├── regress/          auto-derived from SUCCESSFUL captures' gold paths
│                     (build-corpus.ts). The merge gate: must stay 100%.
└── target/
    ├── tune/         hand-labeled N1 stuck pages — iterate the prompt here
    └── holdout/      sealed; report macro-avg lift, never tune on it (R5)
```

## How regress/ is built

`build-corpus.ts` walks the raw capture dir (`~/.trusty-squire/corpus/onboarding/`,
gitignored — it holds un-redacted live DOMs), joins each run's rounds to its
`*.outcome.json` sidecar (A2), and for every **successful** run emits one
`regress` case per equivalent page: `acceptKinds` = the UNION of observed step
kinds across all successful runs of that page; `rejectKinds` = kinds that left a
**failed** run stuck and were never good elsewhere (R1 — never reject a
known-good move). Every emitted case is run through the R3 redaction pass and
has its screenshot stripped before it lands here.

```bash
# dev harness — run from source with tsx (it's excluded from the published dist):
cd apps/mcp
npx tsx src/bot/build-corpus.ts          # default capture dir
npx tsx src/bot/build-corpus.ts <dir>    # explicit capture dir
```

The cases are content-hash-named for stable git diffs. **Only redacted cases
are committed** — the raw captures never leave `$HOME`.

## Running the gate

```bash
cd apps/mcp
UNIVERSAL_BOT_LLM_TIER=free npx tsx src/bot/eval-gate.ts
# → regress: X/X · target-tune: a/b · target-holdout: c/d   (exit 1 if regress < 100%)
```

The planner runs at temperature 0 (A1) so the result is deterministic. CI (A6)
wires `eval-gate` into a path-filtered workflow on planner-prompt changes.
