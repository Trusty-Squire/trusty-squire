# Changelog — @trusty-squire/mcp

## 0.9.3 (2026-06-07)

Graduates the 0.9.3 prerelease line (rc.1–rc.3) to stable and adds the
verify onboarding-skip fix. Everything here that touches `replay-skill.ts`
also runs on the router/provision replay path users hit, not just the
housekeeper.

- **Replay drives the OAuth handshake deterministically.** Skill replay
  used to bail to `needs_login` the moment an OAuth recipe hit an
  account-chooser / consent screen. It now walks the chooser + scope-gated
  consent deterministically (riding the operator's existing `mcp login`
  session — it does not log in), aborting to `needs_login` only on a real
  challenge or a sensitive scope. Live-validated on posthog/cohere/imagekit.
- **Replay no longer false-fails recipes against an already-registered
  account.** A signup-with-onboarding recipe replayed with an account that
  already exists skips the absent onboarding fill instead of hard-failing
  the step, and a credential step that then diverges from the fresh-signup
  capture is reported as `account_already_registered` (transient) rather
  than skill rot — so a working recipe can't be demoted just because the
  replaying account isn't brand new.
- **`use_credential` query-param auth.** The tool accepts `http.query` and
  passes it through, so query-string-auth APIs (FRED's `api_key`, gov/weather
  APIs with no header auth) work: `query: { api_key: "${SECRET}" }`. The
  secret is injected server-side after the host check and never appears in
  the URL.
- **Captures seed `allowed_hosts`.** The universal bot sends the signup host
  as `observed_hosts` when it writes a captured credential, so a new key
  lands with a usable allowlist instead of an empty one (which 403'd every
  `use_credential` call).
- **`nav_timeout` failure classifier.** A navigation / network / proxy
  timeout no longer counts as skill rot, so a transient tunnel blip can't
  retire a healthy skill.

## 0.9.2 (2026-06-06)

- **Quota runway nudge.** On a successful free-tier signup, `check_provision_status`
  now appends "N free signups left — you'll be prompted to upgrade ($19/mo) when
  they run out" while N is in the 1–3 band, so the paywall stops being an ambush.
  Reads the existing `/v1/install/status`; the band naturally skips paid accounts
  (which report 0). Best-effort — a status hiccup never alters or breaks a real
  signup result. Pairs with the API/web one-click pre-authenticated upgrade link.

## 0.9.1 (2026-06-05)

Operational hardening after the 0.9.0 live run burned a residential exit.

- **Housekeeper inter-run pacing.** The discover loop fired signups back-to-back
  within a batch and torched the residential IP's reputation (high-scrutiny
  services started rejecting the session at the OAuth callback). Added a base
  cooldown between live runs (`UNIVERSAL_BOT_RUN_COOLDOWN_SEC`, default 60s),
  adaptive backoff that grows when runs show IP-risk symptoms (OAuth-reject /
  dropped-conn / timeout / no-signup) and resets on a clean success, and a
  per-IP daily cap (`UNIVERSAL_BOT_DAILY_SIGNUP_CAP`, default 30) that stops the
  batch before it burns the exit. All env-tunable (0 disables).
- **AB6 — route unwinnable services to manual.** Known 0% prospects (clerk SPA,
  cloudflare dashboard, the SMS / credit-card / github-2fa human gates) now
  short-circuit to `manual_signup_required` before launching Chrome instead of
  burning ~6min + LLM calls. New B1 `manual` failure stage. Override with
  `UNIVERSAL_BOT_FORCE_UNWINNABLE=1`.
- **G14 — VNC password hardening.** The noVNC handoff passed the password as
  `-passwd <plaintext>` on x11vnc's argv (readable via `ps`); now a 0600
  `-passwdfile rm:<file>`.

## 0.9.0 (2026-06-05)

Post-OAuth navigation: deterministic planner, N1 planner wins (eval- AND
live-validated), an offline eval harness, and a flakiness taxonomy
(docs/DESIGN-planner-navigation-eval.md).

### Bot behavior (shipped)
- **Deterministic planner (temperature 0).** The post-verify navigation planner,
  the form-fill planner, and the tap-number vision read run at temperature 0
  instead of the provider default (~0.7). Same page → same decision run-to-run,
  removing the dominant source of post-OAuth navigation flakiness. Threaded
  through `LLMRequest`, all three LLM clients, and the `/v1/llm/chat` proxy.
- **create-over-extract (N1 wall).** On an API-keys/tokens page with a Create/
  Generate button — empty *or* listing existing masked keys — the planner now
  clicks Create to mint a fresh key instead of `extract`ing a masked/absent one;
  extract only when a complete unmasked value is shown. **Live-validated:**
  netlify + baseten now reach a key (baseten was the eval's sealed holdout).
- **Image media-type fix.** Planner image blocks label the screenshot by its
  actual bytes (PNG vs JPEG), not a hardcoded `image/jpeg` — fixes an Anthropic
  premium-fallback 400 on PNG screenshots.
- **`SignupResult.failure_stage`** — a structured terminal-stage taxonomy
  (oauth_handshake / hydration / planner_loop / extract / verify_email / captcha
  / …) on every run and the run-outcome sidecar.
- **New knobs:** `UNIVERSAL_BOT_PREMIUM_MODEL` (parse-failure fallback model),
  `UNIVERSAL_BOT_OR_PROVIDER` (pin one OpenRouter backend; eval determinism).

### Dev harness (not shipped in the tarball)
- Offline navigation-planner eval: A2 run-outcome capture sidecars → `build-corpus`
  (auto-derived **reject-driven** regress set, R1) → `label-target` (30 hand-
  labeled cases) → temp-0 gated `eval-gate` → `planner-eval.yml` CI gate → B2
  `failure-stats` aggregator.
- **Layered R3 redaction**, audited against real captures: provider keys / JWTs /
  emails, operator-handle denylist (`TRUSTY_SQUIRE_REDACT_IDENTITIES`), a neutral
  high-entropy marker (a `[REDACTED_TOKEN]`-littered page biased the planner
  toward extract), and an extracted-credential-value scrub (a success page shows
  the real key). Zero leakage verified.
