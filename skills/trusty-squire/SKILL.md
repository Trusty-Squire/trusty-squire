---
name: trusty-squire
description: >-
  Use when a coding agent needs to sign up for a website or SaaS, finish setup
  behind a login, or obtain an API key — and the secret must NOT land in chat,
  source code, or a .env file. Trusty Squire is an MCP server that drives a real
  browser through signup, sign-in, email verification, and bot gates, then vaults
  the captured key write-only. Triggers: "sign me up for X", "get an API key for
  X", "create an account on X", "set up X and save the key", "provision X",
  "let my app call X without the key", "pay this checkout with my saved card",
  "AI agent API key management".
license: MIT
metadata:
  homepage: https://trustysquire.ai
  repository: https://github.com/Trusty-Squire/trusty-squire
  npm: "@trusty-squire/mcp"
---

# Trusty Squire

Trusty Squire is an MCP server your coding agent drives. It signs up for
websites, completes provider setup behind a login, and captures the resulting
API key into an encrypted, **write-only** vault — so the raw secret never enters
your chat, your code, or a `.env` file. This skill is the discoverable wrapper;
the MCP server supplies the actual capabilities.

## 1. When Trusty Squire is appropriate

Use it when the task requires **creating a real account or getting an API key**,
especially when the secret must stay out of the conversation, the repo, and
`.env`. Concretely:

- "Sign me up for Resend / Clerk / <service> and save the API key."
- "Set up <provider>, create a project, generate the key, and wire it in."
- "Get an API key for <service> without showing it to me or putting it in `.env`."
- Finishing authenticated setup — OAuth apps, webhooks, project/region config.
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
  money fields as informational only; `operate_pay` independently verifies the
  charge total.
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
  requests phone approval for the exact purchase, fills the checkout, nudges
  the user's linked Telegram chat when configured and 3-D Secure is required,
  and waits for them to resolve it before handing back an unresolved challenge.
  If add-card returns `needs_user.wall: "card_required"`, re-run for a fresh
  link; if `payment_approval_timeout` includes `card_persisted: true`, the added
  card remains available for the retry. Set `three_ds_wait_seconds` to `0` only
  when the user wants the immediate handoff without notification or waiting.
  Card fields never return through MCP.
- Every payment response includes a `session_id`. Pass that same ID to every
  follow-up `operate_pay` and canonical `operate_payment_status` call. Follow the
  [README payment guide](https://github.com/Trusty-Squire/trusty-squire#one-prompt)
  for polling arguments and the `operate_payment_await` compatibility alias.
  Omit `session_id` only when this MCP process has exactly one live session; the
  compatibility path never guesses the newest checkout.
- Treat `payment_outcome_unknown` as unconfirmed: do not claim success or
  submit again blindly. The card may already have been charged — manually
  check the merchant's order state before any retry.
- On a split checkout whose card-entry step shows no total (or only a subtotal),
  call `operate_pay` with `phase: "fill_card"`. It approves the live card-entry
  total when readable; a subtotal qualifies only when the same order summary says
  shipping is free, and recommendation prices never qualify. Otherwise it may use
  the most recent real total observed in this session on the same origin. That one
  approval releases and fills the card,
  charging nothing yet, and authorizes the eventual charge up to the approved
  amount. Advance only through non-charge navigation such as **Next** or
  **Continue to review**, then call `operate_pay` with `phase: "confirm"` once the
  final total is visible. Confirm reads that total and charges under the same
  approval when it is at or below the approved amount. It never asks for another
  approval: a higher total returns `payment_amount_exceeds_approval`, while an
  unresolved or conflicting total also fails closed. `item` and `reason` remain
  required on both calls. Never click a pay/place-order control or press Enter
  while the card fill is pending; confirm owns the strict amount check and charge.
  An unrecognized payment iframe is a hard stop.
- Do not call `operate_finish` while a payment is in progress, awaiting approval,
  or filled and awaiting confirmation. Finish drains calls already using that
  session and refuses to close until its payment state is terminal.

**Safety rules the agent must follow:**

- The vault is **write-only**. Never try to read a secret back to plaintext, and
  never echo a captured key into chat, code, or `.env`. To use a key, call
  `use_credential` or mint an egress grant — the value goes to the provider, not
  to you.
- **Stop for the user** at phone verification, a hard image CAPTCHA, an
  unsupported payment, 3-D Secure, or any decision that belongs to a person.
  `operate_pay` may proceed only after its explicit phone approval succeeds. Do
  not bypass a pending split payment with `operate_act`, do not guess, and do not
  claim a signup finished when it did not.
- Card controls marked `interaction: "vaulted_card_only"` must be handled with
  their recommended `operate_pay { phase: "fill_card" }` action. Never type a
  PAN or Luhn-valid card number through `operate_act`; a refusal points back to
  `operate_pay` and requires a verified cart total.
- The user connects Google/GitHub themselves in the real browser during
  `connect`. Never ask for or type the user's password in chat.

Repo and docs: <https://github.com/Trusty-Squire/trusty-squire> ·
Security model: `SECURITY.md` in that repo.
