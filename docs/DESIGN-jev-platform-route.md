# DESIGN: Jev decisions as a platform call (no per-user TypeSafe key)

**Status:** proposed 2026-09-18. Reviewed by /plan-eng-review the same day (report at the end).

## Problem

Trusty Squire's Jev client (`apps/mcp/src/bot/jev-client.ts`) reaches TypeSafe's System One through the user's own vault credential: service `typesafe`, label `default`, the vault substituting `${SECRET}` on `POST https://api.typesafe.ai/v1/systemone`. Every user must obtain a TypeSafe key, store it in their vault, and pay TypeSafe directly before any Jev-driven feature works. The operate_drive loop (in flight) makes Jev the default deciding layer for every drive, so this setup wall would make the loop's first release read as broken.

## Decision

Jev becomes a platform call. The API holds one TypeSafe key as a Fly secret and exposes one route the MCP calls with its ordinary agent session. Per-account usage is recorded in a small ledger. A user who has stored their own `typesafe` credential keeps using it (bring-your-own-key), because that override already exists in the client and costs nothing to keep. No config knob, no new gate.

## What changes

### API: `POST /v1/decide`

- Auth: the existing `requireAgent` preHandler, exactly like `/v1/vault/use`. The general per-account hourly limit in `apps/api/src/auth/middleware.ts` does NOT count this route (captain, 2026-09-18): a drive makes one decision per step, and decisions must never throttle a legitimate drive or the account's other calls. The size check below is the route's only bound.
- Body: `{ state: string, questions: Record<string, JevQuestion> }`, the same body the client already builds. Validation: `state` at most 32 KiB and at most 12 questions, each Choice at most 128 criteria (a cart page measured 28 candidates; nav-heavy pages run higher). That is a size check so the platform key cannot be used as a free general endpoint; it comfortably fits the compact map plus a capped history (the scout measured 420 to 1,830 input tokens per call).
- Forward, using the same bounded outbound fetch `/v1/vault/use` already uses (its timeout and response-size handling, no new helper): `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer <TYPESAFE_API_KEY>` and `{ state, model: "jev-latest", questions }`. Pass the upstream status and body back verbatim; the MCP client already knows how to read 200/503/529/422. No retry on the API side: the client owns retry and backoff today and keeps owning it, so the two never stack.
- Ledger: one row per call in a new `DecisionEvent` model, mirroring the shape of `CaptchaEvent`: `account_id`, `occurred_at`, `model`, `input_tokens`, `output_tokens`, `upstream_status`, `latency_ms`, `questions` (count), indexed on `(account_id, occurred_at)` for the monthly sum. Written after the upstream reply, best effort, never blocking the response.
- Secret: `TYPESAFE_API_KEY` on the API app, set the way the Telegram bot token is set. Absent secret means the route answers 503 with `jev_unconfigured`; the client reports that as `jev_unavailable` and the drive returns partial progress, exactly as an upstream outage does today.

### MCP: `jev-client.ts`

- `askJev` calls `api.decide(state, questions)` (a new ApiClient method next to `useCredential`) instead of the vault path.
- If the account has a `typesafe` credential in its vault, the client uses the existing `useCredential` path instead. Detection is one `listCredentials` call per session, cached on the session, the same way `captcha-solve.ts` detects the user's 2captcha key today.
- Retry, backoff, budget, and error classes are unchanged.
- The firstmate dispatch resolver is not part of this; it stays on its own key.

### Usage visibility

`GET /v1/usage` (existing `getUsage`) gains a `decisions` block: `{ month_calls, month_input_tokens, month_output_tokens }` computed from the ledger. Nothing is billed; the number exists so pricing can be decided from real use.

## Cost

TypeSafe's published price is $0.042 per million input tokens. The scout measured a 4-decision drive at $0.00025 and a 40-step drive at about $0.003. A thousand drives a day is about three dollars a day. Not a constraint.

## Not in scope

- Billing, tiers, quotas, or per-account caps beyond the existing hourly limit.
- Any retry, caching, or model routing on the API side.
- Changing what the loop sends to Jev; the route is a pass-through.
- A dashboard; the usage block is enough.

## Failure modes

| Failure | Behavior |
|---|---|
| TypeSafe 503/529 storm | passed through; client retries with its existing backoff, then `jev_unavailable` |
| Secret absent on the API | 503 `jev_unconfigured`; client treats as unavailable |
| Oversized state | 413 with the limit named; the loop caps history so this only fires on misuse |
| Upstream hangs | the shared outbound fetch's timeout returns 504 `jev_timeout`; client treats as unavailable |
| Ledger write fails | logged, response unaffected |
| User has their own key | vault path, platform route never called |

## Test plan

- API: route requires agent auth and is not counted by the hourly limit; forwards body and returns upstream status/body verbatim (mocked upstream); size limits reject; upstream timeout returns 504; absent secret returns 503; ledger row written with token counts; usage block sums the month.
- MCP: `askJev` calls `/v1/decide` by default, uses the vault path when a `typesafe` credential exists (detected once per session and cached), retries 503/529 through the route the same as before; existing jev-client tests keep passing with the transport swapped.
- Live: one real drive on the branch with no `typesafe` credential in the test account's vault completes decisions through the route; the ledger shows the rows.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | skipped | Codex weekly quota exhausted; no fallback reviewer in this home |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 6 issues folded, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

Eng review 2026-09-18. Scope accepted as the minimum: one route, one ledger model, one client method, a transport swap, a usage block, tests.
What already exists and is reused: `requireAgent`, the `/v1/vault/use` bounded outbound fetch, `CaptchaEvent` as the ledger shape, `/v1/usage`, `useCredential` and the whole jev-client retry path, `captcha-solve.ts`'s per-session credential-listing pattern for the bring-your-own-key override, Fly secrets as set for the Telegram bot token.
Findings folded: (1) BYOK detection was underspecified; it is one cached `listCredentials` per session, the captcha pattern; (2) the criteria cap of 64 was too tight for nav-heavy pages, now 128; (3) upstream hang had no bound, now the shared outbound fetch timeout with 504; (4) the ledger needs an `(account_id, occurred_at)` index for the monthly sum; (5) reuse the vault-use fetch helper, no new one; (6) the general hourly limit would throttle heavy drives, decide is excluded (captain decision).
Captain decisions: exclude `/v1/decide` from the hourly limit; dispatch on Cursor now.
NOT in scope: billing, tiers, per-account caps, API-side retry or caching, model routing, dashboard, any change to the loop's requests.
Failure modes: all listed in the table above are tested except the ledger-write failure, which is logged and cannot affect the response.
Parallelization: sequential; API and MCP halves are small and share the request contract.
**VERDICT:** ENG CLEARED — ready to implement.
NO UNRESOLVED DECISIONS
