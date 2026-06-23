# DESIGN — capture-chain (strangler slice 5): ALREADY EXTRACTED

Status: investigated 2026-06-15 — **no engine needed.** Fifth and final slice of
the agent.ts de-monolithing (A4 in `DESIGN-post-signup-nav-search.md`): nav-search
→ OAuth/consent → form-fill → extraction → **capture-chain (this)**.

## Finding

Unlike slices 1–4, the capture-chain phase is **already a clean standalone module**:
`apps/mcp/src/bot/onboarding-capture.ts`. It owns the whole capture concern —

- `captureOnboardingRound(entry)` — writes one round's case file, links it into the
  integrity hash chain (`prev_hash` ← `chainHead`), computes the deterministic
  `content_hash`.
- `captureRunOutcome(service, result)` — the A2 run-outcome sidecar (credential
  FIELD NAMES only — never values; R3 redaction).
- `capturedAnyRound()`, `resolveCaptureDir()` — chain/dir bookkeeping.
- Module-level chain state (`runId`, `chainHead`, `lastRound`).

There is **no welded decision machine** in agent.ts to carve into a reducer. The
only agent.ts residue is thin glue: the `this.captureChainRound` counter (the
gap-free contiguity discipline across the form-fill-preamble + post-verify phases)
and building the `OnboardingRoundCapture` entry at ~6 call sites. This module shipped
with the 0.7.0 closed-loop capture work — it predates the strangler effort, so the
"slice" was effectively done before the de-monolithing started.

## Decision: close the slice, no work

- No `CAPTURE_ENGINE` flag, no reducer — there is no decision policy to extract,
  only a pure module call + a counter bump.
- The ~6 call sites' one duplicated fragment (the conditional `resolved_model` /
  `resolved_provider` spread) is deliberately conditional for hash
  forward-compatibility (a round with no `resolved_*` keys must hash identically to
  the pre-Fix-C format). Centralizing it saves ~12 lines against a non-zero
  capture-corruption risk on a best-effort path that feeds skill auto-promote —
  not worth it.

## Net (the de-monolithing as a whole)

The signup brain's five phases are now all de-monolithed:

| Slice | Form | State |
|---|---|---|
| 1 nav-search | added phase + handoff (`nav-search.ts`) | default-on |
| 2 OAuth/consent | reducer (`oauth-flow.ts`, `OAUTH_ENGINE`) | default-on, validated |
| 3 form-fill | reducer (`form-fill.ts`, `FORM_FILL_ENGINE`) | default-on, validated |
| 4 extraction | module (`extraction.ts`, `EXTRACTION_ENGINE`) | wired, pass-1 validated |
| 5 capture-chain | module (`onboarding-capture.ts`) | already extracted — no engine |

Remaining to finish the effort: (a) the truncated-modal validation + flip for slice
4, and (b) delete the inline fallbacks for slices 1–3 after the heal pass. No new
slice work.
