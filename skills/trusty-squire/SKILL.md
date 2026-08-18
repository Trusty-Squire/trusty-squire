---
name: trusty-squire
description: >-
  Use when a coding agent needs to sign up for a website or SaaS, provision an
  OAuth client or API key, pay a checkout, or otherwise act on a real website on
  the user's behalf — and the secret or card must NOT land in chat, source code,
  or a .env file. Trusty Squire is an MCP server that drives a real browser
  through signup, sign-in, provisioning, checkout, email verification, and bot
  gates, then vaults the captured key or card write-only. Triggers: "sign me up
  for X", "get an API key for X", "create an account on X", "set up X and save
  the key", "provision X", "work through publishing this app on X", "ship this
  app through X", "send X as a gift", "book X for me", "let my app call X
  without the key", "pay this checkout with my saved card", "AI agent API key
  management".
license: MIT
metadata:
  homepage: https://trustysquire.ai
  repository: https://github.com/Trusty-Squire/trusty-squire
  npm: "@trusty-squire/mcp"
---

# Trusty Squire

Trusty Squire is an MCP server your coding agent drives. It signs up for
websites, provisions setup behind a login, and pays checkouts, capturing the
resulting API keys and cards into an encrypted, **write-only** vault — so the
raw secret or card never enters your chat, your code, or a `.env` file. This
skill is the discoverable wrapper; the MCP server supplies the actual
capabilities. Publishing, gifting, and booking are composed workflows driven by
the same `operate_start` / `operate_observe` / `operate_act` / `operate_pay` /
`operate_finish` loop, with recipe replay when available; they are not separate
one-shot tools.

## 1. When Trusty Squire is appropriate

Use it when the task requires an agent to **sign up, provision, coordinate, or
purchase on a real website**, especially when a secret or payment card must stay
out of the conversation, the repo, and `.env`. Concretely:

- "Sign me up for Resend / Clerk / <service> and save the API key."
- "Set up <provider>, create a project, generate the key, and wire it in."
- "Get an API key for <service> without showing it to me or putting it in `.env`."
- Finishing authenticated setup — OAuth apps, webhooks, project/region config.
- Working through an authenticated app publishing or deployment flow with the
  general operator loop, including handing user decisions back to the user.
- Sending a gift or booking a reservation by composing website actions with an
  approved payment when needed; there is no dedicated gift or booking tool.
- Using an already-vaulted key to call a provider **without** the raw value
  returning to the agent's context.
- Paying a supported checkout with a saved or just-in-time card after the user
  approves the exact purchase on their phone.

Do **not** reach for it when:

- The key already exists and just needs storing — that is a secrets manager.
- The provider's own API/CLI creates the key without a browser (use that).

## 2. How to install / connect the MCP

Trusty Squire runs on the user's machine. Install and connect in one command:

```bash
npx @trusty-squire/mcp connect
```

To wire a specific host explicitly:

```bash
npx @trusty-squire/mcp connect --target=codex
# targets: claude-code, cursor, codex, opencode, goose, cline, continue, hermes
```

`connect` signs the user in with Google or GitHub, detects the coding agent, and
merges the `squire` MCP server into that agent's config. It is free during beta.

> **Restart the coding agent after `connect`** so it loads the new `squire`
> tools. Until you restart, the tools below are not available.

## 3. How to use its tools safely (after restart)

Once connected and restarted, the `squire` MCP tools appear. The core loop:

- `operate_start`, `operate_observe`, `operate_act` — open the real website and
  drive it one step at a time (signup, sign-in, form fill), clearing bot gates.
