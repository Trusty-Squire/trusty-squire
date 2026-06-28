# DESIGN — Sign-in + Vault Credentials (user-owned signups)

Status: REVIEWED (eng review + codex outside voice; decisions resolved)
Branch: `plan/signin-vault-credentials`

## 1. Problem

When Squire signs a user up for a **non-OAuth (email) service**, the account
should belong to the **user** — their email, a vaulted password, re-loginable.
Today, when a signup fills a disposable `@trustysquire.com` **alias**, the account
is bound to a Squire-owned address the user can't reset, and the service's future
mail lands in Squire's inbox, not theirs.

## 2. Two meanings of "replay" — don't conflate them

This is the framing the whole plan hangs on.

- **Scope #1 — universal-bot replay (`replaySkill`). EXCISE.** The retired
  autonomous engine: `replay-skill.ts` executes a recorded recipe step-by-step
  with no agent in the loop, dispatched by the old async
  `provision`/`check_provision_status` tool via the Tier-2 router that lived in
  the swept `provision-any.ts`. In source it is **dead** — only the test CLI
  calls it (`skill-cli/cli.ts:863`); `tools.test.ts:88` asserts `provision` isn't
  exposed. The Resend/Render replays seen in production come from a
  **previously-installed build** (skew). Universal-bot residue; gets deleted,
  same family as the `agent.ts` / `provision-any.ts` sweeps.
  - **The alias lived here.** The disposable `@trustysquire.com` + inbox-service
    poll was scope #1's trick for getting a pollable inbox without a real Gmail
    session. It dies with scope #1.
- **Scope #2 — host/operator replay. RETAIN.** A **codex operator** (the
  housekeeper's `codex-runner`) or **the user, manually in-session**, drives the
  `operate_*` tools. A fetched skill is a **route hint**, not an executable
  recipe — what `provision-drive.ts:50` already does. Verification goes through
  `operate_await_verification` → `awaitVerification`.

The signin-vault feature is built **entirely in scope #2.**

## 3. No aliases. Every signup reads a real inbox.

With scope #1 gone, there is no disposable-alias path. Every signup uses a **real
email + real inbox**, and which one is decided by **whose Google profile is
driving the browser**:

- **End-user provision** → profile is the *user's* Google → fill the user's email,
  read the user's Gmail (consent-gated). Account is the **user's**.
- **Operator/housekeeper provision** → profile is the *operator's* Google
  (`lunchbox@trustysquire.ai`) → fill the operator's email, read the operator's
  *own* inbox. Squire's own mailbox, so no user consent involved. Account is
  Squire's (correct — these are test/discovery signups).

Consent therefore matters in **exactly one context**: an end-user reading their
own inbox. The alias was only ever a workaround for "no real inbox"; scope #2
always has one.

## 4. Consent model (RESOLVED)

