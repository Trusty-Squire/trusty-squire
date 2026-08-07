# DESIGN — local prepared-statement replay engine

Status: implemented (2026-08-05). This document owns the local operator-recipe
contract. Registry Skills and their `serviceSlugFromUrl` key remain a separate
system; `DESIGN-operator-hints.md` owns how those Skills guide the host.

## Purpose

Repeated `operate_use` tasks can skip rediscovering every browser action. A
successful run is recorded as ordered mechanics plus typed parameter holes, then
replayed with fresh values. The host LLM classifies the task and repairs a local
miss; it does not choose targets during a clean replay.

## Recipe identity

The local key is `(verb, eTLD+1)`:

- `verb` is parsed by the closed `OperatorVerbSchema` enum in
  `apps/mcp/src/bot/operator-recipe.ts`. It is host-classified, not free-form.
- The domain is derived with the Public Suffix List. Paths and queries do not
  participate, so ordinary `www`, `shop`, and `checkout` subdomains collapse to
  their registrable domain.
- Tenant subdomains under `myshopify.com` and `notion.site` retain the full host.
- Recipes are local files under `~/.trusty-squire/operator-recipes/`, or the
  directory selected by `TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR`.

This key does not alter registry Skill lookup or `serviceSlugFromUrl`.

## Recording contract

`operate_remember` requires a name, goal, closed verb, complete authoritative
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

Before every deterministic target action, replay refreshes the live inventory
and resolves the target structurally. Provenance-bearing money fields use the
stricter `testid`/`id` resolution rail for value verification, and additionally
require a locale-stable field-role match: recording captures a `field_role`
token per field (autocomplete token first, then `data-field-role`/`data-role`,
then a distinguishing input type — never visible label text, which flips under
i18n), and the fill commits only when the live field derives the same role. A
missing or mismatched role signal is a miss, never a confident fill.

## Replay and repair

New calls select a recipe with `operate_use { verb, service_url, params }`.
`params` binds hole names and any legacy `${VAR}` templates. A keyed cache miss
opens a normal cold session and returns `replay.status = "cache_miss"`. Legacy
name-only recipes remain hint-only and do not enter deterministic replay.

Replay walks the trace in order. A binding, target, live-ref, or action miss
returns exactly one `fallback_required` result containing the missed step and a
`next_index`. Extraction and payment also return local repair points because
credential discovery and the existing `operate_pay` approval flow remain
host-driven. After repairing that step, the host calls `operate_use` with the
same recipe bindings, `session_id`, and `resume_from = next_index`; replay checks
the continuation against the same recipe and bindings, then continues.

The saved postcondition is bound from the active replay's parameters before
`operate_finish_task` verifies it.

## Money-path guards

The replay money path covers purchase, subscribe, checkout, renew, upgrade,
book, and reserve recipes. Its additional invariants are:

1. Every deterministic target action passes a fresh structural resolution.
2. A recipe value is committed to a field only when the live field's
   locale-stable role matches the recorded `field_role` (see Stable targets);
   role mismatch or absence downgrades the step to a miss for host repair.
3. Every injected address, contact, and quantity value is checked against the
   live field immediately after the action and across state-changing
   transitions while the field remains mounted.
4. A host-repaired money field must identify the issued step and hole, supply
   the same value, match the recorded or uniquely equivalent target, and pass a
   fresh live-value check.
5. Missing or mismatched fields return `human_required`; `operate_pay` refuses
   to run until all replay field guards are satisfied and rechecks mounted
   fields immediately before payment.

The existing `operate_pay` phone approval, passkey mandate, card injection,
3-D Secure handling, and expected-total behavior are unchanged.

## Code ownership

| Contract | Authoritative implementation |
|---|---|
| Verb schema, PSL key, local persistence, holes, target resolver | `apps/mcp/src/bot/operator-recipe.ts` |
| Action-time provenance, verified recording, replay, repair, field guards | `apps/mcp/src/bot/provision-session.ts` |
| Public `operate_remember` / `operate_use` contracts | `apps/mcp/src/tools/provision-drive.ts` |
| Card-source attestation and payment gate | `apps/mcp/src/tools/operate-pay.ts`, `apps/mcp/src/bot/pay-operator.ts` |
| Registry Skill keying | `packages/skill-schema/src/service-slugs.ts` |

## Explicitly out of scope

- Cross-store platform templates or changes to registry Skill keying
- Anti-unification across multiple recordings or shape hierarchies
- Fingerprint scoring, embeddings, or vision/taste selection
- Changes to the sibling replay evaluation harness or corpus
