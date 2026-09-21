<p align="center">
  <a href="https://trustysquire.ai" target="_blank" rel="noopener noreferrer">
    <img width="84" height="84" src="https://trustysquire.ai/logo.svg" alt="Trusty Squire shield" />
  </a>
</p>

<h1 align="center">Trusty Squire</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@trusty-squire/mcp"><img src="https://img.shields.io/npm/v/@trusty-squire/mcp?logo=npm&color=cb3837" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@trusty-squire/mcp"><img src="https://img.shields.io/npm/dm/@trusty-squire/mcp?color=cb3837" alt="npm downloads" /></a>
  <a href="https://github.com/Trusty-Squire/trusty-squire/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Trusty-Squire/trusty-squire/ci.yml?branch=main&label=CI&logo=github" alt="CI status" /></a>
  <a href="https://github.com/Trusty-Squire/trusty-squire/stargazers"><img src="https://img.shields.io/github/stars/Trusty-Squire/trusty-squire?logo=github&color=eac54f" alt="GitHub stars" /></a>
  <a href="https://github.com/Trusty-Squire/trusty-squire/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
</p>

<p align="center"><strong>Empower agents with auth and payments.</strong></p>
<p align="center">MCP tools to automate auth and pay — your keys and card stay out of agent context.</p>

Trusty Squire is an **MCP server that lets Claude Code, Codex, Cursor, OpenCode, Goose, and other coding agents sign up, provision, and purchase on your behalf**. It opens a real browser, works through signup, sign-in, setup, and checkout flows one step at a time, clears the bot-detection and email-verification steps that make operator tools stall, and hands the job back to a person only when one is actually required. That covers wiring up OAuth and API keys for the app you're building as much as it covers paying a checkout, sending a gift, or booking something — the same operator primitives drive all of it.

Provider secrets and payment cards are write-only: the agent's credential tools return references and authenticated results, never stored plaintext. The raw secret never needs to enter the agent's context, so it can't be pasted into a commit, leaked in a log, or read back out over chat. When a task genuinely needs the plaintext somewhere the agent controls, `fetch_credential` releases it — for one credential, once, and only after you sign that exact request with your passkey. Backend access is a host-scoped, rate-limited, independently revocable grant, so a leaked token is killed without rotating the provider key — and you connect Google or GitHub yourself in a real browser, so the agent never types your password. Full [threat model below](#security-and-threat-model).

## Direct payment observation

The agent drives the live checkout from ordinary browser evidence. It reads the
amount, currency, DCC choice, card controls, validation errors, requests, and
rendered state with `operate_observe`, `operate_network`, and
`operate_screenshot`, then uses the ordinary click, type, select, press, scroll,
and wait loop to advance the purchase. A spinner is evidence; the operator does
not translate it into a payment stage.

When card fields are ready, call `list_payment_cards` and then
`inject_card` with the addressed session, the purchase terms, the selected
`card_ref`, and an observation ref for each field to fill. `inject_card` uses the
existing single human approval for that purchase, verifies the signed release,
and opens the card only inside the operator. A pending approval is resumed with
the returned `approval_id`; retries may supply changed field refs under that same
still-valid approval. The primitive fills only the named fields and returns a
per-field `filled`, `not_found`, `detached`, or `native_error` result. Expiry,
cardholder name, and billing are not inject targets and are not secret: the
result carries `exp_month`, `exp_year`, `name`, and any stored billing alongside
`last4`, and you type those with `operate_type`/`operate_select`. It never
searches for a provider, chooses a saved-card UI, rereads the total, submits,
clears fields, or diagnoses the checkout.

