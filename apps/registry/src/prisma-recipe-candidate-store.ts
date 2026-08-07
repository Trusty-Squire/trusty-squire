// Prisma-backed OperatorRecipeCandidateStore. Used by the production
// server. Tests use InMemoryOperatorRecipeCandidateStore.

import { parseOperatorRecipe } from "@trusty-squire/recipe-schema";
import { createRegistryPrismaClient, type RegistryPrismaClient } from "./registry-prisma-client.js";
import { recipeStoreKey } from "./recipe-store.js";
import type {
  OperatorRecipeCandidateStore,
  OperatorRecipeCandidateStoreRecord,
  UpsertOperatorRecipeCandidateInput,
} from "./recipe-candidate-store.js";

export class PrismaOperatorRecipeCandidateStore implements OperatorRecipeCandidateStore {
  private constructor(private readonly client: RegistryPrismaClient) {}

  static async fromEnv(): Promise<PrismaOperatorRecipeCandidateStore> {
    const client = createRegistryPrismaClient();
    await client.$connect();
    return new PrismaOperatorRecipeCandidateStore(client);
  }

  static fromClient(client: RegistryPrismaClient): PrismaOperatorRecipeCandidateStore {
    return new PrismaOperatorRecipeCandidateStore(client);
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }

  async upsert(
    input: UpsertOperatorRecipeCandidateInput,
  ): Promise<OperatorRecipeCandidateStoreRecord> {
    const key = recipeStoreKey(input.verb, input.domain);
    const domain = input.domain.toLowerCase();
    const now = new Date();
    const row = await this.client.operatorRecipeCandidateRecord.upsert({
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

  async findByKey(
    verb: string,
    domain: string,
  ): Promise<OperatorRecipeCandidateStoreRecord | null> {
    const row = await this.client.operatorRecipeCandidateRecord.findUnique({
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

  async listCandidates(limit: number): Promise<OperatorRecipeCandidateStoreRecord[]> {
    const rows = await this.client.operatorRecipeCandidateRecord.findMany({
      orderBy: { submitted_at: "asc" },
      take: limit,
    });
    return rows.map((row) => ({
      key: row.key,
      verb: row.verb,
      domain: row.domain,
      payload: parseOperatorRecipe(row.payload_json),
      schema_version: row.schema_version,
      submitted_at: row.submitted_at,
      updated_at: row.updated_at,
    }));
  }

  async remove(verb: string, domain: string): Promise<boolean> {
    try {
      await this.client.operatorRecipeCandidateRecord.delete({
        where: { key: recipeStoreKey(verb, domain) },
      });
      return true;
    } catch {
      return false;
    }
  }
}
