# E2E — Operator surface (user-owned signup, sealed slots, consent, recipes)

Live, host-driven E2E scenarios for the `operate_*` surface, beyond the original
`E2E-signin-vault.md` (PR1–PR3) seven-phase walk. These target the surfaces that
landed with the operator/signin-vault work and the general provisioning moats.
Each scenario lists the **pass criteria** and the **invariant** it guards.

Run from the MCP host driving the live server. "Leak" = a secret/PII value the
host (an LLM planner whose context is logged) must never receive.

## Legend
- 🔒 privacy/security invariant · 🧪 functional · ⚙️ robustness
- Status after the 2026-06-28 run is noted per scenario (server = published
  `@trusty-squire/mcp@1.0.1-rc.1`).

---

## A — Consent fail-closed is "user-owned-or-nothing" 🔒
1. Start a signup, `prepare_login`, fill, submit to the verification wall.
2. `await_verification` with consent OFF.
- **Pass:** returns `needs_user` ("not consented"); URL does NOT move to a
  webmail host; the call returns in single-digit ms (no inbox I/O); the run does
  **not** silently fall back to a Squire alias.
- Guards: no-inbox-read-without-consent + no-alias-accounts.

## B — Consent is per-session and remembered 🔒
1. After A, `await_verification { grant_inbox_consent:true }` → it reads.
2. `await_verification {}` (no flag) again.
- **Pass:** step 2 still reads (consent remembered); audit shows a single
  `inbox_consent_granted{scope:"session"}`, not one per call.

## C — Observations never echo a sealed/password value 🔒  ⬅ NEW
1. `prepare_login`; `type_secret` the password slot into the password field.
2. `operate_observe`.
- **Pass:** the generated password appears in **no** part of the observation —
  not `elements[].value`, not the `accessibility.tree` `value="…"`, not the
  `elements[].label`/`screen` text (a label-less input must not fall back to its
  value). Filled state may show as a masked placeholder (`[sealed]`).
- Guards: the sealed-handle promise must survive the post-fill DOM read.

## D — Recipes carry no inbox content / no inbox steps 🔒 ⬅ NEW
1. Complete a verify-by-email flow (consent granted), then `operate_remember`.
2. Read the recipe file.
- **Pass:** no step whose host is a webmail provider (mail.google.com, …); no
  email subject/snippet text in any `text_match`; the literal user email is
  absent; secrets are slot refs (`stored:false`).
- Guards: a shared recipe must not leak the user's inbox.

## E — `prepare_login` with no captured identity hands back cleanly 🔒🧪
- With `provider-emails.json` absent: `operate_start` omits `user_email`;
  `prepare_login` returns `needs_user{wall:"user_email", resume:"connect"}`.
- **Pass:** fail-closed; never invents an address; never proceeds aliasless.

## F — `store_login` upsert is idempotent 🧪
1. `store_login {service}` → `{reference, type:"username_password", updated:false}`.
2. `store_login {service}` again (same session).
- **Pass:** second call `updated:true`; `list_credentials` shows ONE plunk
  username_password entry, not two; no raw password in either response.

## G — Generated-password freshness + policy 🧪
- Two separate `prepare_login` sessions.
- **Pass:** the two password slot previews/lengths differ (fresh per session);
  reported length ≥ policy minimum; only masked previews are ever returned.

## H — `goto` domain-scope gate blocks off-scope egress 🔒
- On an active session, `operate_act { goto, url:"https://evil.example.com/" }`
  and `goto` to a webmail host not in allowed_hosts.
- **Pass:** both throw a domain-scope error; the browser does not navigate; the
  service's own identity providers (accounts.google.com/github.com) remain
  reachable for OAuth.

## I — Sealed in-session credential transfer (extract→type_secret) 🔒🧪
- On a code-emitting service: `await_verification { into_slot:"otp" }` seals the
  code (masked handle, not digits); `type_secret { slot:"otp" }` into the field.
- **Pass:** the code never appears in any tool response; the masked handle fills
  the field; verification completes. (Needs a code service, e.g. Brevo — Plunk
  is link-based, so this is exercised separately.)

## J — `operate_use` replays a remembered recipe ⚙️
- `operate_use { name }` on a saved recipe.
- **Pass:** the recipe loads, replays its rail, and the postcondition is
  machine-checked (no secret value surfaces; sealed slots re-seal). Known
  limitation: a recorded one-time `verify-email?token=…` goto is single-use —
  replay should re-fetch via `await_verification` rather than reuse the token
  (tracked follow-up).

## K — `extract` blocked-reason honesty 🔒⚙️
- `operate_extract` on a login wall / interstitial with no credential present.
- **Pass:** returns `blocked_reason` (not an empty/garbage `api_key`); the host
  is told to drive login, not handed a false key.

---

### Run priority
Fast + safe to run without creating accounts: **C, H, E, G** (start + fill, no
submit). **A, B, D, F** need a signup driven to the verification wall. **I**
needs a code-based service. **J** mutates (creates a second account) — run last,
deliberately.
