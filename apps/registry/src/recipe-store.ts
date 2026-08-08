// Storage layer for shared Operator Recipes (replay-serve-live-domainlock).
// A recipe SERVES LIVE the moment `POST /recipes` accepts it — there is no
// candidate/promotion tier. Safety is enforced by the domain-lock
// (recipeDomainLockViolations in @trusty-squire/recipe-schema), checked
// both here at write time (routes/recipes.ts) and again at replay time by
// the mcp client, not by a housekeeper-vetted promotion gate. See
// docs/ARCHITECTURE.md and CLAUDE.md.
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
  submitted_at: Date;
  updated_at: Date;
}

export interface UpsertOperatorRecipeInput {
  verb: string;
  domain: string;
  recipe: OperatorRecipe;
}

export interface OperatorRecipeStore {
  /**
   * Write (or replace) the recipe for a (verb, domain) key — the ONLY
   * write path; it's what `POST /recipes` calls directly, unauthenticated
   * (the domain-lock + share-eligibility gates are what stand between a
   * caller and a write). Last-write-wins per key.
   */
  upsert(input: UpsertOperatorRecipeInput): Promise<OperatorRecipeStoreRecord>;

  /** Fetch the recipe for a (verb, domain) key, or null if none exists. */
  findByKey(verb: string, domain: string): Promise<OperatorRecipeStoreRecord | null>;
}

export function recipeStoreKey(verb: string, domain: string): string {
  return `${verb}--${domain.toLowerCase()}`;
}
