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
output and derived key remain on the client. The API receives the serialized
encrypted blob plus optional constrained display metadata (`brand` and
`last4`), but cannot decrypt the blob or inspect the full card.

The account-scoped detail API can return that opaque blob to an authenticated
web or agent session so a trusted client can decrypt it. During a pending
payment, the unauthenticated ceremony endpoint can also return the bound blob to
the holder of the short-lived approval link. That capability-link response also
returns the exact server-recorded merchant, checkout origin, amount, currency,
nonce, item, reason, requesting-agent label, and expiry that the user must review
and authorize. It includes the approval ID and status, opaque card reference,
operator public key, purchase-payload digest, and encrypted blob, but omits card
display metadata and does not grant account navigation. List responses omit the
blob and expose only the record ID, label,
creation time, and optional plaintext card display metadata: a no-digit network
name (`brand`) and exactly four digits (`last4`). These fields cannot carry a
full PAN; legacy rows return `null`. Losing the enrolled passkey makes the card
unrecoverable; server master-key rotation does not affect these blobs.

The Vault detail view keeps the PAN masked until the user explicitly chooses
`reveal`, which retrieves the opaque blob and runs the passkey ceremony in the
browser. After client-side decryption, the view retains only the PAN, cardholder
name, expiry, and billing address in React state. It discards the CVV before
state is updated, so the CVV is never rendered, even for the card owner. The
detail API response is limited to the record ID, label, opaque blob, `brand`,
`last4`, and creation time; PAN and CVV cannot appear as separate response
fields.

Before card entry or payment approval, the browser requires a one-time Vouchflow
passkey enrollment and confirms that the platform authenticator supports the
WebAuthn PRF extension. A payment approval is short-lived and account-scoped.
The anonymous approval shell displays the canonical purchase values before an
amount-bound payment ceremony, including the amount used for a split checkout's
card-fill approval. One explicit **Approve payment** action then signs a payload
binding the merchant, checkout origin, amount, currency, single-use nonce, card
reference, operator-key hash, item description, purchase reason, and server-derived
requesting-agent label while deriving the card-decryption key. The API uses the
install's authenticated agent identity when present and otherwise signs
`unknown-agent`; the client cannot supply the label.

Just-in-time add-card approvals may be created without a card reference, while
still binding the operator's ephemeral public key at creation. The API permits
one card bind only while the approval is pending and unexpired, verifies that
the encrypted-card record belongs to the same account, and rejects approval
until a card is bound. This enforces the seal → bind → approve order on the
server rather than relying on client convention. On resume, the operator fails
closed unless the approval record contains a non-blank server-bound card
reference, and uses that reference when re-creating the signed purchase payload.
Immediately before filling and submitting a single-page just-in-time checkout,
it re-reads the live merchant, origin, amount, and currency and refuses submission
if any signed field changed.

A split checkout may collect card details before it exposes the final payable total.
On every observation, the session best-effort captures the most recent real checkout
total read from the current page, replacing the prior value only after a successful
read and scoping it to that page's origin. The `fill_card` phase prefers the live
card-entry page's own total. A subtotal is accepted as the payable amount only when
the same scoped order summary states that shipping is free; recommendation sections
are excluded before any amount is selected. Only when that page has no readable total
may it use the same session's captured value, after re-checking that the current origin
matches; a caller-supplied amount is never a fallback. The resulting single amount-bound
approval both releases the card and authorizes a later charge up to that amount.
After approval it requires the live page origin to equal the mandate's checkout
origin, fills no submit control, and permits card data only in the main frame,
same-registrable-domain HTTPS frames, or curated HTTPS payment-provider frames. A
failed or unrecognized-frame fill clears partial card data; if cleanup itself cannot
be confirmed, the session keeps the payment-field seal active. On success the raw
card is zeroed in the operator, while the page fields remain sealed and
observation-masked for the checkout's review step; session state retains only
approval and mandate metadata, the checkout binding, card reference, and last four
digits.

