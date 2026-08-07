// In-memory implementation of OperatorRecipeCandidateStore. Used by tests
// and any non-production deployment that doesn't want Postgres on the
// critical path.

import { parseOperatorRecipe } from "@trusty-squire/recipe-schema";
import { recipeStoreKey } from "./recipe-store.js";
import type {
  OperatorRecipeCandidateStore,
  OperatorRecipeCandidateStoreRecord,
  UpsertOperatorRecipeCandidateInput,
} from "./recipe-candidate-store.js";

export class InMemoryOperatorRecipeCandidateStore implements OperatorRecipeCandidateStore {
  private readonly rows = new Map<string, OperatorRecipeCandidateStoreRecord>();

  async upsert(
    input: UpsertOperatorRecipeCandidateInput,
  ): Promise<OperatorRecipeCandidateStoreRecord> {
    const key = recipeStoreKey(input.verb, input.domain);
    const now = new Date();
    const existing = this.rows.get(key);
    const record: OperatorRecipeCandidateStoreRecord = {
      key,
      verb: input.verb,
      domain: input.domain.toLowerCase(),
      payload: parseOperatorRecipe(input.recipe),
      schema_version: input.recipe.schema_version,
      submitted_at: existing?.submitted_at ?? now,
      updated_at: now,
    };
    this.rows.set(key, record);
    return record;
  }

  async findByKey(
    verb: string,
    domain: string,
  ): Promise<OperatorRecipeCandidateStoreRecord | null> {
    return this.rows.get(recipeStoreKey(verb, domain)) ?? null;
  }

  async listCandidates(limit: number): Promise<OperatorRecipeCandidateStoreRecord[]> {
    return [...this.rows.values()]
      .sort((a, b) => a.submitted_at.getTime() - b.submitted_at.getTime())
      .slice(0, limit);
  }

  async remove(verb: string, domain: string): Promise<boolean> {
    return this.rows.delete(recipeStoreKey(verb, domain));
  }
}
