# `ts-recaptcha-autosolve-not-engaging` — findings

Task: why does the reCAPTCHA auto-solve never appear to engage on a rendered
challenge during a plain `operate_*` drive (captain: challenge renders, expires
~90s, anchor re-arms, NO `[captcha-autosolve-diag]` line anywhere)?

## Root cause (three layers, in order of importance)

### 1. The negative evidence was a log-routing artifact — the auto-solve DOES engage

`attemptOperateCaptchaAutoSolve` (`apps/mcp/src/bot/captcha-solve.ts`) runs
unconditionally from every observation (`observe.ts`). Its diagnostics — the
`[captcha-autosolve-diag]` `console.error` lines AND the `provision-audit`
entries — go to **the broker daemon's stderr**,
`~/.trusty-squire/.trusty-squire-broker-leases/launch/broker.log`, never to the
MCP server's or operator's log. The daemon serving the reported drive was a
stale npx-cached release (`@trusty-squire/mcp@1.1.15-rc.2`) launched with
stderr → `/dev/null`, so **no diagnostic could ever appear**. Watching the
operator log for solver output is structurally the wrong place.

### 2. Proven live: the plain drive engages, purchases, injects, and clears

Full plain `operate_*` drive on Kaggle signup (harness
`apps/mcp/scripts/kaggle-drive-repro.mjs`, stdio MCP server + queue-dir
commands; session `2fcfaacf-51c0-46a8-8a75-9566be03a4fd`, daemon-internal id
`ad187119-33f0-40cf-a2c2-a9c1ae932092` — the broker rekeys session ids in
`broker/operator.ts`, so daemon-side audit lines carry the internal id). With
all diagnostics visible in `broker.log`:

```
[captcha-autosolve-diag] variant=recaptcha_v2 outcome=detect challenge_rendered=true
audit {"event":"captcha_autosolve","outcome":"<sealed>","challenge_rendered":true}
[captcha-autosolve-diag] outcome=fetch_skipped reason=in_flight     (during solve)
[captcha-autosolve-diag] outcome=fetch_skipped reason=cooldown
[captcha-autosolve-diag] outcome=token_purchased                    ×3
[captcha-autosolve-diag] outcome=ok confirmed=true age_ms=6726      ×2  ← injected, widget confirmed
```

Blockers cleared after injection (`ok confirmed=true`); the registration form
was fully interactable with no challenge blockers.

### 3. The real friction: purchase latency vs 120s token lifetime vs observe cadence

`CAPTCHA_TOKEN_LIFETIME_MS = 120_000`. 2Captcha purchase latency observed
25s–5min. The token is injected on the observe **after** purchase; if the
agent's observes are sparse the token expires before injection:

```
[captcha-autosolve-diag] outcome=token_expired age_ms=172127   (observed, sparse cadence)
[captcha-autosolve-diag] outcome=fetch_skipped reason=expiry_backoff expiries=1 remaining_ms=30000
```

The challenge overlay itself expires ~90s; the widget then re-arms and Kaggle
renders "Verification challenge expired. Check the checkbox again." With a
normal observe cadence (≤~60s) the injection lands inside the lifetime — as
proven above. This matches the reported symptom ("expires, re-arms, no solve")
exactly.

## Why the account could not be created (recorded reason)

Two submission windows were missed for operational reasons (driver-side ref
extraction bug; then a ~3min gap between `confirmed=true` and the submit
click — beyond the 120s token life; Kaggle then shows "Captcha must be filled
out."). After ~10 anchor interactions and 3 purchased tokens in ~90 minutes,
Kaggle's reCAPTCHA risk engine stopped issuing challenges for the
profile/IP entirely: every further anchor click left the anchor unchecked and
`challenge_rendered:false` persisted for 7+ minutes across retries, page
reloads, and both ref and coordinate clicks. **The auto-solve cannot run
without a challenge to solve; Kaggle stopped presenting one.** A later attempt
(cool-down, different IP, or fresh session after the risk window resets) can
complete the signup using the exact cycle proven here:
render → observe → poll for `token_purchased` → on `confirmed=true` click
submit within seconds.

## Fix shipped

`solve` was not broken; the one genuine gap was observability: the `detect`
state emitted **only a sealed audit entry**, so `challenge_rendered:true/false`
was unreadable in the trail and a silent early return was indistinguishable
from the auto-solve never running (the exact ambiguity this task chased).
Added the missing unsealed diag line at detect, matching the existing pattern:
`outcome=detect challenge_rendered=<bool>`.

## Operational notes for future Kaggle/recaptcha repro

- Watch `~/.trusty-squire/.trusty-squire-broker-leases/launch/broker.log`, not
  the operator log, for `[captcha-autosolve-diag]` and audit lines; audit
  outcome values are sealed — only diag lines and `challenge_rendered` /
  `card_released` booleans are readable.
- The broker rekeys session ids (`broker/operator.ts` `remapSession`);
  correlate by timeline or by the daemon-internal id.
- A stale shared daemon (npx-cached old release, stderr /dev/null) silently
  blinds every lane sharing the profile; check `ps -o args=` on the daemon pid
  before trusting "no diagnostics".
- Anchor click recipe: `operate_screenshot frame_url_contains=recaptcha` →
  `operate_click` screenshot binding (28,39) image_pixels. First click after a
  widget reset is the reliable one; rapid repeats often do not re-render.
