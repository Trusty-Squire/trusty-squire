# DESIGN — Anti-bot hardening (fighting the Turnstile / reCAPTCHA-v3 hard wall)

Status: **Slice 1 implemented + tested + API deployed (2026-06-01).**
Items 2–6 recorded as deferred — pick up after the A/B telemetry reads
out. Branch `antibot-cdp-telemetry`; both packages build + typecheck +
full suites green (MCP 943, API 197).

Deploy state:
- **API: DEPLOYED.** `flyctl deploy` ran the guarded `release_command`
  (`prisma db push`) successfully → `CaptchaEvent.stealth_profile` column
  is live in prod `trustysquire`. API health 200.
- **mcp republish: PENDING.** Carries the rebrowser dep. Blocked on
  `NPM_AUTOMATION_TOKEN` (not available in this environment; the vault is
  write-only so the token can't be fed to the npm CLI). NOT required for
  the operator A/B — the housekeeper runs from a source checkout, not
  `npx`. Needed only to ship the hardened launcher to end-user installs
  (and it ships dark behind `BOT_CDP_HARDENED`). Publish via the
  CLAUDE.md procedure when the token is available.
- **To start the A/B:** build the mcp package on the housekeeper host and
  run discover with `BOT_CDP_HARDENED=1` for the hardened arm; compare
  `CaptchaEvent` block rates by `stealth_profile`.

### Follow-up FIXED 2026-06-01 — finalOutcomeOf prefix match
`finalOutcomeOf` used to exact-match `WALL_FAILURE_KINDS`
({captcha_blocked, anti_bot_blocked, captcha}), but real bot errors are
*suffixed* (`"anti_bot_blocked: Cloudflare..."`), so
`ProvisionEvent.final_outcome` under-reported walls as "failed". Now
prefix-matched (in `signup-telemetry.ts`), aligning the registry
final_outcome leg with the DiscoveryBot outcome mapping (which already
used prefix regex). Covered by a new "SUFFIXED wall failures → blocked"
case in `provision-dispatch.test.ts`.

Owner: operator. Created 2026-06-01 from the zero-conversion investigation.

---

## Problem

The universal bot converts **~0%** against services fronted by
**Cloudflare Turnstile** and **reCAPTCHA v3**. These are *invisible,
score-based* challenges: there is no checkbox to click and no image grid
to solve. The site silently scores the session and blocks on a low
score. Two consequences:

1. **A captcha solver cannot help.** 2Captcha/anti-captcha return a
   token, but Turnstile/v3 score at the IP + browser-fingerprint layer
   and *reject solver-supplied tokens*. (Solvers only help reCAPTCHA v2
   *image* grids — a different, visible challenge.)
2. **A proxy alone did not move outcomes.** Field-tested: routing the
   bot through a residential Mac proxy did **not** lift conversion. The
   block is bound to the *browser fingerprint + automation tells*, not
   primarily the egress IP. So "buy residential IPs" is not the fix.

The investigation (live `CaptchaEvent` telemetry, 35 rows) showed the
hardest tell is on the **control channel**, not the network: Playwright
drives Chrome over CDP and calls `Runtime.enable`, which emits a
page-detectable `executionContextCreated` event. That is a **binary**
automation signal — no behavior-simulation, proxy, or solver defeats it.

### Why telemetry is half-blind today

The investigation also surfaced a **telemetry gap**: the housekeeper
`discover` path (`apps/mcp/src/housekeeper/modes/discover.ts`) drives
`bot.signup` and classifies the outcome but **records nothing to the
registry** — no `ProvisionEvent`, so the operator dashboard's funnel +
failure views are blind to every harvest run. `CaptchaEvent` (API DB,
35 rows) and `ProvisionEvent` (registry DB, 2 rows) are disconnected
streams. We cannot measure whether any anti-bot fix *works* until the
discover path emits outcomes we can A/B.

---

## Strategy

Two-front, sequenced:

- **Slice 1 (now):** close the telemetry gap so fixes are *measurable*,
  then land the single highest-value fix — the CDP `Runtime.enable`
  patch — behind a flag so we can A/B it. Everything downstream depends
  on being able to measure block-rate deltas.
- **Items 2–6 (deferred):** the remaining fingerprint/network/behavior
  layers, sequenced by leverage-per-effort, each measured against the
  Slice-1 baseline.

We are **not** trying to beat maximum-hardness Turnstile (e.g. the
Cloudflare dashboard's own signup, which stacks Turnstile + IP risk
scoring). See item 6 — pick battles.

---

## Slice 1 — telemetry + CDP patch (LOCKED, implementing)

### D1 — Telemetry: ProvisionEvent only (reuse the router's emit)

The discover path records a **`ProvisionEvent`** after every
`bot.signup`, via the **same `recordProvisionEvent`** the `provision`
MCP router already uses (`apps/mcp/src/skill-registry-client.ts`,
`clientFromEnv(accountId)`) — dispatch = `bot` → `bot`, with
`status` + `failure_kind`. DRY: reuse `toProvisionEvent`, no second
mapper.

**Explicitly NOT recorded:** `UniversalBotFailureRecord`. That table is
the *demand/walls* signal the housekeeper's own queue reads
(`fetchDiscoveryCandidates`). If the housekeeper wrote its own failures
there, it would **self-feed** — re-harvesting whatever it just failed
at, regardless of real user demand. Keep that signal end-user-sourced.

**Funnel hygiene:** harvest runs are under the operator account, so they
land in `ProvisionEvent`. Keep `FUNNEL_EXCLUDE_ACCOUNT_IDS` correct so
the end-user acquisition funnel doesn't inflate.

**A/B tag:** add a nullable **`stealth_profile`** column to
`CaptchaEvent` (API DB) — that's where the captcha-specific fields live,
so it's the right dataset for block-rate comparison. Value derived from
the CDP flag: `"baseline"` | `"cdp_hardened"`. (API prod schema =
**manual db push**; land the column via the guarded `release_command` in
`apps/api/fly.toml` — see the 2026-05-29 schema-drift incident.)

**Codex-corrected mechanic — "shared bot telemetry emit" (load-bearing).**
The original plan assumed the bot core posts `CaptchaEvent`. It does
**not**: the captcha-event POST to `/v1/captcha-events` lives in the
`provision-any` tool wrapper (`apps/mcp/src/tools/provision-any.ts:1269`),
and `discover.ts` calls `bot.signup` *directly*, bypassing it
(`discover.ts:234` is error-classification, not an emit). So discover
today posts **neither** `ProvisionEvent` **nor** `CaptchaEvent` — adding
a `stealth_profile` column alone would never tag a single harvest run.
Fix: extract a **shared post-signup telemetry emit** that both
`provision-any` and `discover` call, emitting **both** the
`ProvisionEvent` (via `recordProvisionEvent`) **and** the `CaptchaEvent`
(carrying `stealth_profile`). Also extend the API ingest **route**
(`apps/api/src/routes/captcha-events.ts:119`), **store**
(`apps/api/src/services/captcha-events.ts:22`), schema, and tests to
accept the new field. Without this, the A/B is silently empty.

Rationale: closes the gap *and* enables the A/B without poisoning the
harvest queue. Rejected: recording bot-failure too (self-feeding loop);
CaptchaEvent-tag-only (leaves funnel/failure views blind — the original
gap, and misses non-captcha failures entirely).

### D2 — CDP fix: rebrowser-playwright, flag-gated + spike first

**What:** the `Runtime.enable` leak — Playwright's CDP call that emits a
page-detectable `executionContextCreated` event, a *binary* automation
tell that Turnstile + reCAPTCHA v3 both check. Present on **every**
CDP-driven run — headless, headed-via-Xvfb (our F13 path), real-headed
desktop alike. It is **orthogonal** to the headless tells
(`navigator.webdriver`, SwiftShader WebGL) the Xvfb work already covers.
So patching it helps **all** automated runs — the operator's housekeeper
box *and* every end-user `npx` install (it ships in the tarball).

**How — Codex-corrected mechanic, "rebrowser via addExtra" (load-bearing).**
The naive plan ("swap the `import … from 'playwright'`") is **wrong** and
would be a silent no-op. `browser.ts:25`'s `baseChromium` is only a type
+ fallback; the real launcher is `getChromium()` (`browser.ts:43`), which
returns `playwright-extra`'s chromium singleton with stealth applied
(`extra.use(stealth())`) and resolves `playwright-core` from the lockfile
*internally*. Swapping the local base import would not repoint it — the
flag would read `cdp_hardened` while still launching vanilla playwright,
**poisoning the A/B**. Correct approach: behind **`BOT_CDP_HARDENED=1`**,
import `rebrowser-playwright`, feed *its* chromium into playwright-extra
via **`addExtra(rebrowser.chromium)`**, then apply stealth to that
instance — so the actual stealth-wrapped launcher is backed by the
patched fork. A/B via the `stealth_profile` tag.

**Spike — DONE 2026-06-01, all three goals PASS.** Ran
`addExtra(baseLauncher).use(stealth())` for baseline (playwright@1.59) vs
hardened (rebrowser-playwright-core@1.52, `REBROWSER_PATCHES_RUNTIME_FIX_MODE=alwaysIsolated`),
headed under Xvfb, against the live `bot-detector.rebrowser.net`:
1. **Compose** ✓ — both launched end-to-end through extra+stealth+Xvfb.
   Confirms the `addExtra` mechanic (NOT a bare import swap).
2. **Detector delta** ✓ — baseline tripped `sourceUrlLeak` 🔴 (*"You're
   using unpatched Playwright. Use rebrowser-patches to fix it."*),
   `mainWorldExecution` 🔴, and main-world `dummyFn` access; hardened left
   all three neutral/isolated-safe. The leak is real on baseline and
   closed under rebrowser.
3. **Bundle/resolve** ✓ — rebrowser-core installs + resolves as a normal
   dep; the tarball ships only `dist`+`assets`, so deps are installed by
   `npx` — declaring it a dependency *is* the delivery path (no literal
   packing needed).

**Fix-mode decision — RESOLVED via `evaluate` audit + second spike
(2026-06-01).** Audited all 34 `evaluate`-family calls in `browser.ts`
(the only file with any): **33 are DOM/Web-API only** (querySelector,
clicks, form-fill, `.value` reads, canvas/WebGL fingerprint probe) →
fully safe in an isolated world (isolated worlds share the DOM + Web
APIs). **Exactly one** reads a site-author main-world global:
`injectRecaptchaToken` at `browser.ts:2053` reads `window.___grecaptcha_cfg`
to fire reCAPTCHA's onSuccess callback — the Tier-3 2Captcha path for
reCAPTCHA-**v2 image grids**.

Second spike compared modes against the detector:
- `addBinding` — keeps main-world access, fixes `sourceUrlLeak`, but
  **leaves `mainWorldExecution` 🔴 + `dummyFn` detectable** (evaluate still
  runs main-world). Half-closes the leak — useless vs Turnstile/v3, which
  score on exactly those tells.
- `alwaysIsolated` — closes **all three** tells (the bot's constant
  `querySelector` calls run isolated, untrappable); main-world globals
  read `UNDEFINED`.

**→ Recommend `alwaysIsolated`** (the only mode that closes the wall we
fight) and **accept that the one `___grecaptcha_cfg` callback-walk
degrades to a no-op under hardened mode**. The DOM textarea fill +
`input`/`change` events at `browser.ts:2042-2046` still fire (isolated
worlds share the DOM), which covers most v2 integrations; and the broken
path is a *different challenge class* (v2-image solver) that does not need
CDP hardening — v2-image-heavy services can run in baseline. Optional
guard: warn (or force baseline) if hardened mode is on AND the v2-image
inject path is hit. **LOCKED 2026-06-01: `alwaysIsolated`, accept the
graceful degradation (no v2-image baseline-routing guard for now).**

**Version-lag decision.** rebrowser-core tops out at **1.52** vs our
**playwright 1.59**. Spike launched a 1.59-era chromium under the 1.52
launcher successfully. **→ Recommend keep playwright 1.59 and add
rebrowser-core 1.52 as an additional dep used ONLY behind the flag**
(baseline path untouched, lower blast radius, spike-proven) rather than
pinning playwright down to 1.52. Revisit if rebrowser ships a 1.59 match.
**LOCKED 2026-06-01: keep playwright 1.59, add rebrowser-core 1.52 behind
the flag.**

**Field finding + fix (2026-06-01, post-merge A/B runs) — D3 REVISED.**
The spikes validated leak-closure + compose on a *static detector page*
only. The first real hardened harvest runs **crashed** —
`page.evaluate: Target page, context or browser has been closed` at the
OAuth scan — while baseline succeeded on the same service. Two hypotheses
were tested live:
1. *Browser version* (host real Chrome is v148, rebrowser-core's driver
   is 1.52-era). Forced the hardened arm onto the **bundled chromium-1217**
   (spike-validated combo) via `executablePath`, dropping the channel.
   **Still crashed, identically** → not the cause.
2. *Isolation mode.* Re-ran with `REBROWSER_PATCHES_RUNTIME_FIX_MODE=addBinding`
   instead of `alwaysIsolated`. **Succeeded** — full signup, 13 steps,
   credential extracted.

**Root cause: `alwaysIsolated` crashes the bot's real flow** (forcing
every `page.evaluate` into an isolated world breaks the prewarm /
multi-page juggling), independent of browser version. **Fix:** default
the hardened fix-mode to **`addBinding`** (functional) and keep the
bundled-chromium launch (version-matched to the 1.52 driver, removes the
Chrome-148 variable).

**Cost — D3 is materially weakened.** `addBinding` keeps main-world
`evaluate`, so it closes the `sourceUrlLeak` (UtilityScript stack tell)
but **leaves `mainWorldExecution` + `dummyFn` detectable** (spike 2). So
the hardened arm is now a *partial* CDP hardening, not the full
isolated-world closure D3 originally locked. It's the strongest mode that
actually completes signups. Whether this partial closure measurably
lowers the Turnstile/v3 block rate is exactly what the A/B must answer —
the upside is now smaller than first hoped.

**Known A/B confound:** hardened runs bundled chromium while baseline runs
real Chrome — two variables differ. For a clean attribution, force the
baseline arm to bundled chromium too when running the comparison.

### Can we get FULL isolation without crashing? (investigated 2026-06-02 — NO, not with rebrowser-core 1.52)

Goal: close `mainWorldExecution`/`dummyFn` (full isolated-world execution)
without the crash, i.e. make `alwaysIsolated` viable. Built a minimal
repro (launchPersistentContext + stealth + alwaysIsolated, bundled
chromium, under Xvfb) and bisected the crash:

| op after a navigation | alwaysIsolated |
|---|---|
| `page.evaluate(() => …)` | **works** (rebrowser hooks it → isolated world) |
| `page.title()` | **CRASH** — "Target page… has been closed" |
| `page.locator("a").count()` | **CRASH** — same |

Root cause: rebrowser-core 1.52's `alwaysIsolated` patch hooks the public
`page.evaluate` but **breaks playwright's internal utility-context
operations** — `title()`, `content()`, and *every locator op*
(`.count()`/`.click()`/`.fill()`/`$$`). It forces the main-world execution
context away, and playwright's own internals (which depend on that
utility context) then throw "target closed". Tested across default page,
fresh `newPage()`, and `launch`+`newContext` — all crash; only the
spike's bare `browser.newPage()`+`evaluate`-only path (no locators/title)
survived, which is why the spike missed it.

