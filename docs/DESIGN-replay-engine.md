# DESIGN — local prepared-statement replay engine

Status: implemented (2026-08-05). This document owns the local and shared
operator-recipe contract. Registry Skills and their `serviceSlugFromUrl` key
remain a separate system; `DESIGN-operator-hints.md` owns how those Skills guide
the host.

## Purpose

Repeated `operate_recipe_run` tasks can skip rediscovering every browser action. A
successful run is recorded as ordered mechanics plus typed parameter holes, then
replayed with fresh values. The host LLM classifies the task and repairs a local
miss; it does not choose targets during a clean replay.

Recipes are saved with `operate_recipe_save` and replayed with
`operate_recipe_run`.

## Recipe identity

The local key is a `(verb, eTLD+1, action_path)` tuple (recipe-key-redesign,
2026-08-16), resolved through a tiered lookup that degrades to exactly
yesterday's `(verb, eTLD+1)` key on any miss:

- `verb` is parsed by the closed `OperatorVerbSchema` enum in
  `packages/recipe-schema` (re-exported by `apps/mcp/src/bot/operator-recipe.ts`).
  It is host-classified, not free-form. `OperatorVerbSchema` still parses all
  15 legacy values (no enum narrowing), but every key/file builder runs the
  verb through `canonicalVerb()` first, which merges `reserve→book` and
  `renew|upgrade|downgrade→subscribe`. No new recording is ever written under
  a legacy verb name; the merge exists only so old input and old files keep
  parsing. `purchase`/`checkout`/`add_to_cart` are deliberately NOT merged.
- The domain is derived with the Public Suffix List. Queries never
  participate, so ordinary `www`, `shop`, and `checkout` subdomains collapse to
  their registrable domain.
- `action_path` is a NEW optional field (`extractActionPath` in
  `packages/recipe-schema`) — a short token parsed from the recipe's own
  `entry_url` path: lowercase, drop empty segments, drop a leading locale
  (`^[a-z]{2}(-[a-z]{2})?$`) or version (`^v\d+$`) segment, then walk the
  remaining segments last→first for the first hit in a hand-maintained
  allow-list (`signup, login, checkout, cart, book, reserve, cancel, pricing,
  plans, enterprise, contact-sales, keys, api-keys, settings, billing,
  download, demo, trial, upgrade, downgrade, renew, subscribe`, with synonym
  canonicalization such as `sign-up→signup`). If the hit's immediate parent
  segment is also an allow-list hit, both are kept (capped at two segments,
  e.g. `billing/cancel`). No hit anywhere in the path → `action_path` is
  absent/empty — the mandatory default-empty fail path that keeps every
  non-matching URL keying exactly as before. `action_path` is deliberately
  its own schema field, not folded into `domain` the way `checkoutShapeKey`
  is: domain-lock (`isSameRecipeDomain`, `recipeDomainLockViolations`) parses
  `domain` as a real hostname, and an action_path recipe is a normal, fully
  domain-locked, navigable recipe — just with a more specific key. Domain-lock
  code is entirely untouched by this field.
- **Local file naming and lookup (`apps/mcp/src/bot/operator-recipe.ts`):**
  `writeRecipe`'s file stem is `${verb}--${domain}--${action_path}` when
  `action_path` is set and non-empty, else today's `${verb}--${domain}`.
  `readRecipeForTask` tries the specific file first when the replaying URL's
  `action_path` is non-empty, catches `ENOENT`, and retries the degenerate
  `${verb}--${domain}` file — the fallback is mandatory, not optional: an old
  recipe recorded before this field existed sits only at the degenerate slot,
  and a replaying URL that now happens to extract a non-empty `action_path`
  must still find it.
- **No-regression write guarantee (`provision-session.ts`):** every
  recording that lands at a specific `(verb, domain, action_path)` file also
  refreshes the degenerate `(verb, domain)` catch-all whenever that slot is
  absent or itself empty-path, so a later replay on an unrecognized path
  doesn't go cold where today it hits.
