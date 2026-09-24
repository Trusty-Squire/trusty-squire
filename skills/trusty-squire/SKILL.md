---
name: trusty-squire
description: >-
  Use when a coding agent needs to sign up for a website or SaaS, provision an
  OAuth client or API key, pay a checkout, or otherwise act on a real website on
  the user's behalf — and the secret or card must NOT land in chat, source code,
  or a .env file. Trusty Squire is an MCP server that drives a real browser
  through signup, sign-in, provisioning, checkout, email verification, and bot
  gates, then vaults captured keys write-only and uses payment cards only through
  a user-approved vault flow. Triggers: "sign me up for X", "get an API key for
  X", "create an account on X", "set up X and save the key", "provision X",
  "work through publishing this app on X", "ship this app through X", "send X as
  a gift", "book X for me", "let my app call X without the key", "pay this
  checkout with my saved card", "AI agent API key management".
license: MIT
metadata:
  homepage: https://trustysquire.ai
  repository: https://github.com/Trusty-Squire/trusty-squire
  npm: "@trusty-squire/mcp"
---

# Trusty Squire

Trusty Squire is an MCP server your coding agent drives. It signs up for
websites, provisions setup behind a login, and pays checkouts. Resulting API
keys go into an encrypted, **write-only** vault, while payment cards are added
by the user and released only through an approved purchase flow — so neither a
raw secret nor card enters your chat, your code, or a `.env` file. This skill is
the discoverable wrapper; the MCP server supplies the actual capabilities.
Publishing, gifting, and booking are composed workflows driven by
`operate_drive` for the goal (signup, checkout, provision), with the
flat operator verbs — `operate_start`, `operate_observe`, `operate_click`,
`operate_type`, `operate_select`, `operate_navigate`, `inject_card`, and
`operate_finish` — as the fallback for a single step the drive handed back;
they are not separate one-shot tools.

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

- For a signup, checkout, or other goal-shaped website task, call
  `operate_drive` with the goal and a `facts` bag (email, name, address,
  `card_ref`, …). Pass `session_id` of an open `operate_start` session, or
  `url` to open the page and drive in one call. Resume the same session with
  `answer` (an option key from a handoff) and/or added `facts`. Do not plan
  each click and type yourself unless the drive handed a question back.
