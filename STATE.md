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

- **IMPORTANT reframe (2026-06-12):** on the laptop, exa reached
  `oauth-after-click` and `oauth-post-consent` snapshots — i.e. it got **past**
  the login-page Turnstile and **completed Google OAuth**, and *then* failed.
  So "exa = CF Turnstile wall" may itself be **partly wrong**: the persistent
  failure may be **post-OAuth** (onboarding / session / reaching the API key),
  with the Turnstile being an intermittent, passable hurdle — not the wall.
  **Next session: get the laptop's full step trail + the post-consent snapshot
  and find where it ACTUALLY dies, before touching anti-bot code again.**

- **? OPEN — untested hypotheses, in priority order:**
  1. **Post-OAuth onboarding/session failure** (exa got past OAuth on the
     laptop). Likely the real blocker. Test: read the laptop's post-consent
     trail.
  2. **patchright CDP-connection residual tell** — the one thing constant
     across all environments. Test: run exa with a *plain* Playwright/Chrome
     (no patchright, no bot flow) from the same laptop; if a vanilla browser
     passes where the bot fails, the tell is in patchright or our launch args.
  3. **Automation behavioral/timing pattern** (prewarm + fast form-fill + the
     OAuth click cadence). Test: A/B the prewarm + a slower humanized cadence.
  4. **`trustysquire.com` email-domain reputation** on the signup form.

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

## Recurring meta-lesson

**Stop concluding "IP" or "fingerprint" from a single observation.** Every time
we have, a later experiment falsified it (this file is the graveyard). The
discipline: form the hypothesis, name the experiment that would FALSIFY it, run
that experiment, record the result here. patchright + residential is almost
never the cause; the cause is almost always nav-layer, session-layer, a wrong
URL, a returning-user state, or a genuine product gate.