The bot uses locators **pervasively** (it's the entire inventory/click/
fill surface) — there is no avoiding the utility context. So
`alwaysIsolated` is structurally incompatible with the bot, not fixable by
dodging one call. The only way to full isolation *without* the crash is an
**in-house CDP isolation layer** on vanilla playwright that preserves
playwright's utility context while routing our scripts to a separate
isolated world — i.e. re-implementing rebrowser-patches ourselves. That is
the deep, version-fragile "in-house CDP fix" D2 explicitly rejected; not
worth it for a flag-gated experiment.

**Conclusion: `addBinding` is the ceiling for this approach.** It closes
the primary Playwright CDP tell — the `sourceUrlLeak` / UtilityScript
stack signature that Cloudflare-class detectors key on (⚪️ in spike 2) —
and is fully functional. The residual `mainWorldExecution`/`dummyFn`
exposure requires a site to *actively trap DOM prototype methods*, a
rarer/more aggressive technique than the Runtime.enable leak. So the
hardened arm is a real-but-partial improvement; whether it moves the
Turnstile/v3 block rate is what the A/B measures.

Rejected: `patch-package` (postinstall patches silently no-op across the
npx/pnpm install matrix end users hit); in-house CDP fix (we'd own a deep
internal patch that breaks on every Playwright bump); swap-without-spike
(broken launch path surfaces late, in CI or a published tarball).

