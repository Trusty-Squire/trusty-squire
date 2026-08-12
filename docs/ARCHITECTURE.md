# Trusty Squire Architecture

Trusty Squire signs up and signs in to websites for developers working through
AI coding agents. A user asks their agent to create an account, finish setup
behind a login, or connect a service to an app. Trusty Squire drives the browser
and provider APIs, stores generated credentials in a write-only vault, and lets
code use them through scoped grants without exposing raw secret values to the
agent.

This document is the canonical project overview and data-flow map.
[`SECURITY.md`](../SECURITY.md) owns security and cryptographic contracts.

## Product Model

Trusty Squire has three jobs:

1. Acquire credentials: sign up for services, complete onboarding, extract API
   keys, and learn repeatable service-specific flows.
2. Store credentials: encrypt secrets in a vault that agents can write to but
   cannot read from, including opaque card blobs encrypted by a trusted client.
3. Use credentials safely: inject secrets server-side for allowed calls or type
   sealed values inside a live browser session without returning them to chat,
   including user-approved card payments.

The main user is a developer working through an AI coding agent. The developer
wants infrastructure credentials and SaaS setup completed without copying keys
through prompts, `.env` files, screenshots, or browser tabs.

## Core Concepts

**Credential**

A secret stored in the vault. It can be a single API key, a multi-field
credential such as an OAuth client ID and secret, or a username/password login.

**Write-only vault**

Agents may store credentials and request controlled use of credentials, but they
cannot retrieve plaintext secret values. The vault records metadata and audit
events, never exposing raw values back to the agent.

**Client-encrypted card**

