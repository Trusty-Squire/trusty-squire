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
<p align="center">MCP tools to automate auth and pay — your keys and card never leave the vault.</p>

Trusty Squire is an **MCP server that lets Claude Code, Codex, Cursor, OpenCode, Goose, and other coding agents sign up, provision, and purchase on your behalf**. It opens a real browser, works through signup, sign-in, setup, and checkout flows one step at a time, clears the bot-detection and email-verification steps that make operator tools stall, and hands the job back to a person only when one is actually required. That covers wiring up OAuth and API keys for the app you're building as much as it covers paying a checkout, sending a gift, or booking something — the same operator primitives drive all of it.

Provider secrets and payment cards are write-only: the agent's credential tools return references and authenticated results, never stored plaintext. The raw secret never needs to enter the agent's context, so it can't be pasted into a commit, leaked in a log, or read back out over chat. When a task genuinely needs the plaintext somewhere the agent controls, `fetch_credential` releases it — for one credential, once, and only after you sign that exact request with your passkey. Backend access is a host-scoped, rate-limited, independently revocable grant, so a leaked token is killed without rotating the provider key — and you connect Google or GitHub yourself in a real browser, so the agent never types your password. Full [threat model below](#security-and-threat-model).

## One prompt

```text
Add Google OAuth to this app in one prompt: create the OAuth client, save the client secret, and wire it in without putting the raw key in chat, code, or .env.
```

Your coding agent plans the job. Trusty Squire operates the website, stores the generated key, and can issue your backend a scoped grant. The backend calls the provider through Trusty Squire, which injects the provider key on the server side.

Other useful asks:

- “Set up Stripe payments for this app and keep the API key out of this conversation.”
- “Create a Render API key for deployment automation and keep it out of this conversation.”
- “Pay this checkout with my saved work card and ask me to approve it on my phone.”
- “Send a gift to my friend without sharing their address with me.”
- “Book this dinner reservation for me.”
- “That app grant leaked. Revoke it without rotating the provider key.”

For supported card checkouts, save a card in the Vault from a passkey-capable
device or let your first `operate_pay` approval link collect one just in time.
When no card is specified, Trusty Squire uses the only saved card, starts the
add-card ceremony if none exists, or asks you to choose when several exist. The
new card is encrypted in your browser with a passkey-derived key and bound to
that purchase before approval; if you add it but do not approve in time, it
remains saved for a faster retry.

Recognized Visa, Mastercard, Amex, Discover, Diners Club, and JCB cards show
their network mark in the Vault while keeping the full bank/network label. Open
a card row to see its masked number; `reveal` runs the passkey ceremony in your
browser before showing the number, name, expiry, and billing address. The CVV is
never shown, even after reveal. The Activity page also records card additions
and removals, payments, and app-grant changes without storing a PAN or CVV.