- Tenant subdomains under `myshopify.com` and `notion.site` retain the full host.
- Recipes are local files under `~/.trusty-squire/operator-recipes/`, or the
  directory selected by `TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR`. Share-eligible
  recipes are additionally written live to the shared registry and are served
  immediately to other installs on a local miss. See [Shared registry and
  domain lock](#shared-registry-and-domain-lock). The registry route's own
  `action_path` slot is deferred — not yet part of the shared-registry lookup.
- A money-path recording additionally saves its checkout leg as a second,
  narrower recipe in the same store, keyed by the live checkout page's
  field-name-set signature (`checkoutShapeKey` → `shape:<sha256>` in the
  ordinary domain slot) so it can replay on an unrelated domain running the
  same checkout implementation. CLAUDE.md §"Per-leg recipe resolution +
  checkout shape signature (replay-per-leg-signature)" owns that flow.

This key does not alter registry Skill lookup or `serviceSlugFromUrl`.

## Shared registry and domain lock

Every closed recipe verb is eligible for sharing. After `operate_recipe_save`
writes locally, the client best-effort publishes a recipe that passes both the
domain lock and share-eligibility gate. `POST /recipes` is unauthenticated and
rate-limited per source IP; it repeats both checks, then upserts directly into
the single served store. `GET /recipes/:verb/:domain` can resolve that write
immediately. There is no candidate store, promotion step, or promote-time
content pin.

The domain lock is the primary cross-user navigation boundary. Using a
private-suffix-aware registrable-domain comparison, `entry_url`, every
`allowed_hosts` entry, and every explicit `goto` or `allow_host` target must
remain on the recipe's domain. Subdomains of that domain are accepted;
different registrable domains, look-alikes, and templates in a hostname are
rejected. The client checks before publishing, the registry checks before
storing, and replay checks the resolved entry and allowed hosts before opening
a session and each explicit navigation step before executing it. A replay-time
violation is terminal for that recipe, fails the payment gate, and falls back
to cold driving when the call shape permits a cold start.

Checkout-shape recipes have no site domain. They therefore cannot declare an
entry URL, widen `allowed_hosts`, or contain `goto`/`allow_host` actions; they
may only interact with the already-open checkout page.

The share-eligibility gate remains a separate privacy boundary: personal data
is represented only as typed holes and is filled from the replaying user's own
inputs. Earned credential values never enter a shared recipe; only sealed slot
references may appear. The field-role checks and all money-path guards described
below apply unchanged.

## Recording contract

`operate_recipe_save` requires a name, goal, closed verb, complete authoritative
input ledger, and machine-checkable postcondition. It checks the postcondition
before writing, so an unverified run never creates or replaces a recipe.
Sessions that used an off-inventory `text=`/`css=` locator or violated a replay
attestation are also refused.

A value becomes a hole only when all of these are true:

1. Squire recorded its source at action time.
2. The caller identifies that source in the authoritative input ledger.
3. The recorded literal exactly equals the authoritative value.

The supported holes are `address.*`, `contact.*`, `product_query`,
`credential.*`, `card.*`, and `quantity` (the group name without a field suffix
is also valid). Unknown non-money values remain literals. A checkout field that
looks like address, contact, or quantity data but lacks provenance makes
recording fail closed.

Credentials are stored as sealed slot references with `stored: false`, never as
plaintext. Payment records only a card-reference hole after `operate_pay`
resolves the card. Known email occurrences are converted to attested templates,
and single-use verification, magic-link, and reset URLs are not persisted as
replay steps or stable entries. When the start URL is single-use or contains the
known email, replay uses the caller's runtime `service_url` after confirming its
recipe domain.

## Stable targets

Each recorded target carries the stable attributes available in the observed
inventory. Replay resolves them in strict order, taking the first unique match:

```text
testid -> id -> name -> role + accessible name -> href path -> css -> unique visible text
```

When an earlier tier has multiple matches, `near_text_hint` may narrow that tier
to one element. Visible text is always the unique-only final fallback. This is
an ordered resolver, not fingerprint scoring or weighted matching.

A target observed inside a child frame also records `frame_origin` and its
nested `frame_path`. Replay first restricts the fresh inventory to that exact
frame scope, then applies the same ordered target resolver. The action still
passes the live frame-origin domain guard; recording frame scope never grants a
host or permits `type_secret` to cross the page's registrable domain.

Before every deterministic target action, replay refreshes the live inventory
and resolves the target structurally. Provenance-bearing money fields use the
stricter `testid`/`id` resolution rail for value verification, and additionally
require a locale-stable field-role match: recording captures a `field_role`
token per field (autocomplete token first, then `data-field-role`/`data-role`,
then a distinguishing input type — never visible label text, which flips under
i18n), and the fill commits only when the live field derives the same role. A
missing or mismatched role signal is a miss, never a confident fill.

## Replay and repair

New calls select a recipe with `operate_recipe_run { verb, service_url, params }`.
`params` binds hole names and any legacy `${VAR}` templates. A keyed cache miss
opens a normal cold session and returns `replay.status = "cache_miss"`. Legacy
name-only recipes remain hint-only and do not enter deterministic replay.
`operate_recipe_run { verb, session_id, leg: "checkout" }` (no `service_url`,
no `resume_from`) instead resolves and replays only the checkout leg against
the already-open session's current page, keyed by that page's shape
signature; a miss returns `replay.status = "cache_miss"` and the host drives
the leg cold.

Replay walks the trace in order. A binding, target, live-ref, or action miss
returns exactly one `fallback_required` result containing the missed step and a
`next_index`. Extraction and payment also return local repair points because
credential discovery and the existing `operate_pay` approval flow remain
host-driven. After repairing that step, the host calls `operate_recipe_run` with
the same recipe bindings, `session_id`, and `resume_from = next_index`; replay
checks the continuation against the same recipe and bindings, then continues.

Organic redirects and OAuth popups remain outside the explicit-action domain
lock and follow the existing session navigation model.

The saved postcondition is bound from the active replay's parameters before
`operate_finish` verifies it through a `result` outcome's `verify_recipe`.

## Money-path guards

Simplified 2026-08-16 (recipe-key-redesign, per captain decision). The money
fence is the live human biometric (passkey) approval on every charge, plus
the card never reaching the model — not a software re-check of replay field
values layered on top of that hardware gate. Re-validating address/contact/
quantity fields in software before allowing a charge was redundant with a
human about to approve the same charge, so that whole layer was deleted, not
re-gated.

**The single surviving invariant:** a trace step that charges the card is
never blind-replayed — it always routes to a fresh, human-approved
`operate_pay`. Concretely, `replayOperatorRecipe` (`provision-session.ts`)
unconditionally returns `fallback_required` the moment it reaches a
`recorded.kind === "operate_pay"` step, for every recipe, regardless of verb.
`isMoneyPath` (the same function) is a pure trace-content check —
`recipe.trace.some((e) => e.action.kind === "operate_pay")` — used only to
decide whether a guard failure elsewhere in the trace narrows to
`leg_fallback_required` (resume the checkout leg cold from
`from_step_index`) instead of the terminal `human_required`; it does not
gate whether `operate_pay` itself may run.

Deleted entirely (not re-gated behind a different condition):

- `MONEY_REPLAY_VERBS` — the verb-set classifier the old `isMoneyPath` used.
- The `paymentGuard` state machine (`"pending" | "verified" | "failed"`) and
  everything that existed only to compute it: pre/post-transition field
  re-verification (`attestReplayFieldsBeforeTransition`,
  `verifyReplayFieldsAfterTransition`), repair-time re-verification
  (`captureReplayRepairVerification`, `refreshReplayVerificationAfterAction`),
  and `activeProvisionBrowserForPayment`'s live-field re-check immediately
  before handing the browser to `operate_pay`.
- `assertPaymentSessionAllowed`'s field-verification refusal — it now only
  checks that the session isn't closing.

What did NOT change: the general (non-money-specific) replay field
verification — a `type`/`select`/`set_phone_country` step's value is still
checked against the live field immediately after that step executes, and a
`resume_from` continuation still re-verifies a host-repaired field before
continuing. That machinery serves every recipe, not just money-shaped ones,
and was never part of the deleted payment-validation layer. Two save-time
classifiers (checkout-leg carving in `rememberCheckoutLeg`, and the
unprovenanced-money-field refusal in `findUnprovenancedMoneyField`) also
survive unchanged in scope — they use a small local `MONEY_SHAPED_VERBS` set
(`purchase, subscribe, checkout, book` — the old `MONEY_REPLAY_VERBS`,
canonicalized) since they are save-time scope filters unrelated to the
payment fence, not part of the money rule being simplified.

Shipping recipient/address correctness is a separate concern
(`RECIPIENT-BINDING-DESIGN.md`), not a money-path guard, and is untouched by
this change.

The existing `operate_pay` phone approval, passkey mandate, card injection,
3-D Secure handling, and expected-total behavior are unchanged.

## Code ownership

| Contract | Authoritative implementation |
|---|---|
| Wire schema (verb enum, PSL key, holes, domain lock, share-eligibility gate) | `packages/recipe-schema/src/operator-recipe.ts` |
| Shared recipe write/read routes and submission rate limit | `apps/registry/src/routes/recipes.ts` |
| Local persistence, render/bind, target resolver | `apps/mcp/src/bot/operator-recipe.ts` |
| Action-time provenance, verified recording, replay, repair, field guards | `apps/mcp/src/bot/provision-session.ts` |
| Public `operate_recipe_save` / `operate_recipe_run` contracts | `apps/mcp/src/tools/provision-drive.ts` |
| Card-source attestation and payment gate | `apps/mcp/src/tools/operate-pay.ts`, `apps/mcp/src/bot/pay-operator.ts` |
| Registry Skill keying | `packages/skill-schema/src/service-slugs.ts` |

## Explicitly out of scope

- Cross-store platform templates or changes to registry Skill keying
- Anti-unification across multiple recordings or shape hierarchies
- Fingerprint scoring, embeddings, or vision/taste selection
- Changes to the sibling replay evaluation harness or corpus