A card record encrypted and decrypted by a trusted client with a key produced
by the enrolled passkey's WebAuthn PRF. The API stores the protected payload,
serves constrained display metadata, and records metadata-only payment audit
events. The precise cryptographic and server-visible data contract is owned by
[`SECURITY.md`](../SECURITY.md#client-encrypted-card-data).

**Operate session**

A live browser session held by the MCP server. The host agent observes pages and
chooses actions, while the MCP process owns the browser, sealed secret slots,
captcha handling, and extraction.

**Payment approval**

A short-lived handoff from an active operate session to the user's phone. The
phone can add and bind a card when needed. The anonymous approval shell displays
the exact server-recorded purchase details for an amount-bound approval. One
payment-context passkey authorization signs that approval. The API relays the
signed mandate and operator-sealed card through an account-scoped, short-TTL
database record and mutates approval state only after operator verification. The
security contract is owned by
[`SECURITY.md`](../SECURITY.md#client-encrypted-card-data).

**Sealed slot**

A temporary in-session reference to a secret value. The agent can say "type slot
`password` into this field" but cannot read the slot contents.

**Egress grant**

A scoped, revocable token that lets a local or deployed app call a provider
through Trusty Squire. The proxy injects the real credential server-side after
checking host, route, and policy.

**Skill**

A signed, replayable recipe learned from a successful provisioning flow. Skills
let future provisions of the same service skip exploratory browser work.

**Registry**

The service that stores signed skills, verifier state, provisioning telemetry,
and the operator admin surface.

**Housekeeper and verifier**

Background systems that discover services, replay skills, verify that learned
flows still work, demote stale skills, and promote new or changed skills only
after successful replay.

## Repository Layout

```text
apps/
  api/        Accounts, OAuth, machine tokens, vault API, LLM proxy,
              inbox helpers, egress grants, and billing hooks.
  mcp/        The local MCP server installed by coding agents. It owns the
              browser automation surface, provisioning loop, vault tool calls,
              captcha handling, and skill promotion.
  registry/   Signed skill registry, verifier backplane, provisioning telemetry,
              harvest queues, and read-only admin dashboard.
  web/        Public site and vault UI.

packages/
  vault/        Encrypted credential storage primitives.
  skill-schema/ Shared Zod schemas for signed skills, replay steps, and failure
                taxonomy.
```

## Trust Boundaries

Trusty Squire is designed around a narrow rule: a model should not receive raw
secrets.

The important boundaries are:

- The user can paste or create a secret.
- The MCP server can store a secret and can use it through controlled tools.
- The agent can see credential metadata, field names, masked values, and vault
  references.
- The agent cannot read plaintext values back from the vault.
- Browser automation obeys the sealed-slot target-origin boundary defined in
  [`SECURITY.md`](../SECURITY.md#trust-boundaries).
- Egress grants can inject secrets into provider calls only for allowed hosts
  and configured auth shapes.
- Audit logs record operations and metadata, not secret values.
- Client-encrypted card WebAuthn PRF outputs and derived keys remain outside the
  API; [`SECURITY.md`](../SECURITY.md#client-encrypted-card-data) owns the
  server-visible card-data boundary.
- The Vault browser can reveal a PAN only after its passkey ceremony and
  discards the CVV before UI state or rendering. During payment, plaintext card
  data exists only in the approving browser and local operator process, never
  in the API or coding-agent model.

This boundary applies even when the agent helped create the credential. A
successful signup does not make the resulting API key visible to the model.

## Provisioning Flow

A typical user-owned provisioning flow looks like this:

```text
user asks agent
  -> agent calls Trusty Squire MCP tools
  -> MCP starts an operate session
  -> session prepares sealed login/password slots if needed
  -> browser signs up or signs in with the user's identity
  -> captcha and verification gates are handled or surfaced
  -> API key or credential fields are extracted
  -> credential is stored in the vault
  -> successful flow is captured for possible skill promotion
```

The agent drives the high-level plan, but the sensitive operations stay inside
the MCP process and vault service. Raw login values, API keys, captcha tokens,
and transferred secrets are not returned to the agent.

## Payment Flow

```text
cart and checkout observations expose a best-effort checkout_state overlay with one next action
  -> operate_cart_add reserves product+variant identity and an idempotency key,
     post-verifies the exact line, and suppresses duplicate retry clicks
  -> checkout_state is informational only; it is never a charge input
  -> observed card controls direct the agent to operate_pay, while model-supplied
     PAN-shaped entry remains refused until operate_pay independently verifies the total
agent starts operate_pay in the active checkout
  -> agent supplies a non-empty item and reason
  -> a single-page checkout reads merchant, origin, and payable total from the
     live page; an unreadable amount stops before approval with
     payment_checkout_total_not_found
  -> every session observation best-effort captures the most recent real checkout
     total, replacing the prior value after a successful read and preserving it
     when a later page has no total; the value remains scoped to its page origin
  -> split fill_card first reads the live card-entry total; only when none is
     readable may it use that same session's captured total after re-checking the
     current origin. Caller-supplied amounts never provide this fallback
  -> PayPal Smart Button or hosted-field frames hand initial/fill checkout calls to
     the user before saved-card resolution or approval creation
  -> an explicit card is used; otherwise one saved card is selected automatically,
     no saved cards starts add-card, and multiple cards require a user choice
  -> operator creates an ephemeral key; API creates a short-lived approval relay
     and attaches the requesting MCP host's initialize clientInfo.name
  -> if the approval has no card, the user adds one and the API binds that saved
     card to the still-pending approval
  -> the anonymous approval shell displays merchant, checkout origin, item, reason,
     requesting agent, amount, and currency from the short-lived server record
  -> the user reviews that intent and one passkey ceremony signs the canonical
     payload, unlocks the card, and seals it to the ephemeral operator
  -> the API stages that opaque candidate in an account-scoped Postgres relay with
     a 15-second TTL so another API worker can deliver it to the waiting operator
  -> the operator verifies the final JWS, opens the card, and confirms the exact
     candidate fingerprint; successful confirmation clears the JWS and ciphertext
  -> single-page add-card re-reads every signed checkout field, then fills and
     submits only if merchant, origin, amount, and currency still match
  -> split fill_card requires the current origin to match its amount-bound mandate
     and fills without submitting; only the main frame,
     same-registrable-domain HTTPS frames, and curated HTTPS payment-provider frames
     can receive card data
  -> the raw card is zeroed; sealed, observation-masked page fields remain, while
     session state retains only approval/mandate and card-reference metadata
  -> operate_act blocks charge-labeled clicks and Enter while that state is pending;
     ordinary navigation can advance the checkout to its review step
  -> split confirm bypasses the initial PayPal-frame gate and strictly resolves the
     final payable total from the main frame and visible trusted payment frames with
     no caller fallback; origin must match the mandate (the page-title-derived
     merchant name may change)
  -> confirm charges under the fill-time approval, without another passkey tap, when
     currency matches and the final total is at or below the approved amount; a
     higher total fails closed with payment_amount_exceeds_approval and is never
     re-approved. Unresolved or conflicting totals also fail closed without charging
  -> the active session serializes payment entry and confirmation; retry state is
     restored only before submission starts, and unverified field cleanup seals the
     session against later payment operations (the contract lives in SECURITY.md)
  -> a missing submit control retains the pending fill for retry; terminal payment
     outcomes clear it
  -> when 3-D Secure is required, the API nudges a linked Telegram chat and
     the operator waits for success or failure when waiting is enabled
  -> timeout, or a disabled wait, hands the unresolved challenge to the user
  -> the post-wait metadata-only payment status is audited
```

The detailed cryptographic checks and card-data boundary live in
[`SECURITY.md`](../SECURITY.md#client-encrypted-card-data); the API route
reference lives in [`apps/api/README.md`](../apps/api/README.md#endpoints).

## Skill Lifecycle

When a successful provisioning flow is not already covered by an active skill,
Trusty Squire can promote the captured flow:

```text
capture -> synthesize -> sign -> publish -> verify -> active
```

- Capture records post-verify state and planner actions with secrets redacted.
- Synthesis converts captures into deterministic skill steps.
- Signing produces an Ed25519 signature over canonical skill bytes.
- Publishing sends the signed skill to the registry.
- Verification replays the flow before it becomes active.
- Active skills serve future provisions faster and with less exploration.

DOM-target actions are promotable into registry Skills only when they are
main-frame and inventory-backed; modeled navigation retains its existing domain
lock. A session can still complete by using `operate_act` with a live `text=…`
or `css=…` locator when a visible control has no observed ref, but an
off-inventory action cannot be synthesized into a portable step. Such a session
is skipped by auto-promotion and cannot be saved as an operator recipe.
Inventory-backed frame actions can be saved in an operator recipe with their
exact frame origin and nested path, but auto-promotion rejects them until Skill
replay has a guarded frame consumer.

The same captures must produce byte-identical skills. Promotion must not depend
on clocks, random numbers, or plaintext credentials.

## Captcha And Walls

The browser layer supports several captcha classes, including visible
reCAPTCHA, invisible reCAPTCHA, hCaptcha, and Turnstile. Solver use is gated by
configuration and treated as a bounded fallback, not as proof that an account
was created. Their challenge-frame internals are excluded from the ordinary
element inventory and remain owned by this dedicated captcha flow.

The provisioning loop distinguishes:

- captcha gate solved
- signup submitted
- email or account verification completed
- credential extracted and vaulted

Those are separate milestones. A solved captcha does not imply a successful
provision.

When the system hits a wall it cannot responsibly complete, it should return a
clear handoff state rather than pretending the service is provisioned.

## Egress Grants

Egress grants let apps use vaulted credentials without receiving the raw
credential. A grant has policy around:

- service and credential reference
- allowed target hosts
- auth shape, such as bearer, header, or query parameter
- rate limits and revocation
- audit logging

The app calls Trusty Squire with the grant. Trusty Squire checks policy,
injects the real secret into the upstream request, and returns only the provider
response.

## Registry And Admin Backplane

The registry stores:

- signed skills and their status
- verifier queue and verification outcomes
- provisioning events and recent failures
- demand and cache-hit telemetry
- extract-failure snapshots for debugging
- operator admin dashboard data

The admin dashboard is read-only. Its job is to answer four questions:

1. Is the system alive?
2. Are users getting credentials?
3. Which services need attention?
4. What just broke?

Historical objective-function dashboards and design-planning panels are not
canonical product surfaces.

## Current Public Docs

The public docs set is intentionally small:

- `README.md`: product pitch, install, and development entry point.
- `SECURITY.md`: canonical security and cryptographic contracts.
- `docs/ARCHITECTURE.md`: canonical system overview and data flows.
- `docs/VAULT-OPERATIONS.md`: vault operator runbook.
- `docs/DEPLOY-registry.md`: registry deployment notes.

Design memos, spike notes, stale implementation plans, and E2E scratchpads
belong in git history or private planning material, not in the public launch
docs tree.

## Status

Trusty Squire is still a beta product. The architectural invariants above are
the stable contract. Individual service skills, provider flows, captcha behavior,
and admin telemetry will continue to change as the system learns more services
and the verifier demotes stale flows.
