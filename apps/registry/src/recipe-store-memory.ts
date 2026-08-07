// In-memory implementation of OperatorRecipeStore. Used by tests and any
// non-production deployment that doesn't want Postgres on the critical
// path. Mirrors skill-store-memory.ts's role for the Skill flow.

import { parseOperatorRecipe } from "@trusty-squire/recipe-schema";
import {
  recipeStoreKey,
  type OperatorRecipeStore,
  type OperatorRecipeStoreRecord,
  type UpsertOperatorRecipeInput,
} from "./recipe-store.js";

export class InMemoryOperatorRecipeStore implements OperatorRecipeStore {
  private readonly rows = new Map<string, OperatorRecipeStoreRecord>();

  async upsert(input: UpsertOperatorRecipeInput): Promise<OperatorRecipeStoreRecord> {
    const key = recipeStoreKey(input.verb, input.domain);
    const now = new Date();
    const existing = this.rows.get(key);
    const record: OperatorRecipeStoreRecord = {
      key,
      verb: input.verb,
      domain: input.domain.toLowerCase(),
      payload: parseOperatorRecipe(input.recipe),
      schema_version: input.recipe.schema_version,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.rows.set(key, record);
    return record;
  }

  async findByKey(verb: string, domain: string): Promise<OperatorRecipeStoreRecord | null> {
    return this.rows.get(recipeStoreKey(verb, domain)) ?? null;
  }
}
