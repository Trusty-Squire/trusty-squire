# STATE.md — what's actually REAL vs FALSIFIED

**Purpose.** We iterate over the same ~100 discovery services constantly, and
across sessions we keep re-deriving the *same wrong conclusions* (most often
"it's the IP, rotate the proxy"). This file is the institutional memory of
**hypotheses that have been tested and FALSIFIED**, the experiments that
falsified them, and the small set of things actually CONFIRMED. Read this
BEFORE concluding why a service fails. Add to it whenever an experiment
settles (or kills) a hypothesis. A conclusion with no experiment behind it does
not belong here — it goes in "open questions."

Convention: **H** = hypothesis, **✗ FALSIFIED** (with the experiment), **✓
CONFIRMED**, **? OPEN** (current best guess + what would test it).

---

## Cloudflare-Turnstile "wall" (exa, cartesia, render-cron, replit, runpod, turso)

The recurring tar pit. Current honest status: **cause NOT yet identified; the
environment hypotheses are all falsified; the invariant is the BOT itself.**

- **H: residential-IP reputation** (the harvester Mac's reused Korean proxy IP
  is flagged). **✗ FALSIFIED, twice:**
  1. 2026-06-11 — the *same* Mac proxy IP **solves 2captcha's live Turnstile
     demo** (`solveVisibleCaptcha` returned a real token, len 21). A flagged IP
     could not.
  2. 2026-06-12 — exa run from a **Windows laptop with `proxy=direct`** (a
     fresh Singapore residential IP, no proxy at all) **still fails**. A fresh
     direct residential IP rules out IP reputation definitively.
  → **Do NOT propose proxy rotation for the CF cluster again.** It is falsified.

- **H: software rendering / llvmpipe canvas+WebGL** (the harvester box is a
  GPU-less VM — `/dev/dri/by-path` = `simple-framebuffer`, no render node, so
  Chrome falls back to llvmpipe; the WebGL spoof only rewrites the *string*,
  not the pixels). **✗ FALSIFIED:** the laptop has a **real GPU** and exa still
  fails. (The llvmpipe tell is real and worth fixing for *strict* Turnstiles in
  general, but it is NOT what blocks exa.)

- **H: headless screen geometry / Xvfb** (`1280×720`, `availHeight==height`).
  **✗ FALSIFIED:** the laptop has a real display and still fails. (Fixed anyway:
  Xvfb bumped to 1920×1080 + availHeight taskbar gap — a genuine improvement,
  but not the exa cause.)

- **H: device tells** (`hardwareConcurrency=20` on a "residential" session).
  **~ MITIGATED, not decisive:** normalized to 8 + deviceMemory 8; exa still
  fails. Worth keeping; not the cause.

- **INVARIANT across every failing run** (Mac+proxy, laptop+direct, GPU-less +
  real-GPU, Korean IP + Singapore IP): the **bot itself** — patchright-driven
  Chrome + the signup flow. So the real cause is in the **automation / behavior
  layer, not the environment.**

- **✓ CONFIRMED root cause (2026-06-12, full laptop step trail).** The wall IS
  the Turnstile — but via the AUTOMATION layer, not the environment. On the
  laptop (real GPU, real display, `proxy=direct` fresh Singapore IP):
  `visible turnstile present but did not solve in 20s`; after clicking
  "Continue with Google" the auth state is `not_provider` and the URL stays
  `auth.exa.ai` (the click was **inert** — the unsolved Turnstile gates the
  OAuth button); the page then shows literally **"Please complete the
  verification challenge."** So the Turnstile's `failure_retry` happens even on
  a pristine real browser+IP → the residual is the **CDP/automation signature
  of a Playwright/patchright-driven session**, which patchright does NOT fully
  hide and which exa's STRICT Turnstile config scores below threshold (lenient
  Turnstiles — 2captcha demo, plausible — still pass). My earlier "likely
  post-OAuth" reframe was ALSO wrong; the trace falsified it. The
  `oauth_onboarding_failed` label is a downstream symptom (see the bug below),
  not the cause.

