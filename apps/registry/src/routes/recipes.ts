// HTTP routes for shared Operator Recipes (replay-registry-share). Two
// endpoints:
//
//   POST /recipes             — publish a recipe for its (verb, domain) key
//   GET  /recipes/:verb/:domain — fetch the recipe stored for a key
//
// Deliberately minimal compared to routes/skills.ts: no signing, no
// health-counter/promotion lifecycle. The trust boundary is the
// share-eligibility gate (isRecipeShareEligible) — applied by the mcp
// client BEFORE it ever calls this route, and re-applied here as
// defense-in-depth so a buggy/bypassed client can't smuggle a
// user-specific literal or an earned credential into the shared registry.
// A rejected publish is a 400, not a 500 — it's an expected outcome for
// any recipe that isn't safely shareable, and the caller falls back to
// local-only storage.

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  OperatorVerbSchema,
  parseOperatorRecipe,
  isRecipeShareEligible,
  type OperatorRecipe,
} from "@trusty-squire/recipe-schema";
import type { OperatorRecipeStore } from "../recipe-store.js";

export interface RecipesRouteDeps {
  store: OperatorRecipeStore;
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
    // this is the backstop that keeps the shared registry safe even if a
    // client is buggy, stale, or bypassed entirely.
    const eligibility = isRecipeShareEligible(recipe);
    if (!eligibility.eligible) {
      return reply.code(400).send({
        ok: false,
        error: "not_share_eligible",
        reasons: eligibility.reasons,
      });
    }

    const record = await opts.store.upsert({
      verb: recipe.verb,
      domain: recipe.domain,
      recipe,
    });
    return reply.code(201).send({
      ok: true,
      key: record.key,
      verb: record.verb,
      domain: record.domain,
    });
  });

  // ── GET /recipes/:verb/:domain ──────────────────────────────────
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
