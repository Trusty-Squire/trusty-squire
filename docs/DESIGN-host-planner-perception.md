# DESIGN — Session-Model Brain + Folded-In Eyes/Hands + Credential-Broker Moat

Status: REVIEWED (eng review complete — see report at end)
Author: Lunchbox + Claude Opus
Date: 2026-06-24
Supersedes: nothing. Relates to `DESIGN-planner-navigation-eval.md`,
`DESIGN-post-signup-nav-search.md`.

## Problem

Despite ~15k lines in `agent.ts` + ~10k of substrate, the housekeeper does
**not** generalize on virgin signups. What actually cracks a service today is
a human-directed loop: point a frontier model at the failure logs, edit the
bot, rebuild, re-run, iterate until pass. The crutches in `agent.ts`
(`clickViaJs`, false-shell gate, combobox handlers) are the fossil record of
that loop. The cost per service is roughly constant → the curve is linear and
the operator is the bottleneck. **It does not scale.**

Spike B (2026-06-24) proved a frontier model drives a never-seen LangWatch
signup to a live API key with generic browser primitives and **zero
per-service code**. The novelty that would have become new crutches was
handled at runtime by intelligence.

This design moves the frontier intelligence from *offline code-iteration* to
*runtime driving*, and reframes Trusty Squire from "the signup driver" to
"the credential-broker moat the driver plugs into."

## Key findings that shaped the design

1. **The `LLMClient.createMessage` seam already exists** (`bot/llm-client.ts:87`);
   `pickLLMPair()` is the one swap point. `ClaudeCliClient` already proves a
   frontier model can be the planner.
2. **MCP `sampling/createMessage` is unusable.** Unsupported by Claude Code,
   Cursor, AND Codex today (verified via their issue trackers). A draft spec
   change (SEP-2577) also signals deprecation, but the load-bearing fact is
   the present support gap. The only universal transport to a host model's
   intelligence is **tools**.
3. **Most of `agent.ts` is weak-planner crutch, not substrate.** The substrate
   (browser.ts, oauth-*, inbox-client, credential-extraction-flow,
   onboarding-capture) is already factored into sibling modules. (Marker-line
   counts are weak evidence; the point is the substrate is modular and
   reusable, not that agent.ts is "disposable.")
4. **Perception is the ceiling.** `observe()` reliability bounds every planner.
   TS isolates elements with a CSS-selector list + `getBoundingClientRect`; it
   misses custom React widgets, hidden-but-real inputs (the spike missed a
   Chakra ToS checkbox), and JS-click-handler-only elements.
5. **browser-use's `buildDomTree.js` is injected JS (MIT)** — CDP
   `getEventListeners()` + ARIA/cursor heuristics + visibility + a selector
   map. Portable into TS via patchright; **no Python in the npx package.**
6. **browser-use the package is Python+Rust → cannot be bundled.** But its
   value (perception) is portable; its hands (navigate/click/type) TS already
   has. So we **fold in the capability, not the dependency** — one install,
   no Python, no separate MCP server. browser-use is a design source.
7. **browser-use has no inbox/phone.** It can only read a code visible in the
   browser. Email/SMS/TOTP receipt is exactly TS's moat.
8. **browser-use cloud already commoditizes stealth + captcha + proxies** — a
   slow-burn signal that the hand-rolled anti-bot layer is not the moat; the
   inbox + vault + registry are.

## The architecture (locked)

```
USER'S CODING AGENT (Claude Code / Cursor / Codex)  ── the BRAIN (frontier, free to TS)
   │  drives a tool loop exposed by ONE MCP server:
   │
   └──►  @trusty-squire/mcp  (single npm install, pure TS, no Python)
          ┌─ FAST PATH ─────────────────────────────────────────────┐
          │  registry replay: skill exists → ~30s, skip the drive    │
          └──────────────────────────────────────────────────────────┘
          EYES   observe()          ← ported buildDomTree.js (Track 0)
          HANDS  click/type/goto    ← existing browser.ts
          MOAT   captcha_gate()     ← TS 2captcha + behavior-sim
                 verify_email()     ← alias inbox OR user-inbox-via-browser
                 extract+capture()  ← credential-extraction-flow → OF#1 skill
                 vault store/use    ← WRITE-ONLY (agent can never read secrets)
```

