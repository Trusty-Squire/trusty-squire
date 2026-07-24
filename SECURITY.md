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

### Encryption at rest: server-managed credentials

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

### Client-encrypted card data

Card data uses a separate end-to-end encrypted path
(`packages/vault/src/e2e.ts`). The client derives an AES-256-GCM key from a
passkey through the WebAuthn PRF extension with a fresh 32-byte salt, then
encrypts with a fresh 12-byte IV and a 128-bit authentication tag. The PRF
output and derived key remain on the client; the API receives and stores only
the serialized encrypted blob and therefore cannot decrypt or inspect the card.

The account-scoped API can return that opaque blob to an authenticated web or
agent session so a trusted client can decrypt it. List responses expose only
the record ID, label, and creation time. Losing the enrolled passkey makes the
card unrecoverable; server master-key rotation does not affect these blobs.

Before card entry or payment approval, the browser requires a one-time Vouchflow
passkey enrollment and confirms that the platform authenticator supports the
WebAuthn PRF extension. A payment approval is short-lived and account-scoped.
The phone signs a canonical purchase payload that binds the merchant, checkout
origin, amount, currency, nonce, card reference, and the SHA-256 hash of the
operator's ephemeral public key.

The phone decrypts the saved card locally, then HPKE-seals it directly to that
ephemeral X25519 key using HKDF-SHA256 and AES-256-GCM. The signed payload hash
is also the HPKE associated data, so the release envelope cannot be moved to a
different purchase or operator. The API relays only the signed mandate and
sealed card.

The MCP operator fetches Vouchflow's JWKS and fails closed unless signature,
issuer, audience, purchase context, high-or-better confidence, and payload hash
all verify. Only then does that local operator process open the envelope and
fill the checkout. Plaintext card fields are not returned through MCP to the
coding-agent model, sent to the Trusty Squire API, logged, or stored in payment
audit events. Issuer 3-D Secure is handed back to the user rather than
automated.

Payment audit events are deliberately metadata-only: merchant, amount,
currency, card last four digits, status, and an optional mandate ID. The API
validates `last4` as exactly four digits; the audit schema has no PAN or CVV
fields, and stored events never include them. Payment audit events use the vault
audit retention window, which defaults to 365 days.

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
- For client-encrypted cards, the trusted client alone evaluates the passkey PRF
  and decrypts the blob; the API stores opaque ciphertext it cannot decrypt.
- During payment, the phone releases card data only to the ephemeral local
  operator key after signing the purchase; the API and coding-agent model see
  no plaintext card fields.

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