- **🐛 SEPARATE FIXABLE BUG (false-positive OAuth success).** When the Google
  click is inert (URL unchanged, `auth state = not_provider`, a "verification
  challenge" still on the page), the bot concludes `waited for the callback to
  settle — redirected to the app → signed in via Google` and burns the whole
  post-verify budget flailing on the login page. It should detect "still on the
  pre-auth login page + Turnstile/verification text present + URL never left the
  provider-callback origin" and bail `captcha_blocked` clearly. This won't get
  exa into the registry (the Turnstile still blocks) but stops the wasted budget
  and gives a truthful status. Fix is in `runOAuthFlow`'s post-`startOAuth`
  settle check (agent.ts ~7154 "waited for the callback to settle").

- **✓ REFINED (2026-06-12): exa serves THREE responses by context** — the
  earlier confusion was conflating them:
  1. **Google session present** → logged-in dashboard, no challenge (the
     operator's account exists from this session's runs).
  2. **Fresh profile + DATACENTER IP** (harvester box, proxy down → direct) →
     Cloudflare **managed interstitial / IUAM soft-block** ("would not clear,
     no challenge to solve"). This one *is* IP-driven — a datacenter IP risk
     score with no widget. Residential egress clears it.
  3. **Fresh profile + RESIDENTIAL IP** (laptop) → **Turnstile WIDGET** (sitekey
     in the iframe path). This is the automation-layer wall — the widget won't
     solve on an automated click. **This is the 2Captcha-solvable case.**
  So both a (real, IP-driven) datacenter soft-block AND a (residential-only)
  automation-layer Turnstile widget exist; they're just exposed in different
  contexts. The widget is the one worth solving — and it ONLY appears on
  RESIDENTIAL egress. The datacenter box CANNOT reproduce it (it gets the IUAM
  soft-block instead), so the 2Captcha-widget test REQUIRES residential egress:
  restart gost (then run on the box through the proxy) OR run on the laptop.
- **2Captcha Turnstile escalation: WIRED + ready** (both OAuth-precheck and
  form-submit paths; robust sitekey extractor; watchdog + locked queue so test
  runs can't orphan). Confirmed firing live (cartesia) — only blocked on getting
  residential egress to reproduce the solvable WIDGET. Managed-IUAM challenges
  (cartesia, exa-on-datacenter) are NOT 2Captcha-Turnstile-solvable (no DOM
  sitekey; would need the cData/chlPageData Cloudflare-Challenge flow — separate
  bigger lift).

- **? OPEN — the only remaining levers for the strict-Turnstile cluster:**
  1. **2Captcha Tier-3 for Turnstile.** Currently DISABLED for Turnstile on the
     (now-falsified) belief that "Cloudflare scores at the IP layer so a
     solver token is rejected." Since IP-binding is falsified, a 2Captcha-issued
     Turnstile token MIGHT be accepted. Concrete test: set TWOCAPTCHA_API_KEY,
     enable the Turnstile escalation, run exa. ~$0.003/solve. **This is the
     highest-value untested experiment.**
  2. **A non-Playwright/non-CDP browser driver** (the automation signature is
     the invariant). Heavy lift; only if (1) fails.
  3. Accept the CF cluster (exa, cartesia, render-cron, replit, runpod, turso)
     as captcha-walled and focus elsewhere.

---

## Confirmed-real fixes (green, reproduced)

These produced full signups (extracted credentials) and several reproduced
**autonomously in the overnight heal run**, not just manual runs:

- **galileo, activeloop, lancedb, friendliai** — ✓ green. Root fixes:
  - **oauth-bounce reload** — reload once before bailing
    `oauth_session_not_persisted` (a transient login bounce / slow hydration
    lands the dashboard on reload). Cracked galileo + activeloop.
  - **empty-inventory hydration patience** — treat ≤1 interactive elements (and
    "no provider button AND no credential form") as an unhydrated SPA shell →
    give the OAuth-first scan the patient 8-retry budget. Cracked lancedb.
  - **Mantine/Radix checkbox label-click** — commit a styled checkbox via its
    `<label>` (the hidden input's `onChange` doesn't fire on a raw click).
    Cracked friendliai.
  - **cmdk combobox real-pointer commit**, **chrome-error/ERR_ABORTED goto
    retry**, **credential-domain grounding** (don't mint a GitHub PAT as the
    service key), **GitHub Authorize clickjacking-countdown wait**,
    **profile-lock reap**, **returning-user settle-recheck**,
    **dotted-token extraction** (`.` in the value char class),
    **password class-coverage** — all landed, all suite-green.

---

## Genuinely-unservable (dequeued with evidence — NOT bot bugs)

Dead / acquired / sales-gated — confirmed via WebFetch/WebSearch, marked
`needs-manual` in `tools/discovery-candidates.yaml`:

- **fauna** (FaunaDB shut down 2025-05-30), **literal-ai** (sunset 2025-10-31,
  404), **lepton-ai** (acquired by NVIDIA → DGX enterprise), **sieve**
  (rebranded to data-licensing, no self-serve), **glitch** (discontinued app
  hosting), **octoai** (acquired by NVIDIA, dead domain), **marqo** (demo-gated),
  **superlinked** (self-hosted + sales), **stackblitz** (browser IDE, no token
  surface — authenticated DOM proven), **cyclic** (AWS-acquired, dead),
  **northflank** (GitHub-app + sudo-2FA, operator-only), **koyeb** ($30/mo +
  card before keys).

---

## Server-side OAuth-callback walls (NOT nav-fixable; recur on re-run)

The handshake completes but the service never establishes a session on its
callback (Clerk / WorkOS sso-callback drops the session). Bot behavior is
correct; these need manual signup or are genuine walls. Don't keep "fixing" nav:
- **predibase, humanloop** (mislabeled `oauth_loop_detected` — same class),
  **hyperbolic, braintrust** (Clerk `/sso-callback`). The reload fix fires and
  is exhausted; it does not help these.
- **fly-io** (SSO-required org — tokens can't be UI-created), **xata**
  (pre-existing account for the operator's identity + email-link gate).

---

## Queue hygiene applied 2026-06-12 (corrected signup_urls)

Cross-host redirects / moved consoles — the bot's signup search can't follow a
cross-host hop, so the queue URL must be the post-redirect host:
novita-ai → `/user/register`; nebius-ai → `tokenfactory.nebius.com`; voyage-ai →
`dashboard.voyageai.com`; surrealdb → `app.surrealdb.com`; tigris →
`console.storage.dev`; nvidia-nim → `/explore/discover`; gitpod →
`app.gitpod.io`.

---

## Configured secrets / env — CHECK HERE before asking for a key

Agents keep re-asking for keys that are **already configured**. They live in
`~/.config/trusty-squire/harvester.env` (loaded by the heal systemd unit via
`EnvironmentFile=`). Before asking the operator for any of these, `grep` that
file. Currently set (names only):

- `TWOCAPTCHA_API_KEY` — **SET.** The 2Captcha Tier-3 solver is funded and
  available in heal runs. (Turnstile escalation to it was historically *code*-
  gated off — that's a code switch, not a missing key.)
- `UNIVERSAL_BOT_PROXY_URL` (`socks5://100.104.88.126:1081`, the Mac gost),
  `UNIVERSAL_BOT_PROXY_ALWAYS`, `REGISTRY_ADMIN_BEARER`,
  `TRUSTY_SQUIRE_REGISTRY_URL`, `TELEGRAM_BOT_TOKEN`, `GH_REPO`,
  `BOT_INBOX_DOMAIN`, `TRUSTY_SQUIRE_FIX_AGENT_PUSH`,
  `UNIVERSAL_BOT_DAILY_SIGNUP_CAP`, `UNIVERSAL_BOT_MAX_LLM_CALLS` — all SET.
- Machine token + account id: from the install session
  (`~/.config/trusty-squire/session.json`), backfilled by the CLI.
- Provider/API secrets the bot calls through the proxy live in the **vault**
  (`mcp__squire__list_credentials`) — never paste their values into this file.

Rule: a key in `harvester.env` or the vault is CONFIGURED. Don't ask for it;
read it.

## Recurring meta-lesson

**Stop concluding "IP" or "fingerprint" from a single observation.** Every time
we have, a later experiment falsified it (this file is the graveyard). The
discipline: form the hypothesis, name the experiment that would FALSIFY it, run
that experiment, record the result here. patchright + residential is almost
never the cause; the cause is almost always nav-layer, session-layer, a wrong
URL, a returning-user state, or a genuine product gate.