### Slice 1 scope (files) — revised after Codex review
- **Shared telemetry emit** — extract the post-signup emit (ProvisionEvent
  + CaptchaEvent) so both `provision-any.ts` and `discover.ts` use it;
  thread `stealth_profile`.
- `apps/mcp/src/housekeeper/modes/discover.ts` — call the shared emit
  (today posts neither ProvisionEvent nor CaptchaEvent).
- `apps/mcp/src/bot/browser.ts` — flag-gated `addExtra(rebrowser.chromium)`
  + stealth (NOT a bare import swap) + `stealth_profile` plumbing.
- `apps/api/prisma/schema.prisma` + guarded migration — `CaptchaEvent.stealth_profile`.
- `apps/api/src/routes/captcha-events.ts` + `apps/api/src/services/captcha-events.ts`
  — accept + persist `stealth_profile`.
- tests: unit-test the discover→shared-emit mapping (mock client) +
  captcha-event route/store accept the new field; the spike validates the
  CDP patch via a real detector delta.

Acknowledged: touches 3 services (mcp, api, registry-reuse). Accepted —
user explicitly scoped this slice down from the 6-item plan below.

---

## Deferred — items 2–6 (record now, pick up after Slice 1 reads out)

Sequence each *after* Slice 1's A/B baseline exists, so every change is
measured against block-rate, not vibes.

