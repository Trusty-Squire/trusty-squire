// Storage layer for shared Operator Recipes — the registry-backed half of
// "recipe recorded on one install is reused by the next install to visit
// the same site." Deliberately minimal: no health counters, no
// promotion/demotion lifecycle, no signing. A recipe is a MAP (never a
// recording of one user's data — see isRecipeShareEligible in
// @trusty-squire/recipe-schema), so the trust model is the same
// share-eligibility gate applied both client-side (before publish) and
// here (before persistence) — not a verifier replay loop like Skills.
//
// Two implementations live alongside this interface:
//   - InMemoryOperatorRecipeStore (recipe-store-memory.ts)
//   - PrismaOperatorRecipeStore   (prisma-recipe-store.ts)
// Tests use the in-memory store; production wires up Prisma.

import type { OperatorRecipe } from "@trusty-squire/recipe-schema";

export interface OperatorRecipeStoreRecord {
  key: string;
  verb: string;
  domain: string;
  payload: OperatorRecipe;
  schema_version: number;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertOperatorRecipeInput {
  verb: string;
  domain: string;
  recipe: OperatorRecipe;
}

export interface OperatorRecipeStore {
  /**
   * Publish (or replace) the recipe for a (verb, domain) key. Last-write-
   * wins — there is no versioning or review gate; the client-side +
   * server-side share-eligibility check is the only trust boundary.
   */
  upsert(input: UpsertOperatorRecipeInput): Promise<OperatorRecipeStoreRecord>;

  /**
   * Fetch the recipe stored for a (verb, domain) key. Returns null when
   * no recipe has ever been published for that key.
   */
  findByKey(verb: string, domain: string): Promise<OperatorRecipeStoreRecord | null>;
}

export function recipeStoreKey(verb: string, domain: string): string {
  return `${verb}--${domain.toLowerCase()}`;
}
