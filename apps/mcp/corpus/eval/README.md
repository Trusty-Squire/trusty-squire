# Eval corpus — post-OAuth navigation planner

The committed, **redacted** corpus for the navigation-planner eval
(`docs/DESIGN-planner-navigation-eval.md`, Workstream A). Two sets, two jobs:

```
corpus/eval/
├── regress/          auto-derived from SUCCESSFUL captures' gold paths
│                     (build-corpus.ts). The merge gate: must stay 100%.
│                     REJECT-DRIVEN (R1): a case fails ONLY when the planner
│                     picks a known-wrong rejectKind (derived from a FAILED run
│                     on that page), never when it merely differs from the one
│                     historical accept kind. So a case from a purely-successful
│                     page (no rejects) is a vacuous pass until failed-run data
│                     gives it rejects — and a different eval model can't break it.
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

## How target/ is built (A4)

`target/` is hand-labeled — the ~20 N1 services whose post-OAuth navigation the
planner gets stuck on, across three themes: **create-resource**,
**locate-in-ui** (incl. 404 dead-ends), **finish-onboarding**. `label-target.ts`
does the mechanical part: it copies a real stuck-page capture, runs it through
the **same R3 redaction** as the regress builder (target cases are committed
too), and writes it to the right `tune`/`holdout` bucket with the operator's
label.

```bash
cd apps/mcp
npx tsx src/bot/label-target.ts ~/.trusty-squire/corpus/onboarding/<svc>-<run>-r<N>.json \
  --theme=create-resource --accept=click,navigate --reject=done,login,extract \
  --rationale='keys-empty page — must click Create, not give up' [--holdout]
```

Each case carries a `rationale` (audit trail) and `theme`. **`holdout/` is
sealed**: report its macro-avg lift, never iterate the prompt against it (R5).
The corpus is **30 cases (22 tune / 8 holdout)** across four themes
(create-resource, locate-in-ui, finish-onboarding, oauth-login-wall) — grown
from the initial 9 to dampen the per-case perturbation-fragility the first live
A7 run exposed (see findings below). Grow it further as new N1 services surface.

**Redaction covers operator identity, not just secrets.** The R3 pass also
scrubs the operator's account handle: it collects the local-part of every email
on the page (e.g. `lunchboxfortwo` from `lunchboxfortwo@gmail.com`) and removes
it everywhere — bare usernames leak as team names ("…'s team") and URL paths
(`/users/<handle>/…`) that carry no `@`. Generic role local-parts
(support/billing/security/…) are never treated as identities.

The high-entropy catch-all (unprefixed tokens / CSS-hash noise) is replaced with
a neutral `x`, NOT a `[REDACTED_TOKEN]` label — a page littered with "TOKEN"
strings biased the planner toward `extract` (an eval artifact that doesn't happen
on the real page). Set `TRUSTY_SQUIRE_REDACT_IDENTITIES=<handle>,…` so the
redactor always scrubs the operator's account handle (it leaks as a bare
username / avatar alt where the email never co-occurs).

## Running the gate

```bash
cd apps/mcp
UNIVERSAL_BOT_LLM_TIER=free npx tsx src/bot/eval-gate.ts
# → regress: X/X · target-tune: a/b · target-holdout: c/d   (exit 1 if regress < 100%)
```

The planner runs at temperature 0 (A1). Temp 0 alone is NOT enough for
cross-run reproducibility through OpenRouter: it load-balances one model across
multiple backend providers, and different providers decide differently even at
temp 0 — so knife-edge pages flip run-to-run. **For a deterministic gate, pin
the backend:** `UNIVERSAL_BOT_OR_PROVIDER="Google AI Studio"` (single provider,
fallbacks off, fixed seed; applies to the Gemini primary only, never the
Anthropic premium fallback). The absolute pass rate is then provider-specific;
the run-to-run *delta* of a prompt change is what the gate measures cleanly.
CI (A6) wires `eval-gate` into a path-filtered workflow on planner-prompt
changes.

## A7 findings (2026-06-05, first live iteration)

First live baseline (cheap Gemini, temp 0): `target-tune 5/6 · target-holdout 3/3`,
after fixing an image media-type bug it surfaced (commit ad664c6) `5/6 · 2/3`.
Two genuine misses, both finish-onboarding pickers the card-radio detector missed.

- **cloudinary (tune) — FIXED.** The use-case option is an illustrative
  placeholder `<input>` ("Optimize images for my…"); the real choices are
  preset buttons. Added a narrow planner bullet ("don't `fill` an example
  placeholder when preset option buttons exist") → tune 6/6, stable.
- **statsig + baseten (holdout) — NOT prompt bugs; perturbation-fragile at N=9.**
  Measured directly: adding a *semantically-neutral* filler line of similar
  length flips BOTH (baseten PASS→FAIL, statsig FAIL→PASS) even though temp 0
  makes each fixed prompt deterministic. Their decision boundary is razor-thin,
  so at a 9-case corpus a single knife-edge flip swings the holdout ±33% and the
  number stops being a trustworthy gate. Chasing them with wording is fighting
  an artifact (the overfitting the harness exists to prevent). **The real fix is
  corpus expansion** — grow the target set toward the design's ~20 services so
  per-case sensitivity is diluted, then the picker/extract patterns become
  tunable with a stable gate. statsig stays sealed (holdout); do NOT tune on it.

Net: ship the stable tune-validated fix; treat fragile holdout cases as a
corpus-size limitation, not a prompt defect.
