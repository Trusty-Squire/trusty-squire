# @trusty-squire/recipe-schema

Type-checked Operator Recipe wire schema for [Trusty Squire](https://github.com/Trusty-Squire/trusty-squire) — the action-path-aware replay-plan contract shared by the mcp client (record + publish) and the registry server (validate + store). It mirrors the role `@trusty-squire/skill-schema` plays for the separate Tier-2 Learned Skill flow.

## Install

```bash
npm install @trusty-squire/recipe-schema
```

## What's in here

- `OperatorRecipeSchema` / `parseOperatorRecipe` — the Zod schema and parser for a recorded replay plan: stable-attribute targets scoped by frame origin/path when applicable, typed parameter holes, slot-referenced secrets (never values), and a machine-checkable postcondition.
- `OperatorVerbSchema`, `canonicalVerb` — the closed task-verb enum and the two supported consolidations: `reserve` to `book`, plus `renew`, `upgrade`, and `downgrade` to `subscribe`. Legacy values still parse, while key builders always emit the canonical verb.
- `operatorRecipeDomain`, `extractActionPath` — derive the PSL-based domain and optional allow-listed action path from an entry URL. Queries never contribute, and an unrecognized path returns the empty catch-all dimension.
- `operatorRecipeKey`, `operatorRecipeKeyForDomain`, `operatorRecipeKeyWithActionPath`, `operatorRecipeKeyForDomainAndActionPath` — build the local `(verb, eTLD+1, action_path)` key or its `(verb, eTLD+1)` catch-all. The shared registry continues to use the catch-all key.
- `checkoutFieldSetSignature`, `checkoutShapeKey`, `isCheckoutShapeKey`, `operatorRecipeKeyForCheckoutShape` — the checkout-leg shape key: sha256 of a checkout page's full field-name set (hidden fields included), stored as a `shape:<hex>` pseudo-domain in the ordinary domain slot so a checkout leg recorded on one store can replay on another store with the identical checkout field set.
- `recipeDomainLockViolations`, `isSameRecipeDomain` — the write/replay domain-lock: ordinary recipes stay within their recorded registrable domain, while checkout-shape recipes cannot navigate or widen host scope.
- `isRecipeShareEligible` — the cross-user share-eligibility gate: refuses recipes carrying user-specific or secret-shaped literals.

The record, publish, and replay contract is documented in [`docs/DESIGN-replay-engine.md`](https://github.com/Trusty-Squire/trusty-squire/blob/main/docs/DESIGN-replay-engine.md); the local engine lives at `apps/mcp/src/bot/operator-recipe.ts`.