`operate_pay` requires a non-empty item and reason (calls that omit either
receive a validation error). On a single-page checkout it prefers a machine-read
checkout total, sends you a short-lived approval link, and submits only after you
approve the purchase. A clean visible labeled total wins; when none is readable,
strict schema.org `Order`/`Invoice.totalPaymentDue` structured data can supply the
amount and currency. If neither source exposes a total, caller-supplied
`amount_cents` and `currency` become the authoritative approval amount; an omitted
merchant name falls back to the checkout URL's hostname. Product and offer prices
never qualify as machine-read checkout totals. An unambiguous ISO currency on the
page remains authoritative. A notation that cannot identify one ISO currency by
itself, such as a shared currency symbol or an FX-preview selector, falls through to
the currency already selected or approved for the purchase instead of refusing the
checkout. Any live amount or currency drift still fails closed; the authoritative
binding contract lives in the [security model](SECURITY.md#client-encrypted-card-data).
Approval, 3-D Secure, Activity, and notification amounts use the currency's minor-unit
precision (for example, whole yen for JPY and two decimals for USD). After you
sign in, the owner-only approval page shows the merchant, checkout origin, amount
and currency, item, and reason directly from the short-lived server record before
one passkey ceremony authorizes those canonical payment values. You also see the
requesting MCP client (for example, Hermes) and the bound card's label plus last
four digits (or its label alone for a legacy card) before clicking **Approve
payment** to relay the operator-sealed final authorization. Before submitting that
authorization, you can instead choose **Deny payment**; a denial closes that
approval attempt and prevents any later operator confirmation. When the pre-submission
checkout can be machine-read, the payment is refused if its merchant, origin, amount,
or currency has changed since approval. If that resume read cannot recover a total,
Trusty Squire reuses the original mandate-bound checkout values. Card entry requires the PAN,
expiry, and CVV fields; cardholder name and other explicitly labeled billing fields
are filled best-effort, so a missing name field does not abort the payment. Sealing
and cleanup touch only those selected payment controls; merchant shipping address and
country controls remain untouched. If the checkout has a selected merchant-saved card
alongside the newly filled card, Trusty Squire selects the sole unambiguous new-card
radio and verifies both that choice and the filled fields again immediately before
submission; ambiguous choices, selected saved-card options, and failed verification
are refused with `payment_card_selection_ambiguous`. A charge is treated as
dispatched only after the browser observes a concrete charge/order request, a
terminal merchant outcome, or genuine 3-D Secure evidence; native form validation
alone does not claim a dispatch. A submit is reported as `payment_submitted` only
after the checkout reaches a new merchant order-confirmation URL with a substantive
order or receipt identity. The browser completes 3-D Secure natively, including
out-of-band bank-app challenges — Trusty Squire never manipulates or intercepts the
challenge; it uses read-only checks while polling for that same order-confirmation
signal. At that last observable boundary, a mismatch between the released card and
issuer, network, or last-four evidence rendered by the 3-D Secure issuer/app is
returned as a structured `warning` with `kind: "payment_instrument_mismatch"` and
expected-versus-observed evidence. The warning persists through resumable
`operate_payment_status` calls; it neither changes the payment status nor cancels,
approves, or modifies the challenge, so the cardholder retains the decision whether
to continue. A dispatched attempt with no confirmed merchant outcome and no genuine
3-D Secure evidence remains `payment_outcome_unknown`, including across resumable
status checks; Trusty Squire never relabels that uncertainty as 3-D Secure. A detected
challenge that remains unresolved on timeout stays `payment_3ds_required` with
`needs_user.wall: "3ds"`, handing control back for user completion. Neither status is
success or permits blind resubmission: manually check the merchant's order state
before any retry.

`operate_pay` surfaces the approval link before its bounded server-side wait. It
may wait up to one minute for approval, denial, or expiry; if it returns
`approval_pending` first, call `operate_pay` again with the same arguments. That
call resumes the same approval and one-passkey boundary instead of creating a new
link. `operate_payment_status` is a non-charging alternative for inspecting the
pre-charge approval and is the continuation tool for an already-submitted unknown
or 3-D Secure outcome. Its `wait_seconds` accepts 0-60 (default 0) to bound-wait
instead of taking an instant peek. Denial or expiry is terminal for that session's
attempt: repeated calls return the same result and never mint a replacement
approval. Close the session and start a fresh one before making a genuinely new
payment attempt.

Every payment response includes its `session_id`. Pass that same ID to every
follow-up payment call. Omitting `session_id` remains compatible only while this
MCP process has exactly one session; it never selects a newest or arbitrary checkout.

Some split checkouts collect the card before the final order-confirmation step. On the
card-entry page, `operate_pay { phase: "fill_card" }` first reads the live total. A
subtotal qualifies as that payable amount only when the same order summary says
shipping is free; recommendation and related-product prices are excluded. If that
page exposes no total, caller-supplied `amount_cents` and `currency` take precedence
as the approval amount. If they are omitted, Trusty Squire may use the most recent real
total observed earlier in the same browser session, such as the cart subtotal, only
when the checkout origin still matches. One phone approval
binds that amount and releases the card; Trusty Squire fills the card without
submitting and its role in the purchase ends there. It fills only the merchant's own
HTTPS frames or recognized payment-provider frames. The card stays in the page as
filled fields while the agent advances to the review step and places the order;
those fields are ordinary page content in `operate_observe` and
`operate_screenshot`, not masked. Verify the live final total against the approved
`amount_cents`/currency yourself before placing the order; Trusty Squire no longer
re-reads the total or submits anything. For `operate_click`, a control whose
label looks like pay/place-order may fire only once for that approval. A second
recognized attempt is refused and requires a fresh `operate_pay` approval in a new
session. Non-charge-labeled clicks, key presses, and OAuth controls remain ungated.
After a recognized click dispatches, Trusty Squire best-effort records a secret-free
`payment_place_order_attempted` Activity event bound to the approval, optional
mandate, approved amount/currency, merchant, and opaque card reference. This records
an attempt, not a verified charge outcome.

`operate_pay { phase: "confirm" }` just releases the session's pending-fill lock and
reports the approved terms back — it makes no browser or provider call, records no
audit event itself, and never charges. It can be called any time after the fill — it does not
need to happen before you place the order, and it never reads a total or verifies an
amount. If a payment gets stuck or a card is declined, recover with `operate_finish`
and start a fresh session; `operate_pay` does not support refilling a different card
mid-session.

Before an initial single-page or `fill_card` call, Trusty Squire follows the actual
visible card-number field and hands the checkout back when that field is hosted by
PayPal or Braintree. A separate PayPal express button does not block fillable merchant
or Shopify PCI card fields. Trusty Squire does not sign in to PayPal or use vaulted
PayPal credentials. After any submit that has not yet reached a confirmed order,
Trusty Squire waits 180 seconds by default for native completion, including
out-of-band bank-app approval. A linked Telegram chat receives a challenge-specific
nudge only after 3-D Secure is detected. Standard cross-processor 3-D Secure signals and recognized
CardinalCommerce or Stripe challenge frames classify the first case only when the
containing frame is visibly rendered. Hidden 3-D Secure Method pre-authentication and
captcha-hosted frames never count as 3-D Secure, and an ordinary Shopify PCI card-field
host alone does not either. It reports a visible decline and hands an unresolved outcome
back on timeout, noting whether the Telegram nudge actually went out.
`three_ds_wait_seconds` accepts whole seconds from 0 to 600; set it to `0` on
`operate_pay` to skip the notification and waiting and receive the handoff
immediately.

Connect Telegram under Vault Settings to receive secret-free alerts for
credential, card, payment, and app-grant lifecycle changes. Routine credential
retrieval and proxy access stay in Activity instead of sending a push for every
request.

## Install

```bash
npx @trusty-squire/mcp connect
```

`connect` signs you in with Google or GitHub, detects your coding agent, and merges the `squire` MCP server into its existing configuration. On a machine with a user-visible desktop, sign-in opens a local Chrome window. On a headless Linux server, including an SSH/TTY session with an inherited virtual display, interactive login starts a login-scoped Xvfb and noVNC stack and prints a URL you can open on another device. The default quick tunnel and every local helper are torn down when that login completes, times out, fails, or is interrupted. Operators may instead set both `TS_LOGIN_PUBLIC_HOSTNAME` and `TS_LOGIN_LOCAL_PORT` to reuse an externally managed named tunnel; Trusty Squire still tears down its per-login display and local listener, but never creates or stops that external tunnel. If that tunnel's fixed local port is busy, login reports it and uses a one-off quick tunnel for that sign-in instead. Restart the agent and ask for the finished website outcome. Trusty Squire is free to start.

`connect` is also the only way to sign in again: `--force-relogin` switches the bound account and `--force-relogin=google` or `--force-relogin=github` refreshes one provider session. It reports success only after re-checking the browser profile and finding that Google session live, so a run that binds the machine but leaves no usable session fails loudly with the command to retry rather than reporting a working install.

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
  single-page payment, your phone releases the card only after approving the
  exact purchase details shown on the approval page. On a split checkout, one
  amount-bound approval releases the card; Trusty Squire's role ends at the fill
  and the caller places the order and verifies the final total itself. The API
  temporarily relays only operator-sealed card ciphertext and its signed mandate.
  Trusty Squire's API and the coding-agent model never receive plaintext PAN or
  CVV. See the
  [security model](https://github.com/trusty-squire/trusty-squire/blob/main/SECURITY.md#client-encrypted-card-data)
  for the signed mandate's binding contract.
- Browser screenshots and diagnostics can contain whatever a website visibly rendered. Treat diagnostic artifacts as sensitive and do not ask an agent to re-observe a page after a secret is shown.
- Trusty Squire does not bypass phone verification, hard CAPTCHAs, 3-D Secure,
  payment authorization, or decisions that belong to a person. It stops for
  human input.

See the [security model](https://github.com/trusty-squire/trusty-squire/blob/main/SECURITY.md)
for the card and credential trust boundaries, and
[architecture](https://github.com/trusty-squire/trusty-squire/blob/main/docs/ARCHITECTURE.md)
for the system and data flows.

## MCP tools

The default MCP registry exposes 29 tools (31 when maintainer diagnostics are
enabled). The 18-tool operator driving surface uses flat, single-purpose verbs:
`operate_start`, `operate_finish`, `operate_observe`, `operate_screenshot`,
`operate_navigate`, `operate_click`, `operate_type`, `operate_select`,
`operate_press`, `operate_scroll`, `operate_allow_host`, `operate_login`,
`operate_fill_credential`, `operate_extract`, `operate_pay`,
`operate_payment_status`, `list_credentials`, and `list_payment_cards`.
Recipe and vault/account tools remain separate surfaces. The complete migration
table and input contracts are in [operator-tool-surface.md](docs/operator-tool-surface.md).
The evidence required to qualify an operator build is in
[operator-acceptance-runbook.md](docs/operator-acceptance-runbook.md).
Continue a pending pre-charge approval by re-calling
`operate_pay` with the same arguments; use
`operate_payment_status(wait_seconds)` as a non-charging alternative and for
post-submit outcome checks. `operate_screenshot(session_id,
frame_index?, frame_url_contains?, full_page?)` is a read-only debugging capture
(page or one isolated frame, e.g. a cross-origin 3-D Secure/captcha challenge)
returned as an actual MCP image. It returns the page's real pixels: there is no
redaction pass and no refusal when the page is showing a secret or a card value.
For controls visible only in the image, see
[screenshot-coordinate clicks](docs/operator-tool-surface.md#clicking-a-screenshot-visible-control).
The maintainer-only `list_extract_failures` → `get_extract_failure`
DOM-diagnostics pair is excluded from that surface; set
`TRUSTY_SQUIRE_DIAGNOSTICS=1` in the MCP server environment to opt into the
22-tool diagnostics profile.

Operate sessions default to `format:"compact"` observations: a bounded,
paged `browser-use-control-query` control map containing every actionable
button, link, textbox, select, checkbox, radio, tab, menuitem, and file
control, including those outside the viewport. Non-control markup and page text
are absent from that shape by construction, never redacted. Use `query`,
`role`, or `cursor` to filter or page the same map, then scroll or act on a
returned ref. Use `format:"full"` only when the unchanged, verbatim
`browser-use-dom` tree is needed for page text, attributes, or layout context;
neither format masks or screens emitted content. The authoritative observation
contract is [observation-model.md](docs/observation-model.md), and the detailed
full-DOM structure is in
[browser-use-serializer-port.md](docs/browser-use-serializer-port.md). A browser action can
require re-observation before a ref is used again. Click, type, select, press,
and scroll also default to compact observations; pass `format:"full"` on that
action only when its verbatim DOM is needed. See the observation contract above
for delta handling and response envelopes. Maintainers can select the
legacy V1 `el_table`/snapshot contract with
`TRUSTY_SQUIRE_OBSERVE_V2=off`, or exercise the browser-use DOM serializer
without emitting it with `shadow`; the detailed DOM-tree contract lives in
[browser-use-serializer-port.md](docs/browser-use-serializer-port.md).

- Rejected tool calls return a JSON `error` envelope with a stable `code` and
  message. Malformed and unknown calls fail only that request; they do not stop
  the shared stdio process or discard its active in-memory operator session.
  `server_unavailable` includes `retry.max_attempts: 1`: retry once, and never
  kill or restart the shared operator process.
- `operate_start` opens a scoped website session and `operate_observe` reads its
  current state. Drive ordinary controls with `operate_click`, `operate_type`,
  `operate_select`, `operate_press`, and `operate_scroll`; use
  `operate_navigate` for scoped navigation. Acting tools target a current `ref`.
  `operate_type` accepts either literal `text` or a protected session `slot`,
  never both. `operate_click` alone may use its guarded internal DOM-dispatch
  fallback after a proven non-dispatch; it is not a public alternative action.
  Frame scope and stale-ref handling remain fail-closed. For ordinary actions,
  an owned popup becomes the active page; unrelated/no-opener pages do not.
  Use `operate_login` for atomic OAuth and the username/password lifecycle,
  `operate_extract` to capture
  credentials, and `operate_fill_credential` to load protected slots. CAPTCHA
  solving, inbox polling, local upload, and specialized cart mutation are not
  operator verbs; inspect and drive the page's ordinary UI or hand the task back
  to the user.
  Startup hosts seed the session's merchant scope, including matching
  registrable-domain siblings (for example, `shop.example.com` and
  `api.example.com`). Declare other required non-provider hosts in
  `allowed_hosts` at `operate_start`. A later `operate_allow_host` call can
  activate only a host already in the startup entitlement; it cannot widen
  that entitlement. Calls outside the session scope fail promptly.
  Recognized payment-provider frames, OAuth/captcha providers, and 3-D Secure
  ACS/directory-server hosts retain their narrowly scoped protocol allowances.
  A scope-denial observation identifies its owner document/frame, exact host,
  resource type, reason, and occurrence range without including request bodies
  or URL-query values. Start a new session with the needed host declared rather
  than trying to repair the denial in place.
  Every operator task uses the user's Chrome profile directly. Before it starts,
  the operator checks the live Google My Account identity; if the profile is
  signed out, it returns a clear login handoff before navigating to the service.
  To route only that browser session through a proxy, pass `proxy` to
  `operate_start` as an HTTP or HTTPS URL (credentials are optional), or as an
  unauthenticated SOCKS5 URL. The value is launch-only and sensitive: it is not
  returned in session status, action traces, or saved recipes. Omitting it uses
  direct egress.
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
- Observed card controls are marked `payment_field` and
  `interaction: "vaulted_card_only"`, with `operate_pay { phase: "fill_card" }`
  as the recommended action. Typing a Luhn-valid, card-number-shaped value
  manually through `operate_type` is refused with `safe_alternative: "operate_pay"`
  and the missing prerequisite `verified_cart_total`.
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
- `list_payment_cards` returns saved-card labels and opaque references;
  `operate_pay` accepts an explicit `session_id` and `phase` of `"single"`
  (the default, also implied by omitting phase), `"fill_card"`, or `"confirm"`.
  It can use a selected card, the only card on file, or a just-in-time
  add-card approval. The single-page flow fills the checkout and applies the
  post-submit outcome wait described above before handing back unresolved
  outcomes. Split checkouts use the `fill_card` then `confirm` flow described
  above.
  `operate_payment_status` follows the [payment guide](#one-prompt) bounded-wait
  contract. It returns the session ID and includes it in every follow-up tool
  hint, so an approval or submitted outcome is always observed in its originating
  browser. Malformed calls return normal `invalid_arguments` handling, including a safe resolution
  when `card_ref` and `card_label` conflict.
- `list_credentials` and `use_credential` find saved credentials and make authenticated API calls without returning raw values.
- `fetch_credential` returns a credential's raw value to the agent — the one path that does. It first returns an approval link and no value; you open it and sign with your passkey; the agent resumes with the returned `approval_id` and receives the value once. Denial or expiry releases nothing, and a mutation or payment approval cannot be used here. Reach for it only when the key must land somewhere the agent controls (a GitHub Actions secret, a `.env`) with no server-side injection path — `use_credential` is the right tool for calling an API.
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
