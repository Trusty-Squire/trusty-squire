// HTTP routes for shared Operator Recipes (replay-registry-share). Two
// endpoints, split across a candidate/live trust boundary:
//
//   POST /recipes             — submit a CANDIDATE for its (verb, domain) key
//   GET  /recipes/:verb/:domain — fetch the LIVE (promoted) recipe for a key
//
// POST is unauthenticated (only the isRecipeShareEligible gate stands
// between a caller and a write) and writes ONLY to the candidate store —
// never to the live store GET reads from. A candidate is never replayed,
// so unauthenticated last-write-wins to it is safe by construction: the
// worst an attacker can do is overwrite a candidate nobody is serving yet.
// Promoting a candidate to live is a SEPARATE, admin-bearer-gated step —
// see routes/admin-recipes.ts. This is the same candidate + promotion
// shape the Skill registry uses (pending-review → active), simplified for
// recipes' narrower needs. See docs/ARCHITECTURE.md.
//
// The eligibility gate (isRecipeShareEligible) is still applied here as
// defense-in-depth against a buggy/bypassed client — a candidate that
// leaks PII/secrets is refused just as it would be at the live tier. A
// rejected publish is a 400, not a 500 — the caller falls back to
// local-only storage.

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  OperatorVerbSchema,
  parseOperatorRecipe,
  isRecipeShareEligible,
  type OperatorRecipe,
} from "@trusty-squire/recipe-schema";
import type { OperatorRecipeStore } from "../recipe-store.js";
import type { OperatorRecipeCandidateStore } from "../recipe-candidate-store.js";

export interface RecipesRouteDeps {
  // The live/promoted store — GET reads only from here.
  store: OperatorRecipeStore;
  // The candidate store — POST writes only here.
  candidateStore: OperatorRecipeCandidateStore;
}

interface PublishRecipeBody {
  recipe?: unknown;
}

function isPublishRecipeBody(value: unknown): value is PublishRecipeBody {
  return typeof value === "object" && value !== null && "recipe" in value;
}

export const registerRecipesRoute: FastifyPluginAsync<RecipesRouteDeps> = async (
  fastify: FastifyInstance,
  opts,
) => {
  // ── POST /recipes ──────────────────────────────────────────────
  fastify.post<{ Body: PublishRecipeBody }>("/recipes", async (req, reply) => {
    const body = req.body;
    if (!isPublishRecipeBody(body)) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_request",
        detail: "Expected { recipe }.",
      });
    }

    let recipe: OperatorRecipe;
    try {
      recipe = parseOperatorRecipe(body.recipe);
    } catch (err) {
      return reply.code(400).send({
        ok: false,
        error: "schema_validation_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    if (recipe.verb === undefined || recipe.domain === undefined) {
      return reply.code(400).send({
        ok: false,
        error: "missing_key",
        detail: "A shared recipe must carry both verb and domain.",
      });
    }

    // Re-run the share-eligibility gate server-side. The client is
    // expected to have already refused to publish an ineligible recipe —
    // this is the backstop that keeps even the CANDIDATE pool safe even
    // if a client is buggy, stale, or bypassed entirely.
    const eligibility = isRecipeShareEligible(recipe);
    if (!eligibility.eligible) {
      return reply.code(400).send({
        ok: false,
        error: "not_share_eligible",
        reasons: eligibility.reasons,
      });
    }

    const record = await opts.candidateStore.upsert({
      verb: recipe.verb,
      domain: recipe.domain,
      recipe,
    });
    return reply.code(201).send({
      ok: true,
      key: record.key,
      verb: record.verb,
      domain: record.domain,
      status: "pending-review",
    });
  });

  // ── GET /recipes/:verb/:domain ──────────────────────────────────
  // Reads ONLY the live/promoted store. A key with only a pending
  // candidate — no promoted row yet — 404s exactly like a key nobody has
  // ever written to; the caller (operate_use) falls back to local storage
  // or cold driving either way.
  fastify.get<{ Params: { verb: string; domain: string } }>(
    "/recipes/:verb/:domain",
    async (req, reply) => {
      const verbParse = OperatorVerbSchema.safeParse(req.params.verb);
      if (!verbParse.success) {
        return reply.code(400).send({ ok: false, error: "invalid_verb" });
      }
      const domain = req.params.domain.toLowerCase().trim();
      if (domain.length === 0) {
        return reply.code(400).send({ ok: false, error: "invalid_domain" });
      }
      const record = await opts.store.findByKey(verbParse.data, domain);
      if (record === null) {
        return reply.code(404).send({ ok: false, error: "no_recipe_for_key" });
      }
      return reply.code(200).send({
        ok: true,
        key: record.key,
        recipe: record.payload,
        updated_at: record.updated_at.toISOString(),
      });
    },
  );
};
