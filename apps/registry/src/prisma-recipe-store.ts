// Prisma-backed OperatorRecipeStore. Used by the production server. Tests
// use InMemoryOperatorRecipeStore. Mirrors prisma-skill-store.ts's role for
// the separate Skill flow, but without any of that flow's health-counter
// machinery — a recipe is last-write-wins, gated by the domain-lock +
// share-eligibility checks in routes/recipes.ts rather than a verifier
// replay loop.

import { parseOperatorRecipe } from "@trusty-squire/recipe-schema";
import { createRegistryPrismaClient, type RegistryPrismaClient } from "./registry-prisma-client.js";
import {
  recipeStoreKey,
  type OperatorRecipeStore,
  type OperatorRecipeStoreRecord,
  type UpsertOperatorRecipeInput,
} from "./recipe-store.js";

export class PrismaOperatorRecipeStore implements OperatorRecipeStore {
  private constructor(private readonly client: RegistryPrismaClient) {}

  static async fromEnv(): Promise<PrismaOperatorRecipeStore> {
    const client = createRegistryPrismaClient();
    await client.$connect();
    return new PrismaOperatorRecipeStore(client);
  }

  static fromClient(client: RegistryPrismaClient): PrismaOperatorRecipeStore {
    // For tests + the registry server which already maintains a single
    // PrismaClient. Skipping $connect — the caller owns the lifecycle.
    return new PrismaOperatorRecipeStore(client);
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }

  async upsert(input: UpsertOperatorRecipeInput): Promise<OperatorRecipeStoreRecord> {
    const key = recipeStoreKey(input.verb, input.domain);
    const domain = input.domain.toLowerCase();
    const now = new Date();
    const row = await this.client.operatorRecipeRecord.upsert({
      where: { key },
      create: {
        key,
        verb: input.verb,
        domain,
        payload_json: input.recipe,
        schema_version: input.recipe.schema_version,
        updated_at: now,
      },
      update: {
        verb: input.verb,
        domain,
        payload_json: input.recipe,
        schema_version: input.recipe.schema_version,
        updated_at: now,
      },
    });
    return {
      key: row.key,
      verb: row.verb,
      domain: row.domain,
      payload: parseOperatorRecipe(row.payload_json),
      schema_version: row.schema_version,
      submitted_at: row.submitted_at,
      updated_at: row.updated_at,
    };
  }

  async findByKey(verb: string, domain: string): Promise<OperatorRecipeStoreRecord | null> {
    const row = await this.client.operatorRecipeRecord.findUnique({
      where: { key: recipeStoreKey(verb, domain) },
    });
    if (row === null) return null;
    return {
      key: row.key,
      verb: row.verb,
      domain: row.domain,
      payload: parseOperatorRecipe(row.payload_json),
      schema_version: row.schema_version,
      submitted_at: row.submitted_at,
      updated_at: row.updated_at,
    };
  }
}
