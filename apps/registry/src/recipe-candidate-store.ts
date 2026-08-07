// Storage layer for the CANDIDATE half of shared Operator Recipes.
// `POST /recipes` is unauthenticated (only the client- and server-side
// isRecipeShareEligible gate stands between a caller and a write), so
// everything it writes lands here — NEVER in the live store
// (recipe-store.ts) that operate_use / GET /recipes/:verb/:domain reads.
// A candidate is never replayed, so last-write-wins across untrusted
// callers is safe by construction: the worst an attacker can do is
// overwrite a candidate nobody is serving. Only the admin-bearer-gated
// promotion route (routes/admin-recipes.ts) reads a candidate and, if it
// passes vetting, copies it into the live store.
//
// Two implementations live alongside this interface:
//   - InMemoryOperatorRecipeCandidateStore (recipe-candidate-store-memory.ts)
//   - PrismaOperatorRecipeCandidateStore   (prisma-recipe-candidate-store.ts)
// Tests use the in-memory store; production wires up Prisma.

import type { OperatorRecipe } from "@trusty-squire/recipe-schema";

export interface OperatorRecipeCandidateStoreRecord {
  key: string;
  verb: string;
  domain: string;
  payload: OperatorRecipe;
  schema_version: number;
  submitted_at: Date;
  updated_at: Date;
}

export interface UpsertOperatorRecipeCandidateInput {
  verb: string;
  domain: string;
  recipe: OperatorRecipe;
}

export interface OperatorRecipeCandidateStore {
  /** Write (or replace) the candidate for a (verb, domain) key. Last-write-wins. */
  upsert(input: UpsertOperatorRecipeCandidateInput): Promise<OperatorRecipeCandidateStoreRecord>;

  /** Fetch the candidate for a (verb, domain) key, or null if none exists. */
  findByKey(verb: string, domain: string): Promise<OperatorRecipeCandidateStoreRecord | null>;

  /** List pending candidates, oldest-submitted-first, for the admin queue. */
  listCandidates(limit: number): Promise<OperatorRecipeCandidateStoreRecord[]>;

  /** Remove a candidate — after a promotion decision (accepted or rejected). */
  remove(verb: string, domain: string): Promise<boolean>;
}
