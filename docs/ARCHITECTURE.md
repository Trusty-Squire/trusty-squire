# Trusty Squire Architecture

Trusty Squire signs up and signs in to websites for developers working through
AI coding agents. A user asks their agent to create an account, finish setup
behind a login, or connect a service to an app. Trusty Squire drives the browser
and provider APIs, stores generated credentials in a write-only vault, and lets
code use them through scoped grants without exposing raw secret values to the
agent.

This document is the canonical project overview. If another document disagrees
with it, this document wins.

## Product Model

Trusty Squire has three jobs:

1. Acquire credentials: sign up for services, complete onboarding, extract API
   keys, and learn repeatable service-specific flows.
2. Store credentials: encrypt secrets in a vault that agents can write to but
   cannot read from, including opaque card blobs encrypted by a trusted client.
3. Use credentials safely: inject secrets server-side for allowed calls or type
   sealed values inside a live browser session without returning them to chat.

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
by the enrolled passkey's WebAuthn PRF. The API stores and returns only the
opaque ciphertext and records metadata-only payment audit events. The
cryptographic and data-handling contract is owned by
[`SECURITY.md`](../SECURITY.md#client-encrypted-card-data).

**Operate session**

A live browser session held by the MCP server. The host agent observes pages and
chooses actions, while the MCP process owns the browser, sealed secret slots,
captcha handling, and extraction.

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
  inbox/        Inbound email parsing and verification-code helpers.
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
- Browser automation can type sealed slot values into allowed login hosts.
- Egress grants can inject secrets into provider calls only for allowed hosts
  and configured auth shapes.
- Audit logs record operations and metadata, not secret values.
- Client-encrypted card WebAuthn PRF outputs and derived keys remain outside the
  API; the server stores only opaque ciphertext.

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

The same captures must produce byte-identical skills. Promotion must not depend
on clocks, random numbers, or plaintext credentials.

## Captcha And Walls

The browser layer supports several captcha classes, including visible
reCAPTCHA, invisible reCAPTCHA, hCaptcha, and Turnstile. Solver use is gated by
configuration and treated as a bounded fallback, not as proof that an account
was created.

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
- `docs/ARCHITECTURE.md`: canonical system overview and security model.
- `docs/VAULT-OPERATIONS.md`: vault operator runbook.
- `docs/DEPLOY-registry.md`: registry deployment notes.
- `docs/BUSINESS-MODEL.md`: pricing and positioning model.

Design memos, spike notes, stale implementation plans, and E2E scratchpads
belong in git history or private planning material, not in the public launch
docs tree.

## Status

Trusty Squire is still a beta product. The architectural invariants above are
the stable contract. Individual service skills, provider flows, captcha behavior,
and admin telemetry will continue to change as the system learns more services
and the verifier demotes stale flows.