### Item 2 — Real Chrome channel + real GPU host [off Xvfb/SwiftShader]
Xvfb gives Chrome a display surface but **software-renders** WebGL via
SwiftShader — a fingerprint tell (`UNMASKED_RENDERER` = "SwiftShader" /
"Google SwiftShader"). Real browsers report a real GPU. Two moves:
(a) launch the **real Chrome channel** (`channel: "chrome"`) rather than
bundled Chromium where available; (b) run the harvester on a host with a
**real GPU** (or hardware-accelerated virtual display) so WebGL reports a
plausible renderer. Measure: block-rate on v3-scored services,
baseline vs GPU-host.

### Item 3 — Network coherence [not just "a proxy"]
The Mac-proxy test failed because a proxy alone doesn't make the session
*coherent*. The fingerprint must agree with the egress: **residential
SOCKS passthrough** (avoid ASNs that classify as `unknown` —
`shouldRouteThroughProxy` / `UNIVERSAL_BOT_PROXY_ALWAYS`), plus
**geo/timezone/Accept-Language alignment** (browser TZ + `Accept-Language`
+ locale must match the proxy's geo). Incoherence (datacenter TZ behind a
residential IP) is itself a tell. Measure: same service, coherent vs
incoherent network identity.

### Item 4 — Warm persistent profile + logged-in Google identity [v3 lever]
reCAPTCHA v3 scores **reputation**, not just this-session behavior. A
**warm, persistent Chrome profile** with real browsing history and a
**logged-in Google identity** scores far higher than a cold incognito
context. We already maintain a shared bot profile (cf. the SingletonLock
self-heal). Extend: keep it warm, keep a Google session live, age it.
Measure: cold-context vs warm-identity score on a v3 service.

