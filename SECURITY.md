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

### The core invariant: secrets do not enter the model context on the agent's own authority

Agents can store credentials and request their *controlled use*, but no agent
action reads a plaintext secret back. This holds **even for a credential the
agent just helped create** — a successful signup does not make the resulting API
key visible to the model. The vault returns metadata, field names, masked values,
and references; never the raw value.

**The one exception is `fetch_credential`, and a human opens it, not the agent.**
Some tasks genuinely require the raw key to land somewhere the agent controls (a
GitHub Actions secret, a `.env`, a config file) with no server-side injection
path. `fetch_credential` mints an approval and returns a link; the raw value is
released only after the user signs that exact approval with their passkey — the
same Vouchflow ceremony that gates credential mutations and payments, under its
own `vault_credential_fetch` context so a mutation or payment mandate can never
authorize a reveal. The approval is bound to one (account, credential, field),
delivery is single-use, and expiry or denial releases nothing. The human who
answers it is the credential's OWNER: the ceremony, approve, and deny endpoints
require that account's signed-in web session, so the approval link reaching
anybody else — starting with the agent that requested it — is not authority to
answer it. Every outcome — approved, delivered, denied, expired, attempted by a
non-owner, or failed after the approval was spent — is audited under
`purpose: "reveal"` with the credential reference, the approval id, and the
approving account, and never the value. Implementation:
[`apps/api/src/routes/credential-fetch.ts`](apps/api/src/routes/credential-fetch.ts).

The property this preserves is not "the model can never see a secret" — it is
"a secret reaches the model only when a human, holding the passkey, decides it
should, for one named credential, once."

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

Saved cards remain client-encrypted. The enrolled browser derives the card key
from the owner's passkey, while the API stores opaque ciphertext plus constrained
display metadata such as brand and last4. The Vault detail view can reveal the
PAN only through its owner-authenticated passkey ceremony and never renders the
CVV.

For the initial card release, `inject_card` creates or resumes the existing
single human approval whose signed terms include merchant, checkout URL, amount,
currency, item, reason, and card reference. The phone decrypts the selected card
locally and HPKE-seals it to the operator's ephemeral key. The operator verifies
the signed purchase release, opens the sealed card locally, and confirms the
exact delivered candidate. The API relays ciphertext and signed approval
material, not plaintext PAN or CVV.
Denial or expiry releases no card; a pending returned `approval_id` resumes only
that approval ceremony.

After release, `inject_card` registers the card-value output mask before its
first write and fills only caller-named field refs. It returns field-level browser
outcomes and never searches for provider fields, chooses a saved-card control,
submits, clears fields, rereads or validates a total, or interprets a payment
outcome. Same-origin and reachable cross-origin hosted fields use the same
frame-targeted write. The agent owns subsequent observation, retries, currency
choice, place-order click, waits, and 3-D Secure interaction through generic
browser tools. No post-submit payment custody or second authorization path exists.

The released-card mask is deliberately narrow and session-persistent. It replaces
the complete released PAN and ordinary prefixes of at least eight digits,
including whitespace, common hyphen, period, and middle-dot formatting, and the
released CVV/CVC/CID in value-bearing DOM and AX properties, ordinary copies in
attributes/text/URLs/headers/bodies/errors, console and network evidence, and
returned diagnostics. Screenshot compositing covers the value-bearing pixels of
injected controls and identified ordinary displayed copies; it does not clear
merchant fields. The injection step adds a `data-ts-card-mask` provenance
attribute to named PAN/CVV nodes, while capture itself does not focus or change
their values. Last4, brand/issuer, cardholder name, expiry, billing address,
amount, currency, DCC text, OTP/3DS controls, HTTP errors, API keys, cookies, PII,
and unrelated short numbers remain visible. The mask records released values and
injected node identities across rerenders and navigation and never gates an
action.

The normal read surface is the masked snapshot; raw browser evaluation is
operator-internal. This boundary is designed for ordinary forms and reachable
hosted-field checkouts; provider-specific behavior is confirmed by field results
and fresh observations. It is not a general secret scanner and does not claim
containment against a hostile page that transforms, splits, encodes, or
canvas-renders the card.

Payment audit and approval lifecycle records remain metadata-only and never
contain PAN, CVV, sealed-card ciphertext, or signed candidate bodies.

### Trust boundaries

- The **user** may paste or create a secret.
- The **MCP server** may store a secret and use it through controlled tools.
- The **agent** may see credential metadata, field names, masked values, and
  vault references. It **cannot read plaintext values** from the vault on its
  own authority; the sole raw-value path, `fetch_credential`, requires a
  passkey-signed approval per fetch (see the core invariant above).
- **Sealed slots** let browser automation type a secret (e.g. a password) into
  the main document or a child frame on that page's own registrable domain
  without the agent ever reading the slot's contents. A raw slot value is
  refused for every cross-domain or opaque frame, even when that frame's host is
  otherwise allowed for navigation or OAuth.
- **Egress grants** inject a secret into an outbound provider request only for
  allowed hosts and configured auth shapes.
- **Audit logs** record operations and metadata, not secret values.
- For client-encrypted cards, the trusted client alone evaluates the passkey PRF
  and decrypts the blob; the API stores opaque ciphertext it cannot decrypt,
  plus the constrained `brand` and `last4` display metadata.
- During payment, the phone releases card data only to the ephemeral local
  operator key under the exact purchase binding. The API never sees plaintext
  PAN or CVV. Before the operator writes the card, it installs the narrow
  session output mask used by every normal model-facing read. The agent names
  the exact same-origin or reachable cross-origin field refs to fill and drives
  the remaining checkout itself.

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
- A context-backed login and an explicitly confirmed, non-payment operator result
  may save a private (`0600`) Playwright storage-state snapshot containing all
  cookies, local storage, and IndexedDB in the canonical profile namespace. Each
  operator session restores that sensitive auth material into a fresh private
  profile instead of opening the canonical profile. Plain-Chrome login, failed or
  unconfirmed results, and payment-sensitive sessions preserve the prior snapshot.
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