Unsupported-wallet detection follows the frame containing the actual visible PAN
field. PayPal and Braintree hosted card fields fail closed, while an unrelated PayPal
express-button frame does not disqualify a fillable merchant or recognized Shopify
PCI card-field frame. When a checkout mounts multiple card forms, the operator fills
one complete visible and enabled group containing PAN, name, expiry, and CVV. When
multiple groups are complete, it uses the PAN's rendered center-point hit-test and
selects only the unique topmost, non-occluded group; otherwise it fails with
`payment_card_form_ambiguous`. Card filling stays inside that selected group. Charge
controls inside a card group are
eligible only for the selected group in both same-step and later confirmation,
and both card fields and charge controls follow their HTML `form` relationship when
mounted elsewhere in the DOM; a merchant checkout control outside every card group
remains eligible.

The later `confirm` phase is the charge boundary. Its strict reader requires a final
payable total from the main frame or a visible trusted payment frame, with no
caller-supplied amount fallback; unresolved or conflicting totals fail closed.
Checkout origin and currency must match the mandate. A final total at or below the
approved amount is submitted under the same signed approval, without a second human
tap. A higher total fails closed with `payment_amount_exceeds_approval`; there is no
reapproval path. The page-title-derived merchant display name is not compared across
steps; origin is the recipient trust anchor. While a split card fill is pending,
ordinary browser actions cannot click charge-labeled controls or press Enter, so only
`confirm` can cross that boundary. If no submit control is found, the sealed page
fields and pending metadata remain
available for a safe retry; they are cleared after a terminal outcome when cleanup
can be confirmed. Every payment entry is claimed before asynchronous work begins,
and a pending confirmation is claimed atomically, so overlapping `operate_pay` calls
cannot race toward the same submission. A failed confirmation becomes retryable only
if submission has not started. If field cleanup cannot be confirmed, pending metadata
is discarded, the observation seal remains active, and the session refuses further
payment operations.

The phone decrypts the saved card locally, then HPKE-seals it directly to that
ephemeral X25519 key using HKDF-SHA256 and AES-256-GCM. Each signed payload hash
is the HPKE associated data, so the envelope cannot be moved to a different
approval, card, purchase, or operator. The API temporarily stages only the JWS,
operator-sealed ciphertext, SHA-256 candidate fingerprint, phase, and expiry in
the account-owned approval row. The 15-second relay survives API-worker changes;
only an authenticated agent for the same account can receive or confirm it.
After the operator verifies the mandate issuer, audience, canonical payload, and
envelope, final confirmation must match the delivered fingerprint, atomically
marks the approval approved, and clears all persisted JWS and ciphertext bytes.
Repeating confirmation for that same fingerprint is safe during the relay TTL,
while a different, expired, wrong-account, or undelivered candidate fails closed.

Review-format candidates already staged by a legacy deployment remain accepted
only for compatibility; new review-bound API submissions fail with
`stale_payment_client`. A review seal is never final approval: operator
confirmation clears its JWS and ciphertext but leaves the approval pending for a
separately verified canonical purchase candidate. Review verification failures
are bounded and returned to the caller; only transient JWKS fetch failures or
timeouts may retry. Lifecycle logs contain candidate kind and transition outcome
alongside identifiers, account hashes, candidate fingerprints, machine/release
metadata, and failure codes, never card plaintext, JWS values, or sealed-card
values.

The MCP operator fetches Vouchflow's JWKS and fails closed unless signature,
issuer, audience, purchase context, payload hash, and user presence all verify.
It confirms the exact verified submission before retaining the card to fill the
checkout. Browser passkeys are capped at low confidence in Vouchflow regardless
of biometric, so mandate assurance rests on user presence, the single-use nonce,
and amount, recipient, origin, and item binding rather than a high confidence
tier. Plaintext PAN and CVV are not returned through MCP to the coding-agent
model, sent to the Trusty Squire API, logged, or stored in payment audit events.
Issuer 3-D Secure is handed back to the user rather than automated; the operator
may wait for the user to resolve the challenge, but it never completes the
challenge itself.

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
  operator key under the exact purchase binding. The API and coding-agent model
  never see plaintext PAN or CVV. Split-checkout card fields may remain sealed in
  the live page between fill and confirmation, but observations mask their values
  and arbitrary cross-origin frames cannot receive them.

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
