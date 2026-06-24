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

## High-value spine sweep (2026-06-23) — 3/5 cracked + a generalizable survey filler

Driving the uncracked spine (openai/auth0/mongodb-atlas/huggingface/meilisearch):

- **auth0 → ok** (2 creds). The existing bot already handles it — a free win once attempted.
- **openai → ok** (1 api_key). Google-OAuth signup reached a key with no phone gate on the run.
- **meilisearch → ok** (1 api_key). CRACKED via the new onboarding-survey filler (below).
- **mongodb-atlas → OPEN** (`oauth_onboarding_failed`). Same survey-gate CLASS, different
  widget: MongoDB's **LeafyGreen UI** comboboxes are `<div role="combobox">` with NO
  data-cy anchor (only a dynamic `aria-controls`/shared class) + an autocomplete-input
  multi-select ("data types"). The filler detects the disabled submit but finds no
  data-cy-addressable trigger → no-op. Needs a LeafyGreen-specific selector strategy.
- **huggingface → OPEN.** `/join` returned a temporary IP block (`403 suspicious activity
  from your network, ~30 min`) from prior datacenter-IP activity, so the GitHub-OAuth
  bypass of its hCaptcha-Enterprise email wall couldn't even be tested. Retry from a clean
  IP / residential proxy; the email path stays an Enterprise-hCaptcha wall (rqdata blob).

### The generalizable win: deterministic onboarding-survey filler (commit `0c088d5`)

The dominant `oauth_onboarding_failed` blocker is a post-OAuth "tell us about yourself"
survey whose required cmdk/Radix selects gate a disabled submit; the greedy planner opens
the dropdowns but never commits, loops on a Next it can't enable, and stalls.
`hasDisabledSubmit()` + `fillRequiredComboboxes()` (browser.ts), fired once in
postVerifyLoop, open each unfilled required select and commit the first option via a real
Playwright locator click. Unfilled is detected by Radix's `data-placeholder` attribute
(present even when the trigger PREVIEWS the first option — meilisearch's role→Founder/CTO
stayed uncommitted), empty text, or a Select/Choose/Pick placeholder. Live: meilisearch
satisfied all 4 selects → Next enabled → project created → key extracted. Covers the
cmdk/Radix majority; LeafyGreen (mongodb) and native-tile surveys are separate widgets.

---

## `firebase` / `gcp` — Google Cloud project-creation is an IDENTITY wall, then an MFA wall (2026-06-23)

### ✓ CONFIRMED: the verify-robot pool can't create GCP projects (org-policy), not a nav/form bug

Fresh robot run reproduced the documented wall exactly: the bot OAuths into the
authenticated Firebase console and gets all the way into project creation (fills
name, accepts terms, clicks Continue) — then dies on the **parent-resource
picker** (`fire-cloud-resource-chip` → `cdk-tree-node`) that only offers
`trustysquire.ai`. The `verify-NN@trustysquire.ai` robots are Workspace (Cloud
Identity) accounts: FORCED into the org, no "No organization" option,
`resourcemanager.projects.create` denied → "Continue" stays disabled, the bot
loops on "Expand the trustysquire.ai folder" and stalls. Pure
identity-authorization wall.

### Fix in motion: personal consumer Gmail (defaults to "No organization")

Shipped `BOT_GOOGLE_PROFILE_DIR` (+ `mcp login --profile-dir`) to pin a personal
Google identity for Google-OAuth discover, bypassing the robot pool (commit
`35323cb`). A personal Gmail creates projects under "No organization" freely.

### ✓ CLEARED (2026-06-23): MFA + org + project-creation, with personal Gmail + 2SV

