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
- `isRecipeShareEligible` — the cross-user share-eligibility gate: refuses recipes carrying user-specific or secret-shaped literals. Run client-side before publishing and server-side on candidate submission.

The local record/replay engine that produces and consumes these recipes lives in the monorepo at `apps/mcp/src/bot/operator-recipe.ts` and is documented in [`docs/DESIGN-replay-engine.md`](https://github.com/Trusty-Squire/trusty-squire/blob/main/docs/DESIGN-replay-engine.md).
