# @trusty-squire/recipe-schema

Type-checked Operator Recipe wire schema for [Trusty Squire](https://github.com/Trusty-Squire/trusty-squire) — the `(verb, eTLD+1)`-keyed replay-plan contract shared by the mcp client (record + publish) and the registry server (validate + store). It mirrors the role `@trusty-squire/skill-schema` plays for the separate Tier-2 Learned Skill flow.

## Install

```bash
npm install @trusty-squire/recipe-schema
```

## What's in here

- `OperatorRecipeSchema` / `parseOperatorRecipe` — the Zod schema and parser for a recorded replay plan: stable-attribute targets, typed parameter holes, slot-referenced secrets (never values), and a machine-checkable postcondition.
- `OperatorVerbSchema` — the closed task-verb enum recipes are keyed by.
- `operatorRecipeDomain`, `operatorRecipeKey`, `operatorRecipeKeyForDomain` — the PSL-based `(verb, eTLD+1)` keying helpers.
- `checkoutFieldSetSignature`, `checkoutShapeKey`, `isCheckoutShapeKey`, `operatorRecipeKeyForCheckoutShape` — the checkout-leg shape key: sha256 of a checkout page's full field-name set (hidden fields included), stored as a `shape:<hex>` pseudo-domain in the ordinary domain slot so a checkout leg recorded on one store can replay on another store with the identical checkout field set.
- `recipeDomainLockViolations`, `isSameRecipeDomain` — the write/replay domain-lock: ordinary recipes stay within their recorded registrable domain, while checkout-shape recipes cannot navigate or widen host scope.
- `isRecipeShareEligible` — the cross-user share-eligibility gate: refuses recipes carrying user-specific or secret-shaped literals.

`POST /recipes` serves an accepted recipe live immediately. Clients and the registry both apply the domain-lock and `isRecipeShareEligible` before the write; there is no candidate or promotion tier.

The local record/replay engine that produces and consumes these recipes lives in the monorepo at `apps/mcp/src/bot/operator-recipe.ts` and is documented in [`docs/DESIGN-replay-engine.md`](https://github.com/Trusty-Squire/trusty-squire/blob/main/docs/DESIGN-replay-engine.md).