### Item 5 — Behavior depth [pre-widget interaction]
Tier-1 behavior sim (bezier mouse, variable typing) fires *at the form*.
v3 scores the **whole session** from page load. Add **pre-widget**
behavior: scroll, dwell, mouse movement, and hover *before* reaching the
signup widget — a human reads the page first. Measure: block-rate with
vs without pre-widget interaction depth.

### Item 6 — Pick battles [don't fight max-hardness Turnstile]
Some signups stack the hardest config: the **Cloudflare dashboard** runs
maximum Turnstile + IP risk scoring on its *own* signup; manual signup is
the realistic call there. Classify services by challenge hardness (the
`CaptchaEvent` data supports this) and **route the unwinnable ones to a
manual/operator path** instead of burning bot runs + LLM calls on a 0%
prospect. Measure: LLM-spend-per-success once unwinnable services are
de-listed from the harvest queue.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | scope set by operator (slice 1 + record rest) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_resolved | 2 load-bearing decisions locked (D1 telemetry, D2 CDP); code-quality/test/perf resolved as notes given D1/D2 |
| Codex Review | `codex exec` | Independent 2nd opinion | 1 | issues_found_resolved | 2 material implementation flaws caught + folded in: D1 "shared bot telemetry emit" (CaptchaEvent is posted by provision-any, not bot core — discover emits nothing), D2 "rebrowser via addExtra" (bare import swap is a silent no-op; spike must prove a detector delta). Decisions held; mechanics corrected. |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | n/a | no UI surface (telemetry + bot internals) |