Hosted-field providers can render decoy autofill or focus-helper inputs beside
the actual field (notably Braintree and Stripe). Choose the ref for the visible
card control, not a helper input. Before placing the order, re-observe and
confirm that no competing merchant-saved-card radio or option remains selected.
If a 3-D Secure challenge appears, the operator detects it on the next
observation or action result, notifies the cardholder once through the purchase
notification path, and reports `three_ds` with state `challenge_detected`; keep
observing the live checkout while the cardholder completes it. `three_ds` can
also carry state `sdk_error_retryable`: no challenge rendered and nothing
notified, because the processor's own SDK failed to launch its challenge UI
(e.g. `THREEDS_CARDINAL_SDK_ERROR` in the page's error telemetry). That failure
is transient — the checkout re-arms, and resubmitting the payment is expected
to launch the challenge. It is advisory only: nothing is gated, and a detected
challenge always takes precedence. Once a challenge has rendered in the
session, the advisory is never reported again, so a resubmit prompt can never
ride a checkout that already completed one.

Before the first card write, the operator installs a session-lifetime output
mask for that released PAN and security code. Normal DOM/AX observations, raw
attribute/subtree reads, network headers and bodies, errors, console evidence,
and screenshots replace or cover complete values and ordinary PAN prefixes of
at least eight digits. Merchant last4, brand, name, expiry, billing address,
amounts, currency/DCC, HTTP errors, API keys, and 3-D Secure controls remain
visible. The agent re-observes partial fills, retries targets if needed, selects
currency, clicks place order, and follows 3-D Secure from the same generic
evidence stream. There is no `operate_payment_status` or operator-owned
submit/outcome state machine.

This is a narrow ordinary-checkout boundary, not hostile-page information-flow
containment. It is designed for ordinary forms and reachable hosted fields;
provider-specific behavior still has to be verified from the returned field
results and fresh observations. A hostile page can split, encode, or
canvas-render a card value so it no longer matches the released value; the
operator does not add a broad secret scanner or claim to defeat that page.

## Install

```bash
npx @trusty-squire/mcp connect
```

`connect` signs you in with Google or GitHub, detects your coding agent, and merges the `squire` MCP server into its existing configuration. On an enrolled machine, sign-in opens a tab in Trusty Squire's shared browser. When that browser is on the machine's own screen and you are running `connect` there, you finish sign-in in the window in front of you — no URL and no virtual display. Otherwise — the shared browser started without a screen and sits on a private Linux display, or you are running `connect` over SSH or a TTY with no screen of your own — the ceremony prints a single-use noVNC URL; open that URL on another device. The URL shows and controls the whole display that browser runs on until the ceremony ends: other sessions' tabs, and on a machine with its own screen, everything else on that screen. macOS and Windows draw their windows natively, so the shared browser's tab is on the screen in front of you there and nothing is exposed over noVNC. If the display cannot be shown, connect stops with an explanation instead of waiting indefinitely. On a first connect where no broker can serve, connect launches its own sign-in browser, using a visible desktop when one still answers or a login-scoped Xvfb + noVNC stack on headless Linux (including SSH/TTY sessions with an inherited virtual display, and a display that has stopped answering since startup).

Ceremony completion, timeout, failure, or interruption tears down its quick tunnel and local exposure helpers. The shared browser and its display remain with the broker; a self-launched ceremony also closes its own browser and display. Operators may set both `TS_LOGIN_PUBLIC_HOSTNAME` and `TS_LOGIN_LOCAL_PORT` to reuse an externally managed named tunnel, which Trusty Squire never creates or stops. If that fixed local port is busy, login reports it and uses a one-off quick tunnel instead. Restart the agent and ask for the finished website outcome. Trusty Squire is free to start.

`connect` is also the only way to sign in again: `--force-relogin` switches the bound account and `--force-relogin=google` or `--force-relogin=github` refreshes one provider session. It re-checks provider sessions before reporting success; when the shared browser keeps the profile busy, that check uses committed cookies, which can outlive a server-side session. Use `--force-relogin` to refresh a stale session. The detailed [provider-probe and ceremony contract](docs/browser-broker.md) describes completion and failure handling.

Local state is kept separately for each connected account, and `connect` pins
that account in the agent's MCP configuration; connecting another account does
not replace the first account's state. To remove just one account, run
`npx @trusty-squire/mcp logout --account=<id>`; without `--account`, `logout`
removes the most recently connected account. `--account` requires a nonempty
account ID.

To choose a target explicitly:

```bash
npx @trusty-squire/mcp connect --target=codex
```

Supported targets: `claude-code`, `cursor`, `codex`, `opencode`, `goose`, `cline`, `continue`, and `hermes`.

The isolated `operate_*` browser runtime currently requires Linux and a local Chrome connection;
remote CDP, macOS, and Windows operator sessions are not supported in this migration stage.

## What happens

1. Your coding agent names the website and the outcome it needs: an account,
   authenticated setup, app publishing, a purchase, a gift, or a booking.
2. Trusty Squire works through the service flow one step at a time. Every task
   opens its own fresh browser profile and restores the snapshot's non-Google
   signed-in state, so independent sessions can run concurrently without opening
   the canonical login profile. Google state is restored inside the serialized
   `operate_login` boundary; sanctioned Gmail verification
   uses a separate temporary identity browser.
3. If the flow produces an API key or client secret, Trusty Squire captures it
   into the vault without returning the raw value through its credential tools.
4. The agent can make an authenticated request, create a host-scoped app grant,
   or use a saved card for a supported checkout after you approve the purchase.
5. Eligible successful flows can become signed registry skills, so later runs can replay verified steps instead of rediscovering every click.

If a site requires phone verification, a hard CAPTCHA, an unresolved 3-D Secure
challenge, an unsupported payment method, or another human decision, the run
hands control back and tells you. It does not guess or pretend the task completed.

## Supported services

Discovery pages are generated only for services with an active skill in the Trusty Squire registry. The first five detailed pages cover Braintrust, Cerebras, Clerk, DeepInfra, and Zilliz Cloud. Each sample has explicit signup evidence in its active registry record and a provider request checked against official API documentation. The service hub also lists every active registry entry; the remaining detail pages stay unpublished until their workflow and unique content pass review.

Browse the [active service catalog](https://trustysquire.ai/services). Maintainers can detect registry drift before merging with:

```bash
pnpm seo:verify-services
```

The registry controls which service pages exist. An external list is never used to claim support.

## Keep provider keys out of agent context

Ask the agent to create a scoped backend grant:

```text
Grant this backend access to Clerk through Trusty Squire with a limit of 100 requests per hour.
```

Before minting the grant, make `api.clerk.com` the credential's primary allowed host in the Vault. The egress proxy refuses every other upstream host. This explicit policy step is required when the signup host and provider API host differ.

The agent calls the real MCP tool with the service and requested limit:

```text
grant_app_access({
  service: "clerk",
  rate_limit_per_hour: 100
})
```

Rate limits are opt-in. Omitting `rate_limit_per_hour` creates an unlimited
grant; host scoping, auditing, and revocation still apply. When a grant reaches
an explicit hourly limit, the proxy returns `429 rate_limited` with
`scope: "grant"`, `Retry-After`, and window/reset metadata.

The result contains a host-scoped egress `base_url` and a `token`, not the Clerk secret key. The token is returned once through the MCP result and remains valid until revoked. That means the scoped grant token can enter agent context; it is not the provider key. Move it directly into backend-only deployment secret storage, never browser code, logs, or source control. If you need zero grant-token exposure to the model, use `use_credential` for agent-initiated requests instead. Trusty Squire removes the grant authorization at the boundary and injects the vaulted provider credential into the upstream request.

## Security and threat model

- Provider credentials are encrypted in the vault and are write-only to agent credential tools. Those tools return references or authenticated results, not stored plaintext. `fetch_credential` is the single exception and it is not the agent's to take: it returns the raw value only after you approve that specific fetch with your passkey, once per approval, with the reveal recorded in the audit ledger.
- The raw provider key is injected only into the outbound provider request. It does not need to land in chat, generated code, the consuming app, or the project's `.env` file.
- App grants are host-scoped, auditable, rate-limitable, and independently revocable. A leaked grant can be revoked without rotating the provider key.
- You connect Google or GitHub in a real browser. Trusty Squire does not ask the coding agent to type those passwords.
- Saved cards are encrypted in your browser with a passkey-derived key. For a
  purchase, your phone releases the card only after approving the exact purchase
  details shown on the approval page. The caller then observes the live checkout,
  places the order, and verifies the result through the generic operator tools. The API
  temporarily relays only operator-sealed card ciphertext and its signed mandate.
  Trusty Squire's API never receives plaintext PAN or CVV. The normal operator
  read path masks the released PAN (including ordinary formatted spellings and
  prefixes of at least eight digits) and security code before model-facing
  output; hostile transformed page output is outside that narrow boundary. See the
  [security model](https://github.com/trusty-squire/trusty-squire/blob/main/SECURITY.md#client-encrypted-card-data)
  for the signed mandate's binding contract.
- Browser screenshots and diagnostics remain verbatim except for the released
  card's narrow PAN/security-code mask. Treat all other rendered values as
  potentially sensitive.
- Trusty Squire does not bypass phone verification, hard CAPTCHAs, 3-D Secure,
  payment authorization, or decisions that belong to a person. It stops for
  human input.

See the [security model](https://github.com/trusty-squire/trusty-squire/blob/main/SECURITY.md)
for the card and credential trust boundaries, and
[architecture](https://github.com/trusty-squire/trusty-squire/blob/main/docs/ARCHITECTURE.md)
for the system and data flows.

## MCP tools

Discover the installed tool inventory and schemas with `tools/list`. For the
operator surface and input contracts, see
[operator-tool-surface.md](docs/operator-tool-surface.md).
The evidence required to qualify an operator build is in
[operator-acceptance-runbook.md](docs/operator-acceptance-runbook.md).
Continue a pending card release by re-calling `inject_card` with its returned
`approval_id`. `operate_screenshot(session_id,
frame_index?, frame_url_contains?, full_page?)` is a read-only debugging capture
(page or one isolated frame, e.g. a cross-origin 3-D Secure/captcha challenge)
returned as an actual MCP image. It returns real pixels, with only injected
PAN/security-code controls and identified ordinary copies covered after card release.
For controls visible only in the image, see
[screenshot-coordinate clicks](docs/operator-tool-surface.md#clicking-a-screenshot-visible-control).
The maintainer-only `list_extract_failures` → `get_extract_failure`
DOM-diagnostics pair is excluded from that surface; set
`TRUSTY_SQUIRE_DIAGNOSTICS=1` in the MCP server environment to opt into the
diagnostics profile.

Operate sessions default to `format:"compact"` observations: a bounded,
paged `browser-use-control-query` control map containing every actionable
button, link, textbox, select, checkbox, radio, tab, menuitem, and file
control, including those outside the viewport. Non-control markup and page text
are absent from that shape by construction, never redacted. Use `query`,
`role`, or `cursor` to filter or page the same map, then scroll or act on a
returned ref. Use `format:"full"` only when the DOM tree is needed for page
text, attributes, or layout context. Both formats are otherwise verbatim, with
the same narrow released-card value mask. The authoritative observation
contract is [observation-model.md](docs/observation-model.md), and the detailed
full-DOM structure is in
[browser-use-serializer-port.md](docs/browser-use-serializer-port.md). A browser action can
require re-observation before a ref is used again. Click, type, select, press,
and scroll also default to compact observations; pass `format:"full"` on that
action only when its verbatim DOM is needed. See the observation contract above
for delta handling and response envelopes. The detailed DOM-tree contract lives
in [browser-use-serializer-port.md](docs/browser-use-serializer-port.md).

- Rejected tool calls return a JSON `error` envelope with a stable `code` and
  message. Malformed and unknown calls fail only that request; they do not stop
  the stdio process or discard the broker-owned operator session.
  `server_unavailable` includes `retry.max_attempts: 1`: retry once, and never
  kill or restart the shared operator process.
- `operate_start` opens a scoped website session and `operate_observe` reads its
  current state. For a signup, checkout, or other goal-shaped task, call
  `operate_drive` with the goal and facts (or pass `url` to open and drive in
  one call) instead of planning each click and type yourself; resume that
  session with `answer` and/or added facts if it hands back. Drive ordinary
  controls with `operate_click`, `operate_type`,
  `operate_select`, `operate_press`, and `operate_scroll`; use
  `operate_navigate` for scoped navigation. Acting tools target a current `ref`.
  `operate_type` accepts either literal `text` or a protected session `slot`,
  never both. `operate_click` alone may use its guarded internal DOM-dispatch
  fallback after a proven non-dispatch; it is not a public alternative action.
  Frame scope and stale-ref handling remain fail-closed. For click-triggered
  pickers, follow the [picker and popup guidance](docs/operator-tool-surface.md#pickers-and-popup-return).
  Use `operate_login` for atomic OAuth and the username/password lifecycle,
  `operate_extract` to [capture credentials](docs/operator-tool-surface.md#credential-capture-and-retrieval),
  and `operate_fill_credential` to load protected slots. The only mailbox
  access is `operate_read_inbox`, the consent-gated Gmail verification read;
  CAPTCHA solving, general inbox polling, local upload, and specialized cart
  mutation are not operator verbs; inspect and drive the page's ordinary UI or
  hand the task back to the user.
  Browser requests need no host declarations. See the
  [egress contract](docs/operator-tool-surface.md#browser-egress-is-unrestricted)
  for legacy parameter compatibility and the unchanged payment/vault boundaries.
  Operator servers automatically share the [browser broker](docs/browser-broker.md),
  which owns the user's Chrome profile. Before a session starts,
  the operator checks the live Google My Account identity; if the profile is
  signed out, it returns a clear login handoff before navigating to the service.
  If a restart or reconnect leaves the browser profile busy, follow the
  [reconnect recovery guide](docs/DESIGN-warm-browser-reuse.md#recovering-after-reconnect).
  For proxy configuration and shared-browser compatibility, see the
  [broker configuration guide](docs/browser-broker.md#configuration-and-operation).
  Under the browser-use DOM format, an expired, forged, wrong-generation, cross-page, or drifted
  `@e:` handle fails opaquely with `reobserve_required`; re-observe and choose a
  current handle. Under V1, DOM churn returns `target_stale` with the last
  observation generation, `reobserve_required: true`, best-effort label-keyed
  `replacement_candidates`, and `retry_policy: "do_not_retry_old_ref"`.
  Malformed flat-verb calls return `error.code: "invalid_arguments"` without
  ending the shared server process or discarding the active session. For a
  provider login, pass the observed provider-button ref to `operate_login`.
  It retains the product tab across provider-owned popup redirects and closes.
  Completion requires attempt-local navigation evidence from the selected
  provider to the exact declared return path and fixed query. A declared chain
  may contain one return destination or one callback followed by one dashboard;
  in the two-destination case, only the terminal dashboard completes login. An
  unrelated same-origin page, a longer chain, or a chain that returns to the
  provider remains pending. When the authorized completion destination is still
  open, that destination becomes the session's operation page: its post-login
  observation and later page-bound operations (actions, reads, screenshots,
  navigation, verification, and checkout) stay bound to it, leaving the retained
  product tab untouched. An owned tab opened by a later action becomes the
  operation page for following calls. It returns the normal post-login
  observation even if `detail` is `none`; if that observed destination closes
  before handoff, it returns a terminal `oauth_completed` snapshot with refs
  unavailable and directs the host to `operate_observe`, which resumes on the
  retained viable product page. Every OAuth login
  is serialized from action start through completion and a short release cooldown; other
  session work remains parallel. OAuth setup and post-completion DOM settlement
  use a short deadline capped at 30 seconds. Once an authorized OAuth control
  opens an owned provider popup or navigates the product tab, the chooser,
  consent, and 2FA phase receives a fresh human deadline: five minutes by
  default, or the full positive value of
  `TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS` when configured. At an active-phase
  deadline, it rechecks captured, attempt-local return evidence:
  an observed return completes the action rather than being reported as pending.
  Only when no such completion evidence exists does the call return a normal
  observation with `oauth.state: "awaiting_human"`, a `reason` naming only what
  was observed, and `next_action: "operate_observe"`; it does not error or close
  the session. A consent screen or a 2FA/verification challenge is usually still
  showing, so re-observe and drive it; the session stays open and usable. A
  denial the provider actually reported (an OAuth `error=` code on the return
  URL) fails the action, with that code in the message. For interrupted clicks,
  retained popups, and pre-dispatch failures, follow the
  [OAuth error and recovery contract](docs/operator-tool-surface.md#using-the-rest-of-the-surface).
  If an observation races the transition, it reports `oauth.state: "in_progress"`
  and directs the host to observe again.
- Call `inject_card` with the exact observed refs for the card-entry fields.
  It fills only those refs under the existing purchase approval; the agent
  observes partial results and drives every later checkout action itself. Pick
  the real visible field rather than a hosted-provider autofill/focus helper;
  before placing the order, re-observe for a competing selected saved card. A
  rendered 3-D Secure challenge is detected by the operator, which notifies the
  cardholder once and reports `three_ds` with state `challenge_detected`; keep
  observing while the cardholder completes it. The other state,
  `sdk_error_retryable`, reports that the processor's SDK failed to launch the
  challenge UI at all — nothing is notified and nothing is gated; the checkout
  re-arms and a resubmitted payment is expected to launch the challenge.
- `operate_finish` closes the session with a flat `outcome` enum — never a
  nested union. `none` only closes; `credentials` requires `store` and preserves
  credential extraction and vault storage; `result` requires `summary` or
  `data`. Agent-provided result data is reported information, not proof that a
  login, provisioning operation, or mutation completed. Finish first fences new
  calls and drives the owned terminal transition; callers must not infer closure
  merely from a delivery timeout. Callers should finish promptly instead of
  treating an open browser as durable background state. The current server advertises an additive receipt through `tools/list` with `session_id`,
  `operation_id`, `execution`, `mutation`, `cleanup`, and `closed:boolean`.
  Closure is established only when `closed` is true. Older servers may omit
  these fields; a missing receipt never proves cleanup.
- `operate_recipe_save` saves a postcondition-verified local recipe under a
  closed task verb plus the service's registrable domain. It records stable target
  attributes and exact provenance for Squire-supplied values, not observed refs
  or plaintext secrets. Recipes that pass a share-eligibility check (no
  personal or secret-shaped literals) and a registrable-domain lock are also
  written live to the shared registry, making them immediately reusable by
  other installs without a promotion step. `operate_recipe_run` binds the
  replaying user's own values and replays those steps, preferring the local
  recipe and falling back to the shared one. A recipe cannot navigate outside
  the site it was recorded for; normal keyed replay refuses a violation before
  navigation and continues with cold driving. On one ordinary missed step,
  replay returns a local repair point and can continue in the same session.
  Older name-only recipes remain planning hints.
- `list_payment_cards` returns saved-card labels and opaque references.
  `inject_card` takes one explicit `card_ref`, purchase terms, and per-field
  refs plus the addressed `session_id`. It creates or resumes the single approval
  and returns per-field browser outcomes plus approval metadata, last4, expiry,
  cardholder name, and stored billing; it never returns PAN/CVV or submits.
- `list_credentials` and `use_credential` find saved credentials and make authenticated API calls without returning raw values.
  Before provisioning, call `list_credentials` with
  `{"service":["exa","groq","cartesia"],"fields":"summary"}` to check for
  existing keys without returning the whole inventory. `service` accepts one
  string or a nonempty array and matches exact service names after trimming
  whitespace and ignoring case. `fields: "summary"` selects compact metadata;
  calling with `{}` preserves the full metadata inventory. Discover the exact
  projection and inputs through the installed server's `tools/list` description
  and schema.
- `fetch_credential` returns a credential's raw value to the agent — the one path that does. It first returns an approval link and no value; you open it and sign with your passkey; the agent resumes with the returned `approval_id` and receives the value once. The agent may pass a short `reason`; the page asks the reveal as a question naming the credential, shows which agent is asking, quotes that stated reason, and says when the approval expires. Denial or expiry releases nothing, and a mutation or payment approval cannot be used here. Reach for it only when the key must land somewhere the agent controls (a GitHub Actions secret, a `.env`) with no server-side injection path — `use_credential` is the right tool for calling an API.
- `edit_credential` changes only an existing credential's non-secret name,
  `allowed_hosts`, or `login_hosts`; `delete_credential` soft-deletes one. Each
  first returns a Telegram/passkey approval link bound to the operation, exact
  credential reference, and edit before→after. Resume with only the returned
  `approval_id`. Neither tool can read or alter the secret value; use
  `store_credential` to rotate a secret.
- `grant_app_access` and `revoke_app_access` create and remove scoped backend access.
- `audit_log` reports credential activity without exposing credential values. It
  defaults to a shaped security ledger: lifecycle events and anomalies (non-2xx,
  429, rejected calls) as rows, routine proxied egress collapsed into per
  credential/host/burst rollups with per-grant running totals. Pass a rollup's
  `id` as `expand` for its individual calls, or `view: "raw"` for the flat
  per-request stream.

## One README for GitHub and npm

This root file is the canonical README. The npm pack lifecycle copies it into `@trusty-squire/mcp` byte-for-byte, then removes the generated package-local copy after packing. GitHub and npm therefore publish the same product explanation.

## Development

```bash
git clone https://github.com/Trusty-Squire/trusty-squire.git
cd trusty-squire
./scripts/bootstrap.sh
```

After bootstrap, `pnpm typecheck` and `pnpm test` should pass. Stop local services with `docker compose -f docker-compose.dev.yml down`; add `-v` to reset their data.

Requirements: Node 20.11.0 (`.nvmrc`), pnpm 8.15+, Docker, and Docker Compose.

Repository map:

```text
trusty-squire/
├── apps/
│   ├── api/        Accounts, OAuth, machine tokens, proxy, inbox, vault, and billing
│   ├── mcp/        MCP server, browser operation tools, and credential tools
│   ├── registry/   Signed website skills and verification service
│   └── web/        Marketing site and vault UI
└── packages/
    ├── vault/         Encrypted credential storage and audit log
    ├── skill-schema/  Shared schema for replayable website skills
    └── recipe-schema/ Shared wire schema for operator replay recipes
```

Product and public-web changes should follow [PRODUCT.md](https://github.com/trusty-squire/trusty-squire/blob/main/docs/PRODUCT.md) and [DESIGN.md](https://github.com/trusty-squire/trusty-squire/blob/main/docs/DESIGN.md).

## License

[MIT](https://github.com/trusty-squire/trusty-squire/blob/main/LICENSE) © Trusty Squire
