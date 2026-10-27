# @trusty-squire/sdk

Typed client for [Trusty Squire](https://trustysquire.ai). Your app can connect a
user, call APIs with their vaulted keys, mint revocable app access, read the audit
log, and show passkey approvals inside your own conversation UI. Your app never
holds the user's keys or card.

```sh
npm i @trusty-squire/sdk
```

## What your app can and cannot do

| Your app can                                         | Your app cannot                          |
| ---------------------------------------------------- | ---------------------------------------- |
| List key metadata and call APIs with a key (`use`)   | Read a key's value                       |
| Mint and revoke app access grants                    | Read card numbers or any card data       |
| Ask the user to edit or delete a key, or edit a card | Approve anything: approval needs the user's passkey |
| Show, deny and track approvals; receive signed webhooks | Skip an approval with a token alone   |

Calls through a saved key (`credentials.use`, app access grants) need no approval.
Only Squire's risky actions do: paying, revealing a key, editing or deleting a key,
and editing a card.

Revealing a key and paying are started by the Squire broker (the MCP server), which
is where the value or the card is used. Your app still sees those approvals through
the webhook and `approvals.get()`, can draw them, and can deny them.

## The three steps

```ts
import { Squire } from "@trusty-squire/sdk";

// Server side. The token is the user's Squire session token (see "Connect a user").
const squire = new Squire({ token: userSquireToken, agentName: "Ruby in Beeline" });

// 1. A risky call returns a pending approval, not a result.
const { approval } = await squire.credentials.requestDelete({ service: "github" });
// approval → { id, kind, action, title, details, status, expiresAt, approveUrl, … }
renderApprovalCard(approval); // draw it in your conversation

// 2. Browser side: the Approve button opens the Squire passkey sheet.
import { openApproval } from "@trusty-squire/sdk";
approveButton.onclick = () => openApproval(approval);

// 3. The decision arrives on your webhook.
const { secret } = await squire.webhooks.register("https://app.example.com/squire/webhook");
app.post("/squire/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const ev = await squire.webhooks.verify(req.body, req.headers, { secret });
  updateCard(ev.approvalId, ev.decision); // "approved", "denied", "expired", …
  res.sendStatus(204);
});
```

The Deny button can call your backend, which calls `squire.approvals.deny(id)`.

## The approval card

```ts
interface Approval {
  id: string;
  kind: "payment" | "credential_fetch" | "credential_mutation" | "card_mutation";
  action: "pay" | "reveal" | "edit" | "delete" | "edit_card";
  title: string;                       // "Pay USD 38.00 to whitejade.xyz"
  details: { label: string; value: string }[]; // rows to show, in order
  status: ApprovalStatus;
  requestedBy: string;
  reason: string | null;
  createdAt: string;
  expiresAt: string;
  approveUrl: string;                  // the Squire page where the user signs
}
```

Statuses:

| Status       | Meaning                                                              |
| ------------ | -------------------------------------------------------------------- |
| `pending`    | Waiting for the user.                                                |
| `approved`   | The user signed. The action has **not** run yet.                     |
| `processing` | A payment's card went to the Squire broker; checkout is under way.   |
| `completed`  | The action ran: key edited or deleted, card edited, key revealed, order confirmed. |
| `failed`     | The action could not run after approval.                             |
| `denied`     | The user said no. Nothing changed.                                   |
| `expired`    | Nobody answered in time. Nothing changed.                            |

Do not tell the user a payment happened at `approved`. Wait for `completed`.
Key and card edits run in the same step as the signature, so they go from `pending`
to `completed`.

Each approval covers only the exact operation it shows. A different amount,
merchant, key or change needs a new approval.

## The passkey sheet

Passkeys only sign for the site that created them, so the user signs on
trustysquire.ai. `openApproval(approval, options)` (also `squire.approvals.open`)
shows that page in a sheet over your app, with its address visible, and resolves
`{ approvalId, status }` when the page reports back. Call it from a click handler.

| `mode`     | What happens                                                                 |
| ---------- | ---------------------------------------------------------------------------- |
| `auto`     | The sheet. If the sheet cannot use a passkey, the page offers a popup; if a popup is blocked too, the SDK redirects. |
| `sheet`    | An iframe sheet with `publickey-credentials-get` allowed for Squire only.    |
| `popup`    | A popup window.                                                              |
| `redirect` | The whole page goes to Squire, which sends the user back to `returnUrl` with `squire_approval_id` and `squire_approval_status` in the query. |

Without a DOM (React Native, a server), build the URL and open it in an in-app
browser session:

```ts
const url = squire.approvals.url(approval, "redirect", { returnUrl: "beeline://approval" });
```

The status a page reports is a hint. The webhook or `approvals.get()` is the record.

## Webhooks

`webhooks.register(url)` sets one https URL for this session and returns its signing
secret once. Registering again rotates the secret. Each status change is POSTed with:

```
squire-event-id: evt_…
squire-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
```

`webhooks.verify(rawBody, headers, { secret })` accepts a delivery only when a `v1`
signature matches and the timestamp is within 300 seconds (`toleranceSeconds`).
Pass the raw body bytes, not parsed JSON. Retries keep the same event id; pass
`seen: (id) => boolean` to reject one you already handled. Failed deliveries retry
after 10 s, 30 s, 2 min, 10 min, 30 min, 1 h and 3 h. Events report the latest
status, so a fast approval can skip a step.

No webhook? Wait on the status endpoint instead:

```ts
const settled = await squire.approvals.wait(approval.id, { untilFinal: true });
```

## Everything else

```ts
// Connect a user: send them to confirm_url, then poll until claimed.
const { setup_code, confirm_url } = await squire.connect.start({ agentName: "Beeline" });
const { status, agent_session_token } = await squire.connect.poll(setup_code);

await squire.credentials.list();                    // metadata, never values
await squire.credentials.store({ service: "openai", value: key }); // write-only
await squire.credentials.use({                      // Squire injects the key
  service: "stripe",
  http: { method: "GET", url: "https://api.stripe.com/v1/balance",
          headers: { authorization: "Bearer ${SECRET}" } },
});
await squire.credentials.requestEdit({ service: "stripe",
  changes: { allowed_hosts: { mode: "add", hosts: ["files.stripe.com"] } } });
await squire.cards.list();                          // label, brand, last four
await squire.cards.requestEdit({ cardId });
const grant = await squire.apps.grant({ service: "openai" }); // revocable token
await squire.apps.revoke(grant.grant_id);
await squire.runs.start({ /* provision input */ });
await squire.audit.list({ limit: 50 });
```

Errors: `ApiCallError` (`status`, `code`), `MissingTokenError`,
`WebhookVerificationError` (`code`), `ApprovalOpenError` (`code`).

`squire.client` is the lower-level `ApiClient` the Squire MCP server also uses. Its
methods return the API's JSON as is.