**Consent gates exactly one thing: an end-user reading their own personal inbox.**
Reuse `consent_operator_inbox_otp` as that gate (decision A2); rename/comment it
so the name stops implying the *operator's* inbox. Gate exactly one site:
`awaitVerification`, and only when the active profile is an end-user. Do **NOT**
gate the API pollers (`operator-otp-poller`, `workspace-inbox`) — Squire mailboxes
(codex #3).

## 5. Decision 2 — user-owned by default, JIT consent at the wall (RESOLVED: B)

User-owned is the **default**, not an opt-in toggle. No aliases. The two moments:

**Fill time** (the instant the bot types into the email field): always the
**active profile's** email. No branch — end-user → user email, operator →
operator email.

**Verification wall** (retrieving the code after submit):

| Context | At the wall | Account owner |
|---|---|---|
| OAuth | no email step | user (OAuth) |
| Operator/housekeeper | read operator's own inbox (no consent) | Squire/operator |
| End-user, consent ON | auto-read user inbox | **user** |
| End-user, no consent, human present | **JIT prompt**: grant (→ auto-read) or paste the code | **user** |
| End-user, no consent, headless | **pause** (`needs_consent`), notify, resumable | user (pending) |

The headless end-user + no-consent run **pauses** rather than falling back to an
alias — the account is always the user's; the honest cost is that an unattended
signup without consent can't auto-finish until the user grants or pastes.

Why B: consent asked *at the wall for a named service* is understood far better
than an install checkbox (adoption + privacy), and it fails safe — granted →
fully automated + user-owned; nobody home → resumable pause, never a silent
Squire-owned account. Rejected: A (opt-in toggle) ships a dead opt-in and leaves
the default user Squire-owned; C (always manual code) taxes every signup.

## 6. Implementation — three PRs (sequencing A1)

### PR1 — Excise scope #1 (engine + alias path)
Delete the universal-bot replay engine and everything that only served it:
`replay-skill.ts`, the async `provision`/`check_provision_status` tool + Tier-2
dispatch, the `${EMAIL_ALIAS}` **synthesis** in `promote-to-skill.ts`, and the
alias use in the signup flow (`inbox-client` alias-poll for verification). Keep
the skill schema, synthesis-as-hint, and registry (scope #2 uses skills as hints).
- **Review:** `validateReplayGraph` validated the autonomous replay step-graph —
  goes with scope #1 unless it still guards skill structural integrity for the
  hint model.
- **Note (out of scope):** the broader inbox subsystem (inbound webhook,
  `EmailAlias`/`ReceivedEmail`) becomes unused by the signup flow; its full
  retirement is a separate cleanup, not this PR.
- No behavior change to scope #2. Deletion PR.

### PR2 — Enforce the consent flag (security fix, independent value)
Gate `awaitVerification` (`provision-session.ts:1648`): when the active profile is
an end-user and consent is OFF → refuse the user-inbox read, return `needs_user`.
Operator-context reads its own inbox unaffected. Not a one-liner (codex #5): the
in-memory `Session` (`:185`) has no consent field and `operate_await_verification`
(`provision-drive.ts:454`) passes only `session_id`. Thread consent `session.json`
(`session.ts:64`) → `operate_start` → `Session` → `awaitVerification`. Pollers
untouched. Ships independent of PR3.

### PR3 — User-owned accounts in the operator path (Decision B)
- **Identity resolution (codex #6 / R2) — RESOLVED: server is authoritative.**
  The user's email is the server `Account.email` — the verified Google identity
  the user *deliberately signed in with* (bound at OAuth, `oauth.ts:9,152`;
  guaranteed present, `notify.ts:11`). NOT the browser's incidental `u/0` account.
  The bot reads it via a new agent-authed endpoint (its `agent_session_token` →
  `auth.kind:"agent"` carries `account_id`). Consequence: `awaitVerification`'s
  hardcoded `mail/u/0` (`:1649`) is the bug — the inbox read must FOLLOW the
  authoritative identity (resolve the bound account's `/u/N`, or assert `u/0` is
  that account else hand back) so fill-email and read-inbox are the same identity.
  Linchpin; everything in §5 keys off it. Pieces: (1) server endpoint returning
  `Account.email` for agent auth; (2) api-client reader; (3) operator surface
  (start observation carries `user_email`); (4) align `awaitVerification`.
- **JIT consent at the wall** — end-user + no standing consent + human present →
  surface grant-or-paste; cache the grant. Headless → `needs_consent` pause.
  Reuses the `needs_user` hand-back machinery.
- **Redact personal email from the skill pipeline (codex #8 — privacy).** A
  host-driven user-email signup must template the address before any
  capture/promotion/synthesis persists or publishes it.
- **Vault {email, password} as account-credential lifecycle (codex #9).** Needs a
  pending→finalized state: write-before-submit leaves dead creds on failure;
  write-after loses creds if the vault write fails.

### PR4 — Dead-code audit & cleanup (after PR1-3 land)
Excising scope #1 and removing aliases strands far more than `replaySkill`. Run
the **fanout sweep** methodology proven on the universal-bot retirement: parallel
read-only agents partitioned by area, each using **codegraph to verify zero
callers repo-wide** before flagging anything; delete only HIGH-confidence
(zero verified callers), report NEEDS-REVIEW separately. Account for cross-repo
consumers (the external housekeeper) and dynamic wiring (MCP tool dispatch,
env-flag branches) before deleting.

**Candidate dead zones to audit (not a delete list — each needs verification):**
- **Replay engine residue:** `replay-graph.ts` / `validateReplayGraph`,
  skill-schema fields that only described scope #1 recipes (`await_email_code` /
  send-code step kinds, `entry_state` if unused by the hint model), replay tests.
- **Alias machinery:** `inbox-client.createAlias` + alias poll, alias-related
  env knobs, `INBOX_ALIAS_DOMAIN`.
- **The inbound-mail subsystem (largest, infra implications):** once no aliases
  are minted, nothing receives inbound mail — audit `packages/inbox`
  (`EmailAlias`, `ReceivedEmail`, parser, stores), the `/v1/webhooks/resend-inbound`
  route, `RESEND_INBOUND_SECRET`, the `trustysquire_inbox` database +
  `INBOX_DATABASE_URL`, and the inbox half of the retention cron. **Caveat:**
  confirm nothing else (operator OTP, workspace-inbox, any non-signup consumer)
  depends on it before retiring. The DB-drop + Fly-secret removal is an infra
  step that may spin into its own follow-up PR rather than landing in this one.
- **Config/docs drift:** env-knob tables, CLAUDE.md / AGENTS.md references to the
  retired paths.

Output: an orphan report + deletions for the verified-dead, with the
infra-bearing inbox retirement explicitly gated on its own verification.

## 7. Testing
- Unit: end-user consent OFF → `needs_user`, no read (PR2); operator context reads
  own inbox without a consent check; context resolution picks the right inbox;
  redaction templates the email; vault lifecycle handles signup-fail + vault-write-fail.
- Privacy regression: a user-email capture NEVER contains the literal address.
- Live: (a) end-user consent-grant → user-owned end-to-end; (b) end-user headless
  no-consent → resumable `needs_consent` pause (no alias, no Squire account);
  (c) operator/housekeeper signup → reads own inbox, completes.
- Excision safety: scope #2 (operator drive + skill-as-hint) unaffected after the
  `replaySkill`/alias deletion; existing operate/await tests pass.

## 8. Risks
- **R1 (resolved):** scope #1 dormant path → excised (PR1).
- **R2 (correctness, 8/10 — codex #6) — now the linchpin:** behavior keys off
  "whose profile is driving." Mis-detecting end-user vs operator → wrong inbox or
  a consent check applied to Squire's own mailbox. Resolve identity from the
  active profile explicitly; never assume.
- **R4 (resolved):** consent flag reused (A2) — no new schema.
- **R5 (privacy, 8/10 — codex #8):** user email leaking into a published skill.
  Redaction is a hard PR3 requirement.
- **R6 (data lifecycle — codex #9):** vault {email,password} needs
  pending→finalized; naive ordering loses or orphans creds.

## 9. NOT in scope
- OAuth signups (already user-owned identity).
- Vault encryption/storage model changes.
- Migrating already-created alias-bound accounts (one-way; out).
- Multi-credential synthesis (separate roadmap).
- Resurrecting scope #1 / any alias path (explicitly killed, not deferred).
- The inbox-subsystem **DB drop + Fly-secret removal** (the infra teardown) — PR4
  audits and removes the code; the destructive infra step is gated separately.

## 10. What already exists (reuse, don't rebuild)
- `awaitVerification` — real-inbox read via browser (`provision-session.ts:1634`).
- Consent-flag plumbing — install→session→pairing-token→API (built, just unenforced).
- `needs_user` hand-back machinery (the JIT-prompt + pause path reuses it).
- `password`-field detection in the operator path (`replay-skill.ts:1327` logic).

## 11. Failure modes
- **End-user, consent OFF, human present:** JIT grant-or-paste prompt; clear
  choice, not a silent read. ✓
- **End-user, consent OFF, headless:** `needs_consent` pause, resumable; no alias,
  no Squire-owned account. ✓
- **Context mis-detected (R2):** consent applied to operator's own inbox, or a
  user signup reads the wrong Gmail. **Linchpin — must be tested both contexts.**
- **User email source mismatch (R2/codex #6):** wrong inbox read or unrecoverable
  account. Authoritative-email resolution + test.
- **Vault write fails after account created (R6):** account exists, user locked
  out. pending→finalized ordering + test.

## 12. Implementation Tasks
P1 blocks ship; P2 same-branch.

- [ ] **T1 (P1, human: ~4h / CC: ~40min)** — PR1 — Excise scope #1 (replay engine + async provision tool + `${EMAIL_ALIAS}` synthesis + alias use in signup flow)
  - Surfaced by: §2 — universal-bot residue, dead in source, skew risk
  - Files: `apps/mcp/src/bot/replay-skill.ts`, `promote-to-skill.ts` (synthesis), the `provision`/`check_provision_status` registration, `inbox-client` alias-poll, `skill-cli` replay test
  - Verify: scope #2 (operator drive + skill-as-hint) unaffected; suites green
- [ ] **T2 (P1, human: ~5h / CC: ~40min)** — PR2 — Gate `awaitVerification` (end-user only) + thread consent into the session
  - Surfaced by: codex #3/#5 — unconditional user-inbox read; consent not in `Session` (`:185`) or `operate_await_verification` (`:454`)
  - Files: `provision-session.ts`, `provision-drive.ts`, `session.ts`
  - Verify: end-user OFF → `needs_user`, no read; ON → reads; operator context unaffected; pollers untouched
- [ ] **T3 (P1, human: ~30min / CC: ~10min)** — PR2 — Rename/comment the flag to name the user's inbox
  - Surfaced by: Code Quality — name says "operator", gates the end-user's inbox
  - Files: flag definition + plumbing; install summary copy
  - Verify: typecheck; copy matches behavior
- [ ] **T4 (P1, human: ~3h / CC: ~30min)** — PR3 — Context/identity resolution (end-user vs operator; email matches inbox read)
  - Surfaced by: codex #6 / R2 — the linchpin; `mail/u/0` hardcode
  - Files: `provision-session.ts`, operator drive path
  - Verify: end-user vs operator each resolve the right inbox; filled email matches read inbox; both contexts tested
- [ ] **T5 (P1, human: ~3h / CC: ~30min)** — PR3 — JIT consent prompt at the wall + remembered-consent cache + headless `needs_consent` pause
  - Surfaced by: Decision B — consent in-context; no alias fallback
  - Files: `provision-session.ts` (awaitVerification), `provision-drive.ts`, consent cache
  - Verify: no standing consent + human → grant-or-paste, grant remembered; headless → resumable pause
- [ ] **T6 (P1, human: ~3h / CC: ~25min)** — PR3 — Redact user email from captures/promotion/synthesis
  - Surfaced by: codex #8 (privacy)
  - Files: `onboarding-capture.ts`, `promote-to-skill.ts`, operator-recipe path
  - Verify: capture/published skill never contain the literal address
- [ ] **T7 (P2, human: ~4h / CC: ~40min)** — PR3 — Vault {email, password} with pending→finalized lifecycle
  - Surfaced by: codex #9
  - Files: operator drive path, vault store client
  - Verify: re-loginable on success; no orphan creds on failure; vault-write-failure test
- [ ] **T8 (P2, human: ~4h / CC: ~45min)** — PR4 — Fanout dead-code sweep of excision orphans (codegraph-verified)
  - Surfaced by: §6 PR4 — scope #1 + alias removal strands replay-graph/validateReplayGraph, dead skill-schema fields, alias machinery, config/doc drift
  - Files: repo-wide (partitioned: mcp / api / registry / packages / skill-schema), CLAUDE.md, AGENTS.md
  - Verify: each deletion has codegraph zero-callers repo-wide (+ cross-repo housekeeper check); suites green; orphan report for NEEDS-REVIEW items
- [ ] **T9 (P2, human: ~6h / CC: ~1h)** — PR4 — Inbound-mail subsystem retirement assessment + code removal
  - Surfaced by: §6 PR4 — no aliases minted → nothing receives inbound mail
  - Files: `packages/inbox`, `apps/api/src/routes/resend-webhook.ts`, retention cron (inbox half), env tables
  - Verify: confirm NO non-signup consumer (operator-otp, workspace-inbox) depends on it; remove dead code; **DB drop + `RESEND_INBOUND_SECRET`/`INBOX_DATABASE_URL` removal gated as a separate infra step (NOT in this task)**

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 10 findings (1 high: dormant replay path; 1 privacy: email leakage) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | scope reduced to 3 PRs; all decisions resolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** confirmed the consent correction (gate only `awaitVerification`), found the dormant replay path, the privacy leak, and a simpler approach. All folded in.
- **CROSS-MODEL:** strong agreement; the rename-vs-bind tension is moot now that scope #1 (and the alias path) is excised.
- **DECISIONS RESOLVED:** A1 split-into-3-PRs · A2 reuse consent flag · D1 excise scope #1 / retain scope #2 · D2 = B (user-owned default, JIT consent at the wall, headless = resumable pause, **no aliases**).
- **VERDICT:** ENG CLEARED — ready to implement. Build order: PR1 (excise scope #1 + alias path) → PR2 (consent enforcement, security fix) → PR3 (user-owned accounts, Decision B) → PR4 (codegraph-verified dead-code sweep of excision orphans + inbound-mail retirement; destructive infra teardown gated separately). PR2 may ship independently.

NO UNRESOLVED DECISIONS