- For shopping, use `operate_act { kind: "cart_add" }` instead of clicking an
  add-to-cart control directly. Keep its idempotency key stable across retries
  and bind the canonical product identity plus selected-variant options hash.
  For later cart controls, pass that identity pair to `operate_act` when known.
  Follow the one `checkout_state.next_action`, but treat the state and its
  money fields as informational only. Follow the
  [README payment guide](https://github.com/Trusty-Squire/trusty-squire#one-prompt)
  for `operate_pay` checkout-amount precedence.
- `operate_act { kind: "await_verification" }` — read the email verification
  code or link from the user's own inbox, behind an explicit consent gate.
- `operate_act { kind: "extract" }` — capture a revealed API key/secret
  straight into the write-only vault (never back into the conversation).
- `list_credentials`, `use_credential` — find a stored credential and make an
  authenticated API call **without** the raw value returning to the agent; put
  `${SECRET}` (or `${SECRET.field}`) placeholders in the request and the server
  injects the real value at the boundary.
- `grant_app_access`, `revoke_app_access` — mint or instantly revoke a scoped,
  rate-limited egress grant so a deployed app can call the provider while holding
  a revocable token, not the raw key.
- `audit_log` — review what touched a credential; never exposes secret values.
- `list_payment_cards`, `operate_pay` — select a saved card by label or opaque
  reference, or omit both selectors: one saved card is used automatically, no
  saved cards starts a just-in-time add-card approval, and multiple cards return
  their labels so the user can choose. Never guess among several cards. The tool
  requests phone approval for the exact purchase, fills the checkout, and waits
  after any unconfirmed submit for native completion. When Telegram is linked,
  the nudge distinguishes a detected 3-D Secure challenge from possible
  out-of-band bank-app authentication before handing back an unresolved outcome.
  If add-card returns `needs_user.wall: "card_required"`, re-run for a fresh
  link; if `payment_approval_timeout` includes `card_persisted: true`, the added
  card remains available for the retry. Set `three_ds_wait_seconds` to `0` only
  when the user wants the immediate handoff without notification or waiting.
  Card fields never return through MCP.
- Every payment response includes a `session_id`. Pass that same ID to every
  follow-up `operate_pay` and canonical `operate_payment_status` call. Follow the
  [README payment guide](https://github.com/Trusty-Squire/trusty-squire#one-prompt)
  for polling arguments. Omit `session_id` only when this MCP process has
  exactly one live session; it never guesses the newest checkout.
- Treat `payment_outcome_unknown` as unconfirmed: do not claim success or
  submit again blindly. The card may already have been charged — manually
  check the merchant's order state before any retry.
- On a split checkout whose card-entry step shows no total (or only a subtotal),
  call `operate_pay` with `phase: "fill_card"` and follow the
  [README payment guide](https://github.com/Trusty-Squire/trusty-squire#one-prompt)
  for amount precedence. That one approval releases and fills the card,
  charging nothing yet. Trusty Squire's part is then done: drive the checkout
  to the order-confirmation step, VERIFY the live final total there matches
  the approved `amount_cents`/currency yourself, and place the order via
  `operate_act`, handling any 3-D Secure challenge directly. Prefer `click` or
  `js_click` on the observed pay/place-order control: exactly one recognized
  control click may dispatch for that approval, and a repeat is refused until a
  fresh `operate_pay` approval in a new session. Do not use an ungated key press
  or `oauth_click` to bypass that refusal. A dispatched recognized click records
  a metadata-only attempt event; it does not prove the merchant charged the card.
  Call `operate_pay` with `phase: "confirm"` any time after the fill
  to close out the approval and release the session's pending-fill lock — it
  does not need to happen before you place the order, and it never
  reads a total, verifies an amount, or submits anything itself. `item` and
  `reason` remain required on both calls. If the payment gets stuck or the
  card is declined, recover with `operate_finish` and start a fresh session —
  `operate_pay` does not support refilling a different card mid-session. An
  unrecognized payment iframe is a hard stop.
- Always call `operate_finish` when done, including when a payment remains unresolved.
  The authoritative teardown contract is in the
  [README tool guide](https://github.com/Trusty-Squire/trusty-squire#mcp-tools).

**Safety rules the agent must follow:**

- The vault is **write-only**. Never try to read a secret back to plaintext, and
  never echo a captured key into chat, code, or `.env`. To use a key, call
  `use_credential` or mint an egress grant — the value goes to the provider, not
  to you.
- **Stop for the user** at phone verification, a hard image CAPTCHA, an
  unsupported payment, 3-D Secure, or any decision that belongs to a person.
  `operate_pay` may proceed only after its explicit phone approval succeeds. Do
  use `operate_act` for split-checkout navigation and order placement after a
  successful card fill as described above; do not guess or claim a signup
  finished when it did not.
- Card controls marked `interaction: "vaulted_card_only"` must be handled with
  their recommended `operate_pay { phase: "fill_card" }` action. Never type a
  PAN or Luhn-valid card number through `operate_act`; a refusal points back to
  `operate_pay`. Follow the
  [README payment guide](https://github.com/Trusty-Squire/trusty-squire#one-prompt)
  for checkout-amount precedence and split-checkout handling.
- The user connects Google/GitHub themselves in the real browser during
  `connect`. Never ask for or type the user's password in chat.

Repo and docs: <https://github.com/Trusty-Squire/trusty-squire> ·
Security model: `SECURITY.md` in that repo.
