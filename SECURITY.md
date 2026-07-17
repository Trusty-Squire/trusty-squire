# Security

Trusty Squire is built to be handed credentials by an AI coding agent, so its
whole design is organized around one rule: **a model must not receive a raw
secret.** This document describes how that rule is enforced, what is and is not
protected, and how to report a vulnerability.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** — do not open a public
issue for a security bug.

- **Preferred:** open a private report via GitHub → the repository's **Security**
  tab → **Report a vulnerability** (GitHub private vulnerability reporting).
- **Alternative:** email **security@trustysquire.ai**.

Please include a description, affected component, and enough detail to reproduce.
We aim to acknowledge a report within a few business days and to keep you updated
as we investigate and fix. We will credit reporters who want credit once a fix
ships. Please give us reasonable time to remediate before any public disclosure.

Good-faith security research that respects user privacy, avoids data destruction,
and does not degrade the service for others is welcome.

## Security model

### The core invariant: secrets never enter the model context

Agents can store credentials and request their *controlled use*, but they cannot
read plaintext secret values back. This holds **even for a credential the agent
just helped create** — a successful signup does not make the resulting API key
visible to the model. The vault returns metadata, field names, masked values, and
references; never the raw value.

### Encryption at rest

Credentials are protected with **AES-256-GCM envelope encryption**
(`packages/vault/src/encryption.ts`):

```
master key (LocalKMS)  ──wraps──▶  per-credential KEK
        KEK            ──wraps──▶  DEK
        DEK          ──encrypts──▶ ciphertext = AES-256-GCM(credential fields)
```

- The master key is the only thing that ever touches the per-credential key; it
  never directly encrypts field values.
- GCM is authenticated: additional data is bound into the auth tag, so a wrong
  key or tampered ciphertext fails to decrypt rather than returning garbage.
- Field values are only ever decrypted transiently in memory at the point of use,
  never returned to the agent.
- The master key is rotatable with zero downtime (legacy keys are accepted during
  a rotation window and every wrapped key is re-wrapped onto the new master key).
  See [`docs/VAULT-OPERATIONS.md`](docs/VAULT-OPERATIONS.md).

### Trust boundaries

- The **user** may paste or create a secret.
- The **MCP server** may store a secret and use it through controlled tools.
- The **agent** may see credential metadata, field names, masked values, and
  vault references — but **cannot read plaintext values** from the vault.
- **Sealed slots** let browser automation type a secret (e.g. a password) into an
  allowed login host without the agent ever reading the slot's contents.
- **Egress grants** inject a secret into an outbound provider request only for
  allowed hosts and configured auth shapes.
- **Audit logs** record operations and metadata, not secret values.

### Using a credential without exposing the key: egress grants

A deployed or local app can call a provider through Trusty Squire without ever
holding the provider key. A grant is scoped by service/credential reference,
allowed target hosts, auth shape (bearer / header / query), rate limit, and
revocation, and every use is audited. Trusty Squire validates the grant, injects
the real secret **server-side**, and returns only the provider's response. A
leaked grant token is revoked instantly **without rotating the provider key**.

The one-time grant token *can* enter agent context — it is a scoped, revocable
capability, **not** the provider key. For flows where even that exposure is
unwanted, `use_credential` performs agent-initiated calls with no token handed
back at all.

### Identity and browser automation

- OAuth sign-in (Google / GitHub) happens in the **user's own real browser
  session** that they explicitly connect. Trusty Squire does not ask the agent to
  type those passwords.
- Learned automation ("skills") are **Ed25519-signed** replayable recipes.
  Captures used to synthesize them record post-verify state with **secrets
  redacted**, and skill promotion is deterministic — it must not depend on clocks,
  random numbers, or plaintext credentials.

### Honest limits (it will stop for a human)

Trusty Squire does **not** bypass phone verification, hard CAPTCHAs, payment
authorization, or decisions that belong to a person. When it hits a wall it cannot
responsibly clear, it returns a clear handoff state rather than pretending an
account was provisioned. A solved captcha is never treated as proof of a
successful signup.

### Handling of diagnostics

Browser screenshots and diagnostic artifacts can contain whatever a page visibly
rendered. Treat them as sensitive: do not ask an agent to re-observe a page after
a secret has been shown on screen.

## Scope and status

This document describes the **intended security model** and is a **self-assessment
by the maintainers** — Trusty Squire is in beta and has **not yet undergone an
independent third-party security audit**. We are documenting the model in the open
precisely so it can be reviewed and challenged.

For the full system boundaries and data flow, see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
[`docs/VAULT-OPERATIONS.md`](docs/VAULT-OPERATIONS.md).
