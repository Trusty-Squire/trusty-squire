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
delivery is single-use, and expiry or denial releases nothing. Every outcome is
audited under `purpose: "reveal"` with the credential reference and the approval
id — never the value. Implementation:
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
operator public key, purchase-payload digest, encrypted blob, and the bound card's
non-secret label and `last4` display metadata so the holder can identify the card
being released. It does not grant account navigation. List responses omit the blob
and expose only the record ID, label,
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

Before submitting that approval, the holder of the capability link may instead
choose **Deny payment**. The API atomically changes only an unexpired `pending`
record to `denied` and clears every staged JWS and sealed-card candidate. Operator
confirmation rechecks the terminal state, so no card is released after denial
has committed.

Just-in-time add-card approvals may be created without a card reference, while
still binding the operator's ephemeral public key at creation. The API permits
one card bind only while the approval is pending and unexpired, verifies that
the encrypted-card record belongs to the same account, and rejects approval
until a card is bound. This enforces the seal → bind → approve order on the
server rather than relying on client convention. On resume, the operator fails
closed unless the approval record contains a non-blank server-bound card
reference, and uses that reference when re-creating the signed purchase payload.
Immediately before filling and submitting a single-page just-in-time checkout,
it attempts to re-read the live merchant, origin, amount, and currency. When that
read succeeds, it refuses submission if any signed field changed. When the page no
longer exposes a machine-readable total, it keeps the original mandate-bound checkout
values rather than minting another approval.

A split checkout may collect card details before it exposes the final payable total.
On every observation, the session best-effort captures the most recent real checkout
total read from the current page, replacing the prior value only after a successful
read and scoping it to that page's origin. The `fill_card` phase prefers the live
card-entry page's own total. A subtotal is accepted as the payable amount only when
the same scoped order summary states that shipping is free; recommendation sections
are excluded before any amount is selected. When that page has no readable total,
caller-supplied `amount_cents` and `currency` take precedence as the approval amount;
an omitted merchant name falls back to the checkout hostname. If those values were
not supplied, the operator may instead use the same session's captured value after
re-checking that the current origin matches. The resulting single amount-bound
approval displays and signs whichever amount was selected, releases the card, and
authorizes a later charge up to that amount.
After approval it requires the live page origin to equal the mandate's checkout
origin, fills no submit control, and permits card data only in the main frame,
same-registrable-domain HTTPS frames, or curated HTTPS payment-provider frames. A
failed or unrecognized-frame fill clears partial card data; if cleanup itself cannot
be confirmed, the session keeps the payment-field seal active. Both fill and cleanup
are limited to the selected card controls and explicitly labeled billing controls
inside a positively identified payment context. Generic merchant address and country
controls are treated as shipping controls and are never sealed or cleared by this
payment path. On success the raw card is zeroed in the operator, while the eligible
page fields keep the payment-field marker for the checkout's review step. That
marker is card-fill machinery (cleanup, saved-card resolution, profile
destruction) — it does NOT mask anything: observations and screenshots show the
filled card like any other page content. Session state retains only approval and
mandate metadata, the checkout binding, card reference, and last four digits.

Unsupported-wallet detection follows the frame containing the actual visible PAN
field. PayPal and Braintree hosted card fields fail closed, while an unrelated PayPal
express-button frame does not disqualify a fillable merchant or recognized Shopify
PCI card-field frame. When a checkout mounts multiple card forms, the operator fills
one complete visible and enabled group containing PAN, name, expiry, and CVV. When
multiple groups are complete, it uses the PAN's rendered center-point hit-test and
selects only the unique topmost, non-occluded group; otherwise it fails with
`payment_card_form_ambiguous`. Card filling stays inside that selected group. In the
single-page flow, a charge control inside a card group is eligible only for the
selected group, and both card fields and that charge control follow their HTML `form`
relationship when mounted elsewhere in the DOM; a merchant checkout control outside
every card group remains eligible. The split-checkout fill does not select or click a
charge control. Once the payment context is selected, PAN, expiry, and CVV are the
required card fields. Cardholder name and the remaining billing fields are filled
best-effort, and a missing name input does not abort an otherwise fillable payment.

Placing the order and verifying the final total are the CALLER's job, not the
operator's. The operator never re-reads a live total for a split checkout, never
clicks a charge control, and never submits anything after the fill: the fill-time
approval already authorizes a charge up to the approved amount, and the caller is
responsible for checking the live final total against that approved amount before
placing the order itself through `operate_act`. At fill time, the session snapshots
the approval ID, optional mandate ID,
merchant, approved amount and currency, opaque card reference, and last four digits.
A `click` or `js_click` whose resolved control label matches the shared
checkout-submit heuristic consumes that snapshot before dispatch. The first
recognized click may fire; a second recognized click for the same approval is refused
before dispatch and requires a fresh `operate_pay` approval, which also requires a
fresh session because same-session refill is forbidden. If dispatch is positively
known not to have occurred, the attempt marker is rolled back. Non-charge-labeled
clicks, key presses, and `oauth_click` remain outside this heuristic and are not gated
by it. No merchant hostname or CSS selector participates in the decision.

After a recognized place-order click dispatches, the MCP server best-effort writes a
`vault.payment_executed` audit event through the existing payment-audit endpoint with
`payment_status: "payment_place_order_attempted"`. The event binds the approved
merchant, amount, currency, card reference, approval ID, optional mandate ID, and
last four digits. It deliberately records an attempt rather than an executed charge:
Trusty Squire cannot verify what the merchant did after the caller's click. The audit
write never blocks or changes the click result, and no PAN or CVV can enter the
payload.

