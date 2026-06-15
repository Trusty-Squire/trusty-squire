# DESIGN — extraction engine (post-signup refactor, strangler slice 4)

Status: scoping + first pure extraction (2026-06-15). Owner: bot. Scope: the
universal signup bot's credential-EXTRACTION phase only. Fourth strangler-fig
slice of the agent.ts de-monolithing (A4 in `DESIGN-post-signup-nav-search.md`):
nav-search (default-on) → OAuth/consent (default-on) → form-fill (default-on) →
**extraction (this)** → capture-chain.

## Problem

`extractCredentials` (`apps/mcp/src/bot/agent.ts:12623`, ~125 lines) pulls the API
key off the credential surface via a FIVE-pass pipeline, each pass a different
source with its own I/O:

1. visible candidates (`extractCredentialCandidates` — input values + element text)
2. body text (`extractText`)
3. copy-button + clipboard recovery (`tryCopyButtonExtraction`) — when pass 1/2
   only saw a truncated display
4. hidden-input scan (`extractAllInputValues`)
5. copy-button colocation (`extractCredentialsNearCopyButtons`) — Railway's
   char-by-span `<code>` UUID

Interleaved with the I/O is a small but brittle DECISION policy: a doc-URL guard
(never trust a key on a docs SAMPLE page), per-candidate classification
(`extractApiKeyFromText` + `isTruncatedCapture` + the pass-4 UUID accept), the
**truncated-vs-full priority** (the S3 masked-key trap: a masked `sk-…1687…`
display must NOT win over a later full secret from the clipboard), and the final
resolution (`{api_key}` vs `{api_key_truncated}` vs `{}`). The policy is welded to
the I/O, so it can't be tested without a browser.

## Approach: the eng-reviewed stateful-reducer pattern (slices 2–3)

The executor owns ALL I/O (the five sources) AND the regex classification of each
candidate. This module decides only the cross-pass POLICY — accumulation +
resolution — over a `CandidateClass` the executor feeds it. (Dependency-injection
boundary, like oauth-flow.ts's `deps` — keeps the module browser-free and avoids a
circular import on the heavy `extractApiKeyFromText`/`isTruncatedCapture` helpers,
which stay in agent.ts until the wiring commit moves them here.)

## This commit — first pure primitives (the truncated-vs-full accumulator)

The most self-contained, highest-value pure piece, extracted to `extraction.ts`
with tests, NOT yet wired (cannot regress):

- `accumulateCandidate(state, c)` — fold one classified candidate: first FULL hit
  wins + is sticky; first TRUNCATED hit is remembered as a fallback, never
  overriding a full (faithful to `truncatedHit = truncatedHit ?? hit`).
- `hasFullHit(state)` — the executor stops scanning / skips remaining passes once
  a full hit lands.
- `resolveExtraction(state)` — the final record: `{api_key}` › `{api_key_truncated}`
  › `{}`, faithful to extractCredentials' tail.

## Migration (separate commits — Beck)

1. ✅ **Extract the pure primitives** (`dae8134`) — `extraction.ts` + 11 tests, unwired.
2. ~~Move the pure helpers~~ — **DROPPED as unnecessary.** The module takes a
   `CandidateClass` the EXECUTOR produces (dependency injection, like oauth-flow.ts's
   `deps`), so the heavy `extractApiKeyFromText`/`isTruncatedCapture` helpers never
   need importing into the module — no circular import, no risky ~570-line move.
3. ✅ **Wire behind `EXTRACTION_ENGINE`** (default-off, `8e91a37`) — `extractCredentials`
   early-returns to `extractCredentialsViaEngine`; the inline 5-pass pipeline stays
   byte-identical. The engine method owns the I/O + per-candidate classification and
   routes accumulation + resolution through the module. Faithful incl. passes 3+4
   accept FULL hits only (never record a truncated stub).
4. ◑ **Validate** live — PASS 1 validated (2026-06-15: `EXTRACTION_ENGINE=1` ipinfo
   → extracted api_key, `outcome=ok`). HELD before flipping default-on: ipinfo is a
   full-key pass-1 service, so the engine's risk path — the pass-2 truncated/clipboard
   recovery + the passes-3+4-full-only subtlety (the S3 masked-key trap this slice
   targets) — is NOT yet live-exercised. Flip only after a TRUNCATED-MODAL service
   (OpenRouter/Anthropic) validates the clipboard path, then delete the inline policy.
   (Deliberately not stacking a third unvalidated-risk-path flip on the same heal
   pass as form-fill + OAuth — clean attribution.)

## NOT in scope (this slice)

- The five candidate-source I/O methods (`extractCredentialCandidates`,
  `tryCopyButtonExtraction`, etc.) — stay in agent.ts/browser.ts.
- The credential regex/shape logic (`extractApiKeyFromText`) — moves in commit 2
  but its rules don't change.
- Multi-credential extraction (`replay-skill.ts` Phase D) — separate concern.
