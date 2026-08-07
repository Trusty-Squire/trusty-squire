// Storage layer for the LIVE / promoted half of shared Operator Recipes —
// the registry-backed side of "recipe recorded on one install is reused by
// the next install to visit the same site." `operate_use` and
// `GET /recipes/:verb/:domain` read ONLY this store; the only writer is
// the admin-bearer-gated promotion route (see routes/admin-recipes.ts).
// Unauthenticated `POST /recipes` writes go to the SEPARATE candidate store
// (recipe-candidate-store.ts) instead — a recipe never becomes replayable
// just by being posted here, only by being promoted. See
// docs/ARCHITECTURE.md and the OperatorRecipeRecord model comment in
// schema.prisma.
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
  promoted_at: Date;
  promoted_by: string;
  updated_at: Date;
}

export interface PromoteOperatorRecipeInput {
  verb: string;
  domain: string;
  recipe: OperatorRecipe;
  // Free-text identity of whoever/whatever promoted this — audit trail
  // only, not an auth mechanism (the admin bearer is the actual gate).
  promotedBy: string;
}

export interface OperatorRecipeStore {
  /**
   * Promote a recipe live for a (verb, domain) key. The ONLY way a row
   * enters this store — there is no direct/unauthenticated write path.
   * Last-write-wins per key across successive promotions (e.g. a
   * corrected re-promotion supersedes an earlier one); the promotion
   * route, not this store, is responsible for deciding a promotion is
   * warranted.
   */
  promote(input: PromoteOperatorRecipeInput): Promise<OperatorRecipeStoreRecord>;

  /**
   * Fetch the live recipe for a (verb, domain) key. Returns null when no
   * recipe has ever been promoted for that key — including when a
   * candidate exists but hasn't been promoted yet.
   */
  findByKey(verb: string, domain: string): Promise<OperatorRecipeStoreRecord | null>;
}

export function recipeStoreKey(verb: string, domain: string): string {
  return `${verb}--${domain.toLowerCase()}`;
}
