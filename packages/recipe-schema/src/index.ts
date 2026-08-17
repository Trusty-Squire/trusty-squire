// Public surface of @trusty-squire/recipe-schema.
//
// The Operator Recipe wire contract — the action-path-aware replay-plan schema
// shared by the mcp client (record/publish) and the registry server
// (validate/store), mirroring the role @trusty-squire/skill-schema plays for
// the separate Tier-2 Learned Skill flow.

export {
  OperatorVerbSchema,
  RecipeHoleSchema,
  RecipeValueSchema,
  RecipeTargetSchema,
  PostconditionSchema,
  OperatorRecipeSchema,
  parseOperatorRecipe,
  operatorRecipeDomain,
  operatorRecipeKey,
  operatorRecipeKeyForDomain,
  canonicalVerb,
  extractActionPath,
  operatorRecipeKeyWithActionPath,
  operatorRecipeKeyForDomainAndActionPath,
  checkoutFieldSetSignature,
  isCheckoutShapeKey,
  checkoutShapeKey,
  operatorRecipeKeyForCheckoutShape,
  isRecipeShareEligible,
  isSameRecipeDomain,
  recipeDomainLockViolations,
  isRecipeDomainLocked,
  EmailAliasTemplatePattern,
} from "./operator-recipe.js";
export type {
  OperatorVerb,
  RecipeHole,
  RecipeValue,
  RecipeTarget,
  TraceAction,
  TraceEntry,
  SuccessSignal,
  Postcondition,
  SecretRef,
  OperatorRecipe,
  RecipeShareEligibility,
  RecipeDomainLockViolation,
} from "./operator-recipe.js";