With a fresh personal Gmail (no 2SV), `console.firebase.google.com` first
replaced the whole console with **"Enable MFA … You must enable MFA to gain
access to Firebase / Turn on 2SV"** — a hard gate (now classified
`mfa_setup_required`; was mislabeling `oauth_required` after ~16 loading-shell
retries; detector `looksLikeMfaEnrollmentGate`). After the user enabled 2SV on
methoxine@gmail.com, the re-run **cleared everything down the stack**: MFA gone,
"No organization" available (org wall cleared), and **project creation SUCCEEDED**
— `ts-firebase-project` was created end-to-end (name + terms + Continue + Create
+ provisioning wait). Only the final key extraction failed (planner wandered
into Gemini chat / Service Accounts, then 404'd guessing /settings/keys).

### ✓ CRACKED (2026-06-23): deterministic API-key extraction — firebase → ok, 1 credential

Two fixes completed the chain (commit `fe0bde3`), both shipped + live-validated:

1. **Authenticated-console routing.** console.firebase.google.com /
   console.cloud.google.com are heavy Angular SPAs the OAuth-first scan read as a
   perpetual "loading shell" (no provider button — you're already in) → it looped
   and bailed the misleading `oauth_required`. A logged-OUT visitor is redirected
   to accounts.google.com, so simply BEING on the console host = an established
   session → route to post-verify (already_oauth). (`isAuthenticatedGoogleConsoleUrl`)
2. **Deterministic Browser-key extractor.** Every Firebase project auto-creates a
   "Browser key (auto created by Firebase)" in its GCP project (= firebaseConfig.
   apiKey AND a GCP API key) even with no web app. Once postVerifyLoop sees a
   projectId in the URL (`parseGoogleProjectId`), it navs to
   `console.cloud.google.com/apis/credentials?project=<id>`, clicks the
   Browser-key row's "Show key", and reads the row-scoped AIzaSy
   (`extractGoogleApiKeyFromCredentials`). One extractor covers firebase + gcp.

**Live (2026-06-23):** `discover firebase → ok` (project ts-firebase-project-fc076,
Browser key extracted, 1 credential). **gcp** added to the queue on the SAME path
(a Firebase project IS a GCP project; the Browser key IS a GCP API key). Requires
the personal Google identity + 2SV (`BOT_GOOGLE_PROFILE_DIR`, methoxine@gmail.com);
the Workspace robots still can't (org wall). GCP-native key creation
(console.cloud.google.com → Create credentials → API key, no firebase) is a future
refinement — the firebase path already yields a valid GCP credential.

---

## `meilisearch` — SPA stale-URL 404 trap (CRACKED 2026-06-23) → onboarding-wizard residual

### ✓ CONFIRMED + FIXED: the "no_credentials_after_already_signed_in" was a 404 false-positive, NOT an auth wall

meilisearch failed discover as `no_credentials_after_already_signed_in`. It
read like an OAuth/session wall; it was not. Two chained bugs, both fixed
generalizably (commit `649e1a1`):

1. **SPA serves one 200 shell for every route.** `cloud.meilisearch.com/login`
   and `/signup` both return the SAME 200 `index.html`; `/signup` only renders
   "Sorry, the page you are looking for does not exist" (the *cute baby seal*
   404) once React mounts. The static HTTP probe (`resolveSignupUrlByProbe`)
   can't see a client-rendered 404, so it "upgraded" the working curated
   `/login` to the dead `/signup`. **Fix:** a live `looksLike404` fallback
   after `goto`+`waitForFormReady` — when the probe moved us off the hint AND
   the resolved URL renders a 404, fall back to the original hint and re-read.
2. **404 page mistaken for an authenticated dashboard.** The 404 still ships
   meili's chrome nav (Projects/Settings links), which tripped Signal 1 of
   `detectAlreadySignedIn` → the bot logged "already authenticated … skipping
   signup" and routed to key-extraction over more 404s. **Fix:** a 404 veto on
   the already-signed-in classifier.

**Live-validated 2026-06-23:** with both fixes, meilisearch lands `/login`,
takes the Google OAuth path, and signs in end-to-end (reaches
`/welcome-informations`). The IP/fingerprint/session hypotheses never applied.

### ? OPEN (residual): `oauth_onboarding_failed` — required cmdk multi-select on the onboarding wizard

After OAuth, `/welcome-informations` ("Tell us about yourself") gates the
"Next" button (`[data-cy="button-register"]`) behind two **required cmdk
multi-select comboboxes** (`[data-cy="meilisearch_reasons-trigger"]`,
`[data-cy="sdk_languages-trigger"]`). The post-OAuth path drives this with
**nav-search (button navigation) → post-verify planner**, NOT the form-fill
engine, so it never systematically selects an option in each required
multi-select; the planner concludes "all fields filled," clicks the disabled
Next, and STALLs. The executor's cmdk option-commit (2026-06-16 fix) works in
isolation — the gap is *upstream*: post-OAuth onboarding must run real
form-fill over a required multi-field survey. This is the tracked
`oauth_onboarding_failed` workstream (dominant promote-blocker); fix belongs
there (planner/form-fill over onboarding surveys, gated by LLM-shadow eval),
not a meili-specific patch.

---

## `oauth_session_not_persisted` (cartesia, braintrust, pinecone, … the "OAuth-callback wall")

### ✗✗ FALSIFIED: "it's IP / needs residential egress" (2026-06-14, controlled matrix)

The error string used to say "anti-bot / IP rejection of the callback — needs
residential egress." **Proven false.** Controlled direct-vs-proxy matrix on
cartesia (D1 retry disabled → 1 identity/attempt; `UNIVERSAL_BOT_NO_CLEAN_STATE_RETRY=1`):
- **DIRECT** (datacenter Miami, ReliableSite AS23470): **4/4 fail** `oauth_session_not_persisted`.
- **PROXY** (clean residential Seoul, SK Broadband AS9318, egress geo confirmed
  Asia/Seoul): **2/2 callback attempts fail identically** (+1 proxy-latency
  run_timeout). Only the egress IP changed; everything else held.
A clean residential consumer IP fails the callback the same as the datacenter
IP → **NOT IP, NOT egress.** The Tailscale Mac proxy does NOT help this class —
do not route it through the proxy. (Matrix logs: `/tmp/cartesia-matrix-*`.)

### ✓ ROOT CAUSE (2026-06-14, instrumented): Clerk new-user OAuth, not a session/cookie bug

`UNIVERSAL_BOT_OAUTH_DEBUG=1` records the Clerk FAPI network + cookies at the
bail point. cartesia is a **Clerk** app. The tell:
`POST clerk.cartesia.ai/v1/client/sign_ins` → **422 `form_identifier_not_found`**
("Couldn't find your account"). The bot drives Google OAuth through Clerk's
**sign-IN** endpoint for a brand-new identity; Clerk won't sign in a
non-existent account, and the **`sign_ups` transfer is never called** (0
sign_ups across the whole run). `__client` cookie IS present (Clerk JS loaded,
cookies persist) and `__client_uat`="0" (never signed in) → NOT a cookie/
persistence/fingerprint-at-network bug, NOT captcha (`form_identifier_not_found`,
not `captcha_*`). It was just mislabeled "anti-bot / IP."

### ✗ FALSIFIED fixes (both tested live on cartesia):
- **SDK transfer** (`window.Clerk.client.signUp.create({transfer:true})`):
  unreachable — **patchright runs `page.evaluate` in an ISOLATED world where
  `window.Clerk` is undefined** (verified: 20 polls/10s → present:false, while
  clerk.browser.js had loaded). DOM access works in isolated worlds; JS globals
  don't. So any window.* SDK intervention is blocked under BOT_CDP_HARDENED.
- **Wait-for-auto-transfer** (stay on /sso-callback, cookie-poll 12s instead of
  navigating away): Clerk did NOT auto-transfer (still 0 sign_ups, no session).
  cartesia's Clerk genuinely does not create the account from the Google click.

### ✓✓ CRACKED (2026-06-14) — cartesia signs up end-to-end, api_key extracted
NOT a bot-detection block at all — two bot bugs, both fixed + validated live
(normal discovery, `ok`, `api_key=sk_car_…` extracted):
1. **`captcha_blocked` was a PREMATURE BAIL.** cartesia's email signup uses a
   Clerk MANAGED Turnstile that resolves SERVER-SIDE. The submit succeeded
   (cartesia emailed a verification code — the user's tell: "if it was flagged,
   why send an email?"), but the bot bailed `captcha_blocked` while polling for
   a client-side token that an invisible Turnstile never populates — ONE STEP
   before success. Fix: on a POST-submit Turnstile timeout WITH an inbox,
   proceed to verification and let the inbox poll arbitrate (a code = the submit
   went through). Genuine pre-submit gates (no inbox / non-Turnstile) still bail.
2. **OAuth-first re-fired after the login-only fallback.** Google OAuth is
   login-only (form_identifier_not_found); the bot fell back to email but the
   dispatch loop's OAuth-first scan re-clicked Google and looped. Fix: a sticky
   `committedToEmailPath` flag, set on the login-only fallback, honored by
   `resolveOAuthCandidates`.
End-to-end now: OAuth login-only → sticky email commit → form fill → managed-
Turnstile arbiter → inbox code → key. Re-pinned SERVABLE (removed needs-manual).

LESSON: don't label a block "anti-bot/captcha" without the inbox + network
ground truth. A verification email = the submit succeeded = not flagged.

### Related improvement
`waitForClerkSession` (cookie-poll before navigate-away) helps Clerk services
that DO auto-transfer (e.g. pinecone, which succeeds) by not interrupting them.
The flakiness across the Clerk cluster is which context the OAuth lands in
(sign-up creates the account → ✓; sign-in for a new user → form_identifier_not_found → fall back to email).

### ✓ GENERALIZED email-fallback (2026-06-15, commit 9f78bfb)
The cartesia crack only fell back to email when Clerk showed the EXPLICIT "no
account" text (detectGoogleNoAccount). The rest of the cluster (openrouter, groq,
northflank, …) fails the callback SILENTLY — no such text — so it surfaced as a
stuck login page and dead-bailed `oauth_session_not_persisted`. Fix: at that bail
(the 3-login-page-rounds throw, agent.ts ~10628) return the existing
`OAUTH_FALL_BACK_TO_FORM_FILL` sentinel instead of failing — runSignup re-creates
the account via EMAIL (one-shot guarded; forceFormFill suppresses OAuth so no
bounce-back). Every cluster member with an email signup option becomes servable
when OAuth lands in the failing context. NOTE: openrouter probes
`has_email_signup=true`; a 2026-06-15 re-run hit SUCCESS but via stochastic
OAuth-persist (sign-up context) so the fallback branch wasn't exercised that run —
it fires on the next not-persisted occurrence. So the "Server-side OAuth-callback
walls (NOT nav-fixable)" list below is now servable for its EMAIL-capable members
(probe `has_email_signup` before declaring any of them a wall).

CLUSTER PROBE (2026-06-15, `tools/affordance-probe.mjs`, sequential — the batch
mode has a concurrent-navigation bug):
| service     | providers      | has_email_signup | fix helps? |
|-------------|----------------|------------------|------------|
| openrouter  | google,github  | true             | ✅ servable |
| northflank  | google,github  | true             | ✅ servable |
| hyperbolic  | google,github  | true             | ✅ servable |
| braintrust  | google         | true             | ✅ servable |
| groq        | google,github  | false            | ✗ OAuth-only — still walled |
| turso       | google,github  | false            | ✗ OAuth-only — still walled |
| activeloop  | google,github  | false            | ✗ OAuth-only — still walled |
| predibase   | (ERR_NAME_NOT_RESOLVED on app.predibase.com) | — | URL stale; fix the queue URL first |
The email-fallback opens the 4 email-capable members on the next not-persisted
occurrence. The 3 OAuth-ONLY members (turso/activeloop) need the harder
Clerk sign-UP-context transfer (window.Clerk unreachable in the isolated world —
the remaining open problem; a raw CDP main-world Runtime.evaluate is the untested
angle). predibase needs a current signup URL before any retry.

### ✅✅ groq CRACKED (2026-06-17) — it was NEVER an OAuth-callback wall; it was an in-modal Turnstile
The "groq → OAuth-only, still walled" classification above is **FALSIFIED**. groq's
Google OAuth signs in cleanly (verify-11, end-to-end) and reaches the dashboard.
The real blocker was post-OAuth, on the **API-key page**, and decomposed into three
distinct nav/mint bugs — all generalizable, all fixed:
1. **nav-search wandered off the keys page.** groq's virgin `/keys` renders an
   EMPTY key table whose column headers ("Key name" / "Created" / "Last used")
   trip `detectExistingAccountNoExtract` → it returned `on_key_surface`, extraction
   found nothing, and the loop navigated to `/settings`. FIX: in `assessKeyGoal`, a
   visible create-key affordance on a keys URL → `create_gated` wins over the
   existing-account heuristic (mint, don't declare a dead end). `nav-search.ts`.
2. **nav-search never minted.** The `create_gated` branch bare-clicked "Create API
   Key" and moved on; it never drove the resulting modal. FIX: wired the proven
   `attemptMintNewKey` recovery in as a `mintKey` dep.
3. **THE wall — a Cloudflare Turnstile INSIDE the create-key modal.** Clicking
   "Create API Key" opens a Radix dialog with a `keyName` field + a hidden
   `cf-turnstile-response`; the submit ("Create API Key", same label as the page
   button) stays DISABLED until the Turnstile issues a token. The captcha gate
   only ran during form-fill, never in post-verify mint, so the modal sat unsolved
   and every re-click just reopened it (the planner clicked it 6× and gave up).
   FIX: `attemptMintNewKey` now fills the name, then runs `runCaptchaGate` on the
   open modal (Tier-1/2 Turnstile) before polling the submit. Live trail:
   `Mint-modal captcha (turnstile): solved` → `extracted the freshly-minted key` →
   `groq → ok (2 credentials)`, skill auto-promoted. Generalizes to any service
   that gates key creation behind a captcha. Helpers: `findKeyModalSubmit` /
   `findKeyNameInput` (agent.ts).

### ✅ verify-pool health (2026-06-17): verify-01..05 were NEVER-ACTIVATED, now fixed (warm bug)
groq runs kept failing `needs_login` with `accounts.google.com/v3/signin/deletedaccount`
on whatever robot got picked, and JIT re-warm couldn't rescue them. Admin-API `users.get`
nailed it: verify-01..05 had `suspended=false` but **`agreedToTerms=false` +
`lastLoginTime=1970-01-01Z`** (never activated), while verify-10..14 had `agreedToTerms=true`
+ real logins. A Directory-API-created Google account is OAuth-UNUSABLE (→ `deletedaccount`)
until a real first sign-in completes Google's ToS. The bug: the fleet warmer
(`google-login-fleet.mjs`) short-circuited on a stale SID cookie that LANDS on
myaccount.google.com, so it reported a FALSE `✅ logged in` in ~8s and never reached the
ToS page. FIX (committed): warm now prechecks `agreedToTerms` and force-clears the session
(`FLEET_FORCE_FRESH`) to run the full email→password→ToS activation for not-yet-activated
robots; success is gated on actually landing on myaccount, not cookie-presence. All five
now `agreedToTerms=true`; pool back to 10. LESSON: `provision-verify-robot.mjs list`
`google=live` only checks directory existence — NOT activation. A never-activated robot
looks healthy and silently tanks every run that picks it.

---

## Cloudflare-Turnstile "wall" (exa, cartesia, render-cron, replit, runpod, turso)

### ✅✅ ROOT CAUSE FOUND + FIXED (2026-06-12) — it was the Playwright LAUNCH, not the environment

**The tell is `launchPersistentContext` itself.** Cloudflare Turnstile detects the
flags/instrumentation Playwright/patchright inject when they *launch* Chrome — NOT
the IP, NOT the fingerprint, NOT the live CDP attachment, NOT the click mechanism.

**The decisive experiment (every variable held constant — same harvester box, same
datacenter IP `172.93.111.86`, same Xvfb display, same Chrome 148 binary, same
software-WebGL, same humanized click; fresh profile so the challenge renders).**
Loaded `dashboard.exa.ai/login`, which serves a **visible interactive Turnstile
checkbox** (sitekey `0x4AAAAAADSpJWQOnICEKAwx`), and clicked it:

| Launch | CDP attached | Click | Result |
|---|---|---|---|
| Playwright `launchPersistentContext` | yes | CDP `page.mouse` | ❌ "Verification failed" |
| Playwright `launchPersistentContext` | yes | OS-level `xdotool` | ❌ "Verification failed" |
| plain `google-chrome` (no automation) | no | OS-level `xdotool` | ✅ **"Success!"** |
| plain `google-chrome` + `connectOverCDP` | **yes** | OS-level `xdotool` | ✅ Success (token len816) |
| plain `google-chrome` + `connectOverCDP` | yes | **`page.mouse`** | ✅ token len816 |

Reading the matrix: row 3 vs row 1/2 isolates the variable to **how Chrome is
launched**. Row 4 proves the **live CDP attachment is NOT the tell** (it's attached
and passes). Row 5 proves the **click mechanism is NOT the tell** (normal page.mouse
passes once the browser was self-launched). All screenshots captured.

**THE FIX (shipped, `browser.ts`):** the bot now **self-launches the Chrome binary**
(`google-chrome --remote-debugging-port=…`, NO `--enable-automation` etc.) and
**attaches via `connectOverCDP`** instead of `launchPersistentContext`. Same shared
profile (OAuth session carries over). Validated **end-to-end through the real
`BrowserController.start()`**: spawned its own Xvfb, self-launch + connectOverCDP,
navigated to `auth.exa.ai`, **Turnstile issued a token (len837), green "Success!"**.
Gated `BOT_SELF_LAUNCH` (default-ON; `=0` for the old path). Credentialed proxies
fall back to the old path (self-launch can't carry SOCKS auth); auth-less proxies +
direct use self-launch. Helpers: `resolveChannelBinary`, `selfLaunchEnabled`,
`findFreePort`, `waitForDevtools`; teardown kills the child + disconnects the browser.

**Also corrected:** exa serves a real **interactive checkbox Turnstile** from the
**datacenter box, direct, no residential IP needed** — the old note that "the box
only ever gets the unsolvable IUAM soft-block; the widget needs residential" is
FALSIFIED. (The dashboard host is **Vercel** — `x-vercel-mitigated: challenge`,
429 to curl, passes for a real browser → redirects to `auth.exa.ai` which is
Cloudflare. Two vendors; the wall that matters is the Cloudflare Turnstile.)

**Why every prior environment hypothesis below was right to be falsified:** they
were all looking in the wrong layer. The cause was upstream of all of them — the
launcher. The hypotheses are kept as the historical record (and because they're
still true claims: e.g. the proxy IP really does score human — see the score probe).

---

The recurring tar pit. Historical status (pre-fix): **cause NOT yet identified; the
environment hypotheses are all falsified; the invariant is the BOT itself.** ☑ The
"invariant is the bot" conclusion was CORRECT — now pinned to the launcher.

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
- **✗ FALSIFIED that the BOX can reproduce the solvable widget (2026-06-13).**
  With gost live, ran exa fresh-profile + force-form THROUGH the residential
  proxy → still the IUAM soft-block, NOT the widget. So the widget is NOT
  reproducible from the harvester box. Cause is one of: (a) the Mac's
  residential IP is now DEGRADED — this session pushed many signups through
  1.240.236.25, dropping its Cloudflare risk score, so it gets the harder IUAM
  (a FRESH residential IP — the laptop's Singapore IP earlier — got the lighter
  widget); or (b) the SOCKS proxy hop itself is detectable (the laptop was
  proxy=direct). Net: IP REPUTATION modulates WHICH challenge exa serves —
  fresh residential → widget (automation-layer, 2Captcha-able); degraded/proxied
  → IUAM (no widget). The 2Captcha-widget test therefore needs a FRESH, DIRECT
  residential IP — i.e. the LAPTOP, not the box. Don't keep re-running exa from
  the box; it deterministically gives IUAM now.
- **✓ MEASURED (2026-06-12): the proxy IP scores HUMAN; it is NOT degraded.**
  Ran a score probe (`/tmp/score-probe.mjs`) THROUGH the residential proxy —
  the *same* egress (`1.240.236.25`) that gets exa's IUAM — and got:
  - **reCAPTCHA v3 score = 0.9** (1.0 = certain human; 0.9 is a clean, very-human
    score).
  - **Lenient Turnstile SOLVED** (the automated session cleared it; token len 21).
  This **partially falsifies hypothesis (a)** above ("the Mac's residential IP is
  now DEGRADED from this session's traffic"): the IP still scores 0.9 on
  reCAPTCHA v3 and still clears a lenient Turnstile. A genuinely
  reputation-degraded IP would tank the v3 score and fail the lenient widget. So
  exa's IUAM is **NOT** a general bot-score / blanket-IP problem — it is
  **exa-specific Cloudflare strictness** (a per-site config + Cloudflare's own
  per-IP/per-site intelligence) that the proxied datacenter→residential hop trips
  while generic reCAPTCHA/lenient-Turnstile checks do not. The remaining real
  variable between "gets the solvable WIDGET" (laptop) and "gets IUAM" (box) is
  therefore **the SOCKS proxy hop itself** (laptop was proxy=direct), not IP
  reputation. Net update to (a)/(b): **(b) — proxy-hop detectability — is now the
  leading explanation; (a) — IP degradation — is largely falsified by the 0.9
  score.**
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

## Egress / residential proxy — barely needed (2026-06-13)

### ✗ FALSIFIED — H: "the datacenter box IP gets blocked, so we need the residential proxy"

The housekeeper forced all egress through a residential proxy (the operator's Mac
gost SOCKS5 over Tailscale, `UNIVERSAL_BOT_PROXY_ALWAYS=true`) on the premise that
its datacenter IP would be blocked. Two independent measurements falsify that the
proxy is load-bearing post-Turnstile-fix:

1. **Live door-check (`tools/affordance-probe.mjs`, the `interstitial` field — was the now-removed `egress-doorcheck.mjs`, folded into the one probe; DIRECT datacenter IP, Miami).**
   Loaded 24 curated Google-OAuth signup pages on the raw datacenter IP and
   classified the anti-bot door (`classifyInterstitialText`). **23/24 cleared** —
   sentry, openai, anthropic, neon, render, posthog, cockroachdb, weaviate, etc.
   The only block was **`together`** (Cloudflare error 1020 — an explicit IP
   access rule). A **4% door-block rate.**
2. **Retrospective on the heal-run failure distribution (~180 failures).** The
   IP-addressable classes (`oauth_session_not_persisted` ≈ 4) are ~2%. The rest is
   nav/OAuth/session/planner bugs a proxy cannot touch: no_signup_link (36),
   loading-shell (36), oauth_stuck_on_chooser (28, now fixed), oauth_onboarding_failed
   (28), run_timeout (24), oauth_required (22), planning_failed (12), needs_login (8).

**Why the premise was ever true and isn't now:** the self-launch Turnstile fix
(2026-06-12, above) retired the IP-sensitive captcha wall. What's left rarely cares
about the IP. → **Action taken:** flipped `harvester.env` to direct-first
(`UNIVERSAL_BOT_PROXY_URL=` empty, `PROXY_ALWAYS=false`). The Mac SPOF is retired.
For the thin tail (`together` + post-OAuth-callback IP rejections) either dequeue or
wire a MANAGED per-GB pool as a narrow fallback — never a personal laptop, never the
default path. **Do NOT re-introduce "force the proxy" without re-running the
door-check and showing a direct-block rate that justifies it.**

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
- **baseten** (2026-06-13) — Google OAuth succeeds, but new accounts land in
  `app.baseten.co/waiting_room`: a MANUAL account-review/approval gate. The API
  key does not exist until a human approves the account. The bot fills the
  approval form then the planner correctly reads "account review waiting room,
  not approved" — but the run falls through to the generic `oauth_onboarding_failed`
  (a MISCLASSIFICATION; should be `onboarding_blocked`). NOT a wizard/budget bug.
  Marked `needs-manual` in `tools/housekeeper-services.yaml`. FOLLOW-UP (deferred
  to avoid colliding with the in-flight kinde stuck-detector edit): add a
  "waiting room / account review pending" classifier near `isAtPaywall` in
  agent.ts so these report `onboarding_blocked` and stop counting as bot failures.

---

## Server-side OAuth-callback walls (NOT nav-fixable; recur on re-run)

The handshake completes but the service never establishes a session on its
callback (Clerk / WorkOS sso-callback drops the session). Bot behavior is
correct; these need manual signup or are genuine walls. Don't keep "fixing" nav:
- **predibase, humanloop** (mislabeled `oauth_loop_detected` — same class),
  **hyperbolic, braintrust** (Clerk `/sso-callback`). The reload fix fires and
  is exhausted; it does not help these.
- ~~**fly-io** (SSO-required org — tokens can't be UI-created)~~ **CORRECTED
  2026-06-14: fly.io is SERVABLE.** It offers **Google OAuth** (not just GitHub),
  and personal accounts create tokens via Account → Access Tokens. The prior
  "SSO/unservable" note was the GitHub-path misdiagnosis; the 2026-06-13 verify
  retire was replay text_match brittleness ("Tokens" matched 2 elements), NOT
  rot. Re-pinned to `oauth_provider: google` in discovery-candidates.yaml so the
  robots can fresh-verify it. Re-discover via Google to regenerate the skill.
  EVIDENCE (`tools/affordance-probe.mjs fly-io`, 2026-06-14):
  `providers=[google,github] email=false card=false interstitial=false` — the
  page itself shows BOTH providers. Plus a 2/2 fresh-verify (real api_key +
  access_token) and now pending-review in the registry. This is the template:
  a wall/capability claim cites a dated probe, not prose.
- **xata** (pre-existing account for the operator's identity + email-link gate).

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

## Post-signup nav-search engine (NAV_SEARCH, **DEFAULT-ON** as of T6, 2026-06-15)

**T6 complete — nav-search is now the default**, as a HYBRID with the greedy
planner (commits 722870b same-site, a84505a handoff, d798c30 default-on).
Live-validated: neon went FAILED→SUCCESS once the handoff landed, and confirmed
to engage with NO flag. The architecture is **nav-search navigates → greedy
planner finishes**: nav-search is strong at navigation (drove neon's org+project
wizards + dashboard to the exact create-API-key modal where greedy gets lost) but
nav-only by design; the greedy planner fills the create-key form. On ANY
nav-search failure (or exhaustion) control falls through to the greedy loop —
the prior default — so enabling it is worst-case "no worse than before". Safety
rails: try/catch (never crash a signup), LLM-tiebreak budget cap (reserve budget
for the handoff), same-site guard (don't wander to marketing/docs). Opt out:
`NAV_SEARCH=0`. T6 evidence: ipinfo/galileo (entry-extract, no regression), unify
(nav-loop navigation), neon (hybrid create-key success). Full suite green (1592).

### History — live-validated on unify-ai (2026-06-14)

Goal-directed best-first search over the dashboard's affordances, replacing the
greedy per-screen LLM step-picker for the post-OAuth → API-key phase
(`apps/mcp/src/bot/nav-search.ts`, `DESIGN-post-signup-nav-search.md`). Iterating
it live on unify-ai (Google OAuth → onboarding → dashboard → key) surfaced **6
generalizable bugs**, each fixed + unit-tested (38 tests) + suite-green
(commits 2a33eb7, 2ec34c9, 64cdbb3):

1. **Goal signals read `extractText` (textContent) → poisoned by inline `<script>`
   source + display:none nodes** (the false-shell class again). Switched the port
   to `extractVisibleText` (innerText). The single biggest fix — every text-based
   goal/onboarding verdict was reading JS source, not the page.
2. **`expandLatentNav` is destructive** — it toggles `aria-haspopup` menus
   blindly, re-closing an already-open avatar/settings dropdown so the post-expand
   read LOSES the keys-bearing nav. Fix: `mergeInventories` ranks the UNION of the
   pre- and post-expand reads.
3. **Clicks on portaled dropdown items (Radix popover/avatar menu) no-op** — the
   popover closes between read and click, URL never changes. Fix: `resolveNavHref`
   + href-first navigation for anchor picks (go to the known destination, don't
   click the fragile node). This is what got unify off the dashboard to `/account`.
4. **LLM tiebreak** (was deferred) — when keys hide behind a generically-named
   affordance ("Advanced"/"Security" tab) nothing ranks; one cheap deterministic
   LLM call picks the best candidate. Explored unify's Profile→Advanced→Security.
5. **SAFETY: the tiebreak picked "Delete Account"** on a keyless settings page.
   `enumerateCandidates` now hard-excludes destructive controls
   (delete/remove/revoke/deactivate/cancel/close-account/leave-org) so neither the
   ranker nor the tiebreak can ever auto-click one.
6. **Tiebreak now knows API keys are often org/workspace-scoped** (B2B) — widened
   its preference list; "usage" excluded.

**unify-ai outcome:** NOT an IP/fingerprint/engine problem. The bot reaches
`/account` and exhausts its tabs (Profile/Contact/Preferences/Advanced/Security —
all account-management, **no keys**). The entire nav is Account/Organizations/
Usage/Billing with **no personal "API keys"/"Developer" link anywhere** ⇒ unify's
key is almost certainly **org-scoped** (under Organizations) or not self-serve for
a fresh personal account. The org-scoped tiebreak hint (#6) is meant to reach it;
**live re-validation is BLOCKED — the 10-robot verify-identity pool is fully spent
on unify-ai** after this debugging marathon (refill or wait to re-test).

**T6 remaining before flag→default:** multi-service regression validation (assert
nav-search doesn't regress services the greedy loop already handles, and that
auto-promote skill-minting stays intact end-to-end). Needs verify-pool refill.

## `stripe` — invisible hCaptcha Enterprise + multi-layer fraud (BYO anchor, 2026-06-23)

Full controlled investigation. Stripe signup (`dashboard.stripe.com/register`,
email/password `FORCE_FORM` path) is gated by an **invisible hCaptcha Enterprise**
widget on the "Create account" button (no checkbox/grid visible — screenshot
confirmed). 2Captcha token solves in ~21–31s but the session is still flagged.

- **H: IP reputation / needs residential.** **✗✗ FALSIFIED.** Identical
  `captcha_blocked: hcaptcha … the site flagged this session` on the GPU-less
  harvester box over **datacenter** (172.93.111.86) AND **residential** (Mac
  SOCKS5, Korea 1.240.236.25) egress — only the exit IP changed. Token solved
  both times; flagged both times. NOT IP.

- **✓ CONFIRMED + FIXED: the WebGL/device spoof never reached the captcha
  iframe.** `installWebglSpoofScript` was re-applied on `framenavigated` **only
  when `frame === mainFrame()`** — so the cross-origin hCaptcha iframe
  (`newassets.hcaptcha.com`) read the REAL `ANGLE (Mesa, llvmpipe …)` software
  renderer + 20-core/high-mem/no-taskbar Linux profile. Proven with an in-iframe
  `UNMASKED_RENDERER` probe: **BEFORE spoof = `llvmpipe`, AFTER = `Intel`**. Fix:
  `frame.evaluate(installWebglSpoofScript)` into the captcha iframe's own main
  world, **timing-hardened** (retry ~3s until the renderer reads Intel — the
  first `framenavigated` often eval-fails mid-commit). **This is the real,
  GENERALIZABLE win** — most hCaptcha/Turnstile sites read these surfaces
  in-iframe; this was an unspoofed tell for all of them. (`browser.ts`.)
  BUT: with the string reliably Intel in-iframe, Stripe **still flagged** → the
  renderer *string* is not Stripe's gate (it hashes the rendered *pixels*, which
  string-spoofing can't change — consistent with the exa llvmpipe note above).

- **✓ CONFIRMED ladder (real hardware, user's own Windows laptop: real Intel
  D3D11 GPU + home residential IP).** Real hardware is a genuine discriminator
  for Stripe (UNLIKE exa Turnstile): hCaptcha went from **hard-flag (no
  challenge)** on the VPS → an **interactive solvable challenge** (rune-tile
  "complete the pattern" + Skip). I.e. the environment moved us from "rejected"
  to "prove you're human." THEN, after the challenge, Stripe's **account-risk /
  fraud layer declined anyway**: *"There was an error creating your account.
  Please contact support."* (Confound: throwaway gmail + repeated same-machine
  attempts that day likely fed the velocity check — but the multi-layer pattern
  is the signal.)

- **✓ CONCLUSION: Stripe = multi-layer BYO anchor** — hCaptcha Enterprise
  (pixel-hash fingerprint) **+** an independent account-risk/fraud decline **+**
  KYC at payment activation. Not botable even on real hardware. Correctly routed
  to **bring-your-own-key** by the refuse-walled provision gate. **Do NOT try to
  bot Stripe again.** The end-user path *is* viable via a brief human-solves-
  their-own-captcha handoff (real hardware gets a *solvable* challenge), which the
  headless discovery box can never do.

- **Built (reusable for the end-user / real-GPU path on OTHER hard sites):**
  `BOT_CDP_ENDPOINT` → attach over CDP to a Chrome on real-GPU hardware (spoof +
  Xvfb auto-disabled in remote mode), plus `tools/mac-gpu-browser.sh`.

## Recurring meta-lesson

**Stop concluding "IP" or "fingerprint" from a single observation.** Every time
we have, a later experiment falsified it (this file is the graveyard). The
discipline: form the hypothesis, name the experiment that would FALSIFY it, run
that experiment, record the result here. patchright + residential is almost
never the cause; the cause is almost always nav-layer, session-layer, a wrong
URL, a returning-user state, or a genuine product gate.