The session model handles novelty (the long tail) at runtime; the registry is
the fast/reliable cache; the model fills runtime variance and drift when a
replay diverges. The 15k-line bot becomes "a box of tools the smart driver
calls," not the engine. The housekeeper keeps its own self-driving loop (no
host on the operator box) — see "Autonomous loop" below.

### Architecture evolution during review (honest record)

- First draft proposed 3 tracks. Track 1 (end-user host-as-planner) was
  **deferred** mid-review on UX/security grounds, then **revived and reshaped**
  by the operator: the session model IS the brain, but it drives TS-native
  folded-in tools (not a separate browser-use server, not MCP sampling).
- "browser-use as the housekeeper driver" (orig. Track 2) is **not** adopted —
  it duplicates the stack and would have to rebuild capture/promotion/taxonomy.
  The autonomous loop instead gets frontier driving via the existing
  `LLMClient` seam (`ClaudeCliClient`), reusing all substrate + capture.

## Verification channels

| Channel | Mechanism | Status |
|---|---|---|
| **Alias inbox** (housekeeper, TS-controlled `trustysquire.com`) | inbox-alias long-poll | ✅ have it |
| **OAuth-bound operator inbox** (housekeeper) | operator IMAP poller | ✅ have it |
| **User's own inbox** (end-user provisions under their real email) | **NEW** — read via the install-seeded browser session | design below |
| **SMS OTP** | — | ⚠️ gap (TS relays via user today). Buy an SMS-receive provider as a tool when the SMS-gated tier matters. |
| **TOTP / authenticator** | — | ⚠️ gap (neither TS nor browser-use). Long-tail. |

### NEW — user's own inbox via the seeded browser session

The install's step-3 OAuth login already writes the user's Google session into
the provisioning Chrome profile. So the browser is **already logged into the
user's Gmail** — no IMAP, no app-password, no `gmail.readonly` scope. The
authenticated session IS the credential.

```
brain hits email-verification screen
  └─► read_verification_email(sender, since)   ← SCOPED TOOL, not inbox free-rein
        goto mail.google.com  (already signed in)
        search "from:<sender> newer_than:<since>"
        open top result, extract link/code
        return ONLY that message's code/link
  brain clicks link / types code
```