- **ENG (D1 — telemetry):** discover path emits `ProvisionEvent` via the
  router's existing `recordProvisionEvent` (DRY); **not**
  `UniversalBotFailureRecord` (would self-feed the harvest queue);
  `stealth_profile` tag on `CaptchaEvent` for the A/B; operator account
  excluded from the funnel.
- **ENG (D2 — CDP):** `rebrowser-playwright` fork, flag-gated
  `BOT_CDP_HARDENED=1`, **spike-first** to de-risk the
  fork×playwright-extra×Xvfb compose + pnpm bundle before committing.
  Clarified scope: the `Runtime.enable` leak affects **all** CDP-driven
  runs (headed + headless), not just headless — so the fix benefits every
  install, not only the harvester box.
- **MIGRATION SAFETY:** `CaptchaEvent.stealth_profile` lands via the
  guarded `release_command` (manual-db-push discipline, per the
  2026-05-29 vault schema-drift incident).
- **CODEX (outside voice):** ran `codex exec` against the real source.
  Confirmed the decisions' *direction* (ProvisionEvent-not-bot-failure is
  right; rebrowser fork is the right source) but caught two
  implementation flaws the prose hid — both now baked into D1/D2 above as
  named tweaks. Net: the slice's file-list grew (shared emit + API
  captcha-route/store changes) but the architecture is unchanged.
- **UNRESOLVED:** 0 for Slice 1. Items 2–6 deferred by operator decision,
  recorded above + pointed to from `TODOS.md`.
- **VERDICT:** Slice 1 cleared to implement, with the two Codex-corrected
  mechanics. Sequence items 2–6 after the A/B baseline reads out.