The card VALUES are visible in observations and screenshots once filled: the
operator no longer masks any read (owner's decision, 2026-09-05). The money-fence
that remains is the approval itself — the phone-approved amount, the one-shot
charge click, and the fact that the vault never releases a card except to a page
the operator fills under that approval.
The `confirm` phase is a pure close-out: it makes no browser or provider call, reads
no total, verifies no amount, and emits no audit event itself (it never charges), so it also
cannot mislabel or falsely claim a payment was executed. It reports the approved
merchant, amount, and currency back to the caller and releases the pending-fill
lease into a sealed state — the payment-field marker stays set, since the operator
never actually cleared the live fields, and the session then
refuses further payment operations for its lifetime. There is deliberately no
same-session path to fill a different card after a fill or a confirm: recovery from
a stuck, declined, or abandoned payment is closing the session with `operate_finish`
and starting a fresh one, not an in-place refill. Every payment entry is still
claimed before asynchronous work begins, and a pending confirmation is claimed
atomically, so overlapping `operate_pay` calls cannot race toward the same
close-out. The single-page (`phase="single"`) checkout still reads the live total,
fills, and submits in one call. Before dispatch it may select only the sole
unambiguous new-card radio competing with a merchant-saved card, then re-verifies
that choice and every sealed value at the final pre-click boundary; any ambiguity or
state change fails closed. The approval lifetime is checked after mandate
verification and again immediately before that explicit charge click. Expiry before
the click returns `payment_approval_expired` without dispatch; once input dispatch
may have begun, the deadline cannot abort the merchant's charge or legitimate 3-D
Secure follow-up, and uncertain completion remains `payment_outcome_unknown`. After
dispatch, the native 3-D Secure wait passively
compares issuer/network/last-four evidence rendered by the issuer/app with the
released card. A discrepancy is returned and retained across resumable status polls
as a structured `payment_instrument_mismatch` warning; it never mutates or cancels
the challenge, creates a charge path, or introduces another approval. Once the trusted
click reaches the input-dispatch boundary, a rejected click completion or missing page
observer is conservatively retained as an unknown submitted payment with resumable
post-submit state. That state remains `payment_outcome_unknown` until concrete
merchant-terminal or genuine 3-D Secure evidence appears; status checks cannot
promote uncertainty into a 3-D Secure handoff. Only a failure known to precede the
input-dispatch boundary is classified as a checkout failure and allowed to clear the
pending-submit state.

Payment state, the approval keypair, and the verified mandate remain attached to the
addressed operate session. `operate_pay` surfaces the approval link before a bounded
server-side wait of up to one minute. If that call returns `approval_pending`, another
`operate_pay` call with the same arguments resumes the same approval and keypair rather
than creating another human authorization. `operate_payment_status` is an optional
non-charging view before charge and the continuation after an unresolved submitted attempt;
its bounded waits never verify a mandate or open a card. When either path observes
denial or expiry, it clears the private operator key and keeps that session's attempt
terminal. Repeated calls return the same terminal result and cannot automatically mint
a replacement approval; a new charge attempt requires a fresh session and a fresh
explicit human approval action. `operate_pay` and `operate_payment_status`
resolve `session_id` once at tool entry and return that ID in
their results and follow-up hints. Omitting the ID is accepted only when exactly one
process-local session exists; no path selects a newest or arbitrary session. Ordinary finish
first rejects new calls and drains calls that already entered within the bounded terminal
transition. Watchdog and disconnect teardown also close admission; maximum-lifetime and CPU
termination defer only an active payment, and only until that same hard deadline. Existing
captured dispatch evidence shares one metadata-only audit, and teardown performs the bounded
pending-3DS live check before clearing payment state. Remaining payment state never makes the
browser immortal: close records that the profile is payment-sensitive, clears the active payment
and payment-field seal, and destroys or quarantines that session's unique ephemeral profile without
publishing its browser state. No payment state or card-bearing browser profile can therefore update
the saved login snapshot or carry into a later session.

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
First acceptance at `POST /approve` also requires a currently valid assertion.
An exact, nonce-bound candidate already verified there may outlive the assertion
while waiting in the authenticated relay: only `/confirm` and the MCP relay consumer
may revalidate it at a point inside its signed validity interval, and only within the
18-minute maximum approval lifetime. Signature, issuer, audience, context, payload
binding, confidence, and the approval record's own expiry remain mandatory. The
operator confirms the exact verified submission before retaining the card to fill
the checkout. Browser passkeys are capped at low confidence in Vouchflow regardless
of biometric, so mandate assurance rests on user presence, the single-use nonce,
and amount, recipient, origin, and item binding rather than a high confidence
tier. Plaintext PAN and CVV are not returned through MCP to the coding-agent
model, sent to the Trusty Squire API, logged, or stored in payment audit events.
Issuer 3-D Secure is handed back to the user rather than automated; the operator
may wait for the user to resolve the challenge, but it never completes the
challenge itself. Its mismatch comparison reads only rendered ACS evidence and
leaves the cardholder's approval decision unchanged.

Payment audit events are deliberately metadata-only: merchant, amount,
currency, card last four digits, status, and optional mandate, opaque card, and
approval references. The API validates `last4` as exactly four digits; the audit
schema has no PAN or CVV fields, and stored events never include them. Payment audit
events use the vault audit retention window, which defaults to 365 days.

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
  operator key under the exact purchase binding. The API and coding-agent model
  never see plaintext PAN or CVV until the operator types it into the merchant's
  own page. Split-checkout card fields stay filled in the live page after fill,
  including after close-out confirmation; arbitrary cross-origin frames cannot
  receive them.

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