- `operate_start`, `operate_observe`, `operate_click`, `operate_type`,
  `operate_select`, `operate_press`, `operate_scroll`, and `operate_navigate`
  open the real website and drive a single step — the fallback after a drive
  handoff, or for a task that is not a goal. Use `operate_login` for
  OAuth and the username/password lifecycle. For browser host behavior and legacy
  parameter compatibility, see the
  [operator egress contract](https://github.com/Trusty-Squire/trusty-squire/blob/main/docs/operator-tool-surface.md#browser-egress-is-unrestricted).
- When a Compact V2 observation does not render the control you need, call
  `operate_observe` with `query`. The query searches the whole live document,
  including below the viewport, and returns actionable refs; use
  `more_above`/`more_below` with `operate_scroll` to change the viewport.
  Follow the [tool guide](https://github.com/Trusty-Squire/trusty-squire/blob/main/docs/reference.md#mcp-tools)
  instead of reading a V1 snapshot file.
- For shopping, add items through the observed cart UI with `operate_click` and
  re-observe the cart before continuing, or let `operate_drive` run the
  checkout goal with `facts.card_ref`. Follow the
  [payment guide](https://github.com/Trusty-Squire/trusty-squire/blob/main/docs/reference.md#direct-payment-observation)
  for `inject_card`.
- Email verification is page state: `operate_drive` reads the inbox itself when
  the goal needs a code or link. You can also call `operate_read_inbox` in a
  dedicated utility tab, then type the code or follow the link. Never navigate
  the waiting page to Gmail.
- `operate_extract` — capture a revealed API key/secret
  straight into the write-only vault (never back into the conversation).
- `list_credentials`, `use_credential` — find a stored credential and make an
  authenticated API call **without** the raw value returning to the agent; put
  `${SECRET}` (or `${SECRET.field}`) placeholders in the request and the server
  injects the real value at the boundary.
- `fetch_credential` is the sole raw-value exception, and it is not an agent
  shortcut. The first call returns an approval link and **no value**. Only after
  the user signs that exact fetch with their passkey may one resumed call using
  its `approval_id` return the value once. A payment or mutation approval cannot
  authorize it. Prefer `use_credential` or an app grant whenever server-side
  injection can complete the task.
- `grant_app_access`, `revoke_app_access` — mint or instantly revoke a scoped,
  rate-limited egress grant so a deployed app can call the provider while holding
  a revocable token, not the raw key.
- `audit_log` — review what touched a credential; never exposes secret values.
- `list_payment_cards`, `inject_card` — select a saved card by opaque
  `card_ref` (list first when several are saved). `inject_card` requests phone
  approval for the exact purchase and fills only the supplied pan/cvv refs.
  Expiry, cardholder name, and billing are ordinary `operate_type` /
  `operate_select` fills. Continue a pending release by re-calling
  `inject_card` with its `approval_id`. `operate_drive` calls this same path
  when the goal reaches the card step and `facts.card_ref` is present.
  Card fields never return through MCP.
- Treat `payment_outcome_unknown` as unconfirmed: do not claim success or
  submit again blindly. The card may already have been charged — manually
  check the merchant's order state before any retry.
- `inject_card` fills only pan/cvv. Drive expiry, name, billing, and the
  place-order click yourself (or via `operate_drive`). Re-observe before
  submit and confirm no competing saved-card control is selected. The operator
  detects a rendered 3-D Secure challenge and notifies the cardholder once;
  do not solve or wait on it — keep observing until the checkout resolves.
  If the payment gets stuck or the card is declined, recover with
  `operate_finish` and start a fresh session.
- Always call `operate_finish` when done, including when a payment remains
  unresolved. Use its flat `outcome` enum (`none`, `credentials`, or `result`),
  not a nested outcome object. A result’s agent-provided `data` reports what the
  agent saw; it does not establish authentication, provisioning, or mutation
  success. The current server advertises the common finish receipt (`session_id`,
  `operation_id`, `execution`, `mutation`, `cleanup`, `closed:boolean`) through
  `tools/list`. Only `closed:true` establishes closure. Older servers may omit
  this receipt; absence is never closure proof. The authoritative
  teardown contract is in the
  [tool guide](https://github.com/Trusty-Squire/trusty-squire/blob/main/docs/reference.md#mcp-tools).

**Safety rules the agent must follow:**

- The vault is **write-only**. Never try to read a secret back to plaintext, and
  never echo a captured key into chat, code, or `.env`. To use a key, call
  `use_credential` or mint an egress grant — the value goes to the provider, not
  to you.
- Page reads are not sealed: `operate_observe`, `operate_screenshot`, and
  `operate_extract` report rendered content according to their registered
  contracts. Do not add an ad hoc masking/refusal step. This does not weaken the
  vault boundary, payment approval, or 3-D Secure rules.
- **Stop for the user** at phone verification, a hard image CAPTCHA, an
  unsupported payment, 3-D Secure, or any decision that belongs to a person.
  `inject_card` may proceed only after its explicit phone approval succeeds.
  Do not guess or claim a signup finished when it did not.
- Compact V2 card controls carry the code-owned `f=payment` fact. Never type a
  PAN or Luhn-valid card number through `operate_type`; a refusal points back to
  `inject_card`. Follow the
  [payment guide](https://github.com/Trusty-Squire/trusty-squire/blob/main/docs/reference.md#direct-payment-observation)
  for checkout-amount precedence and split-checkout handling.
- The user connects Google/GitHub themselves in the real browser during
  `connect`. Never ask for or type the user's password in chat.

Repo and docs: <https://github.com/Trusty-Squire/trusty-squire> ·
Security model: `SECURITY.md` in that repo.
