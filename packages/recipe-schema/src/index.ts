// Public surface of @trusty-squire/recipe-schema.
//
// The Operator Recipe wire contract — the (verb, eTLD+1)-keyed replay-plan
// schema shared by the mcp client (record/publish) and the registry server
// (validate/store), mirroring the role @trusty-squire/skill-schema plays
// for the separate Tier-2 Learned Skill flow.

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
  checkoutFieldSetSignature,
  isCheckoutShapeKey,
  checkoutShapeKey,
  operatorRecipeKeyForCheckoutShape,
  isRecipeShareEligible,
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
} from "./operator-recipe.js";