**Why a scoped search-and-extract tool, not "browse the inbox":** bounds both
the privacy exposure (touches one matching message) and the prompt-injection
blast radius (a malicious page cannot steer the agent into "forward all your
mail" because the agent never holds the open inbox).

**Privacy posture (a design principle, not a tactic):** TS holds NO mail
credential and NO persistent mail token. It drives an already-authenticated
*local* browser for one task-scoped read the user could watch. This is a
*better* posture than IMAP or a mail OAuth scope, and it keeps "TS cannot read
your inboxes" true at the server/API level. Generalizes to any webmail the
user is signed into.

**Routing:** alias signup → TS inbox-poll (existing); user's-own-email signup
→ browser-read (new). The brain picks the tool by which email the signup used.

## Packaging — fold in, no separate install

browser-use (Python+Rust) cannot bundle into the single-bin npm package. We
fold in the **capability**: port `buildDomTree.js` (injected JS, MIT) for
`observe()`; reuse `browser.ts` for the hands. Result: ONE
`npx @trusty-squire/mcp` install, no Python, no second MCP server, one trust
boundary. Cost: a vendored perception snapshot that drifts from upstream — we
own the re-sync cadence. browser-use stays a design source; revisit a
separate-install/cloud integration only if perception maintenance or managed
captcha later justifies it.

## Security posture

- **Write-only vault de-fang.** The agent reads untrusted signup pages while
  holding browser tools, but the vault is write-only — it CANNOT read a stored
  secret back. The worst injection outcome ("exfiltrate my keys") is off the
  table by construction. This makes session-model-as-brain safer for TS than
  for a generic browser-tool MCP.
- **Domain-scope** the browser tools to the target signup origin + its
  OAuth/IdP hosts + the mail host; reject navigation elsewhere.
- **Scoped verification tool** (above) bounds inbox exposure.
- **Audit-log** every navigation + tool call.
- **Consent at install:** disclose that completing email verification reads the
  verification message in the user's signed-in browser email.

## Refusal posture

The frontier brain can stochastically refuse ToS-gray automation; the reliable
trigger is captcha solving, which is kept OUT of the model's decisions
(`captcha_gate()` is a tool). Residual stochastic refusal is handled by
**graceful fallback to the proxy/autonomous path**, not by the tools — a refusal
must produce an explicit state handoff, not a silent missing tool call.

## Autonomous loop (housekeeper, no host)

The housekeeper keeps its self-driving loop but gains frontier driving via the
existing `LLMClient` seam (`ClaudeCliClient` / a frontier model), reusing all
substrate + capture + promotion. NOT browser-use (avoids a second stack and
rebuilding OF#1 emission). Frontier cost is bounded, operator-paid, and only
until a skill is captured (then cheap replay). This is the scalable form of the
manual code-iteration loop: novelty handled at runtime, crutch pile stops
growing.

## What already exists (reuse)

- `LLMClient`/`pickLLMPair`, `ClaudeCliClient` — planner seam + frontier proof.
- `browser.ts` — the hands.
- `runCaptchaGate`, oauth-*, inbox-client, credential-extraction-flow,
  onboarding-capture — the thick-tool backings + OF#1 flywheel.
- registry + replay — the fast path / cache.
- eval-onboarding corpus — A/B harness for Track 0 perception.

## NOT in scope

- MCP sampling transport — unsupported today; tools only.
- Deleting `agent.ts` — the housekeeper needs the self-driving loop.
- Bundling browser-use (Python) into the npm package — fold in the JS only.
- browser-use as the housekeeper driver — duplicate stack; use the seam.
- Gmail API / `gmail.readonly` scope — the browser-session read avoids it.
- SMS-receive + TOTP — separate buy/defer when the SMS-gated tier matters.
- Making OAuth consent / "I agree" into tools — keep them visible to the driver.

## Kill criteria (each track needs a hard threshold)

- **Track 0 (perception):** must lift virgin-signup success on the eval corpus
  by ≥X% AND not regress simple forms AND not explode `observe()` latency
  (>Nms p95) — else revert the flag.
- **Frontier driving (housekeeper):** must beat the gemini-flash baseline on
  ≥5 known-hard discover services on success rate at acceptable $/signup — else
  keep escalate-on-stall only.
- **User-inbox read:** zero cross-message leakage in negative tests; clean
  re-auth state on session expiry — else gate behind explicit per-run consent.
- **Captcha:** already tiered — behavior-sim → click-and-wait → 2captcha (Tier
  3, reCAPTCHA v2 *image* challenges only). The residual risk is NOT solver
  coverage; it is **Turnstile / reCAPTCHA v3 hardening**, which a token solver
  CANNOT fix (those are behavior/IP-scored — solver tokens get rejected). If
  Turnstile's anti-AI-agent toggle starts blocking, the only lever is
  **stealth + residential IP** (browser-use cloud's managed stealth+proxy, or
  better behavior-sim + our own residential egress), not another solver.

## Sequencing

1. **Track 0** (port buildDomTree → `observe()`), behind a flag, A/B on the
   corpus + a heal pass. Helps the *current* bot immediately.
2. **Frontier driving on the housekeeper** via the existing seam; bake-off on
   ~5 known-hard services.
3. **End-user session-model brain** (folded-in tools + scoped verification),
   after perception is proven.

## Spike validation (TestAtlas + Vouchflow + LangWatch, 2026-06)

Drove three real targets via a throwaway patchright daemon on a seeded
`verify-241` Google session. LangWatch: signup → API key. Vouchflow: blocked
(service 500/Redis-down, not a bot problem). **TestAtlas: Google-OAuth login →
authenticated dashboard → solved 2 SAT diagnostic questions** (a reading
central-idea question + a math slope question read off a *graph image*), both
accepted. Four findings, now load-bearing:

1. **Judgment is the easy part.** Reading comprehension + reading a graph image
   + computing a slope — a deterministic script flatly cannot do this; a
   frontier model does it trivially. The "replace a human with a browser" value
   is real and lives entirely in the brain.
2. **Plumbing is the fragile part — and it is exactly TS's moat.** The OAuth
   popup stranded the naive daemon (page pointer on a closed popup), forcing a
   restart + a profile `SingletonLock` cleanup. `agent.ts` already solves this
   (`settleAfterOAuth`, profile management). **Architecture, demonstrated:
   frontier brain on top, TS's hardened substrate as the hands.** The brain is
   trivial; the OAuth/session/profile plumbing that makes the brain *reachable*
   is the hard, owned part.
3. **Stale handles happen live.** Index-based targeting drifted (one index =
   two different buttons across calls); had to switch to click-by-text. **Hard
   requirement: target by text/role/stable-attr with re-resolution, never
   positional index.** (Codex flagged this; the spike proved it.)
4. **Off-the-shelf browser-use can't inherit the seeded session.** "Use
   browser-use" means integrating it onto TS's already-authenticated browser
   context, not dropping it in. The authenticated session is TS's, not
   browser-use's.

**Consequences for the plan:**
- **buildDomTree port is DROPPED.** TS's `extractInteractiveElements` already
  does cursor-pointer cards (browser.ts:6200), hidden-checkbox-behind-label
  (G12), shadow DOM, GIS iframes. The only residual (CDP `getEventListeners`)
  is marginal. Not worth a vendored snapshot.
- The first build is the **frontier-driving loop on TS's own substrate**, NOT a
  browser-use adoption. browser-use is evaluated later, only for the
  open-ended console-task surface where TS's signup-tuned substrate doesn't
  generalize, and only integrated onto TS's authenticated context.

## Build plan & sequencing

The unifying frame is the **three-tier universal adapter**: API → deterministic
skill replay → frontier judgment, with capture promoting judgment runs to cheap
replay. TS already runs this ladder for signups; the build generalizes it.

**Inversion (2026-06-25):** the end-user judgment path LEADS. The housekeeper
is the amortization layer (pre-build skills for cheap replay) — conditional on
proof it's needed. If a frontier model in the user's context signs up reliably
on demand, pre-discovery has little to amortize and may be obviated entirely.
Build the product first; build amortization only if the data demands it.

- **Phase 1 (front and center) — End-user frontier driving + thick tools.**
  The user's own agent (Claude Code/Cursor) drives provisioning IN THEIR
  CONTEXT via TS thick tools exposed over MCP: `observe()`
  (`extractInteractiveElements`, **targeted by text/role/stable-attr with
  re-resolution, never index** — finding 3), `click/type/goto`, `handle_oauth`,
  `captcha_gate`, `await_verification` (incl. the user-inbox-via-browser read),
  `extract`, plus a **registry-replay-if-a-skill-exists** fast path. The host
  drives the loop; TS provides the tools + the entry contract (`provision`
  returns the first observation + the drive contract). **Security posture is
  Phase-1 work, not deferred** — domain-scope to target origin + IdP + mail
  host, write-only-vault de-fang, scoped verification tool, consent at install,
  audit log — because we lead with user-context exposure. *Validate:* does the
  user's agent, given these tools, reliably provision a never-seen service
  in-context? (LangWatch + TestAtlas spikes already say yes.)
- **Phase 2 — Capture → optional cheap replay.**
  A successful run MAY synthesize a skill (reuse promote-to-skill) for ~30s
  replay next time. This is now an OPTIMIZATION, not the engine — built only
  if Phase-1 data shows repeat/popular services justify amortization.
- **Phase 3 — Generalize the task beyond signup.**
  Extend to arbitrary action sequences + verification checkpoints
  ("configure X", console tasks). **Evaluate browser-use here** — only for
  open-ended consoles (GCP/Firebase, admin) where TS's substrate doesn't
  generalize, integrated onto TS's authenticated browser.
- **Phase 4 (conditional — possibly obviated) — Autonomous housekeeper
  discovery.** Pre-building skills across a curated queue only pays off if
  frontier-on-demand ISN'T enough. Build only if Phase 1 proves a gap
  (cost/latency/popular-service amortization) that pre-discovery fills.

## Phase 1 — BUILT & VALIDATED (2026-06-25)

The interactive host-driven provisioning surface is built, unit-tested (full
suite 2142 green), and validated live end-to-end.

**Default-on (2026-06-25)** — `PROVISION_DRIVE_TOOLS` flipped to opt-out
(`=0` to disable). Domain-scope + write-only-vault de-fang + per-action audit
log are in; consent-at-install is the remaining hardening.

**Code:**
- `bot/provision-session.ts` — session registry over `BrowserController`:
  `start / observe / act / captcha_gate / await_verification / extract / finish`.
  Text/role targeting with re-resolution every act; domain-scoped `goto`; OAuth
  via `startOAuth`/`settleAfterOAuth`; extraction reuses the bot's regex policy
  + clipboard read; audit log on every action (no credential values).
- `tools/provision-drive.ts` — the 7 MCP tools.

**Validated live** (verify-242, fresh identity):
- Full virgin LangWatch signup through the tools: Auth0 → `oauth_click` (popup
  adopted) → account → consent → `oauth_settle` → org+ToS+4-step wizard →
  Manually → Show key → `provision_extract` → real `sk-lw-…` key.
- `await_verification` navigated the user's real Gmail via the seeded session
  and searched (mechanism proven; full-OTP-extract awaits a live OTP service).
- `captcha_gate` correctly reports no-captcha; audit trail clean.

**Bugs found+fixed live:** observation lacked `href` (404 from URL-guessing);
extraction merge-order clobbered the real key with the SDK-snippet prefix;
env-var-name (`LANGWATCH_API_KEY=`) false-positived as a key.

**Validation gaps — closed (2026-06-25):**
- **Email-OTP extraction** — the parser (`parseVerification`) is unit-tested
  (keyword-proximity code + link picker, 6 cases); the Gmail-read mechanism is
  live-proven. A live signup (Resend) walled at submit on its invisible
  Turnstile — the anti-bot reality, not a tool bug — so the parser is validated
  by test, not by fighting the wall.
- **`js_click` + post-action settle** — added for the React radio-card stall.
- **Extraction robustness** — env-var-name guard + min-length guard kill the
  `LANGWATCH_API_KEY=` / `Ctrl+K` false positives (live-found).
- **Clipboard read** — wired into extract; LangWatch's `/settings/api-keys`
  live test was inconclusive (existing keys not re-copyable + clipboard-focus
  under Xvfb) — a service/env limitation, the read path is in place.

**Still open:** captcha detection on a *visible* challenge (no easy live
target; the gate reuses the bot's proven detector), a live email-OTP through a
non-walled service, and **consent-at-install** (the one security item left
before this is fully hardened). Phases 2-4 unchanged.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 2 architecture decisions resolved (Track 1 defer→reshape; Track 2 shape); 6 codex hardening items folded |
| Outside Voice | `/codex` | Independent 2nd opinion | 1 | issues_found | prompt-injection trust boundary (headline); observe() secret-leak; stale handles; cross-origin iframes; no kill criteria; future-dated spec claim |

- **CODEX:** headline — "optimizes planner intelligence while under-specifying
  trust boundaries." Folded: write-only-vault de-fang, domain-scope, scoped
  verification tool, audit log, kill criteria, softened the sampling-spec claim.
- **CROSS-MODEL:** both reviewers independently said defer/de-risk end-user
  host-as-driver; operator reshaped it (session-model brain + folded-in TS
  tools + write-only-vault de-fang) rather than dropping it.
- **VERDICT:** ENG reviewed — architecture locked, sequencing set, kill criteria
  defined. Ready to implement Track 0 first. Test plan + failure-mode coverage
  owed at implementation time (perception A/B, negative tests for inbox leakage,
  refusal-fallback handoff).

**UNRESOLVED DECISIONS:**
- Turnstile/reCAPTCHA-v3 hardening response (NOT a solver decision — 2captcha
  is already in use for v2-image). If the 2026 anti-AI-agent toggle starts
  blocking, do we lean on browser-use cloud's managed stealth+residential proxy
  or invest further in our own behavior-sim + residential egress? Deferred to a
  pass-rate kill-criterion, not decided now.
