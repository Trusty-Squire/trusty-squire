// Admin routes — operator-only endpoints that drive the promotion half of
// shared Operator Recipes (replay-registry-share). Mirrors the shape
// routes/admin.ts already uses for the Skill verifier worker
// (GET .../queue + POST .../outcome), simplified: recipes have no replay-
// based verifier loop in this repo, so promotion is a direct accept/reject
// decision rather than an outcome report.
//
//   GET  /admin/recipe-candidates                        — what's pending
//   POST /admin/recipes/:verb/:domain/promote             — accept a candidate live
//   POST /admin/recipes/:verb/:domain/reject               — discard a candidate
//
// Promotion is pinned to the reviewed CONTENT, not just the (verb, domain)
// slot: the candidate list surfaces a sha256 content_digest per item, and
// promote requires the caller to echo the digest of the candidate it vetted.
// If the slot's current bytes no longer hash to that digest (an
// unauthenticated POST /recipes overwrote it between review and promote),
// the promote is refused with 409 not_current instead of silently shipping
// unvetted bytes live.
//
// Auth: the SAME shared bearer token routes/admin.ts uses (REGISTRY_ADMIN_BEARER).
// This is the intended integration point for the housekeeper (a separate
// repo, Trusty-Squire/trusty-squire-housekeeper — see CLAUDE.md) once it's
// wired to vet a candidate's navigation targets (entry_url/allowed_hosts/
// goto templates) before calling promote. Until that wiring lands, an
// operator can drive these endpoints directly with the admin bearer.

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { isRecipeShareEligible, type OperatorRecipe } from "@trusty-squire/recipe-schema";
import { bearerEquals } from "./admin.js";
import type { OperatorRecipeStore } from "../recipe-store.js";
import type { OperatorRecipeCandidateStore } from "../recipe-candidate-store.js";

export interface AdminRecipesRouteDeps {
  store: OperatorRecipeStore;
  candidateStore: OperatorRecipeCandidateStore;
  // The expected bearer value. When undefined the route refuses every
  // request — production must wire this from env. Tests inject directly.
  adminBearer?: string;
}

const CANDIDATE_LIST_DEFAULT_LIMIT = 20;
const CANDIDATE_LIST_MAX_LIMIT = 100;

// Both candidate stores re-parse the stored payload through
// parseOperatorRecipe on every read, so key order is schema-normalized and
// hashing the JSON serialization is deterministic for identical content.
export function recipeCandidateDigest(payload: OperatorRecipe): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

interface PromoteBody {
  promoted_by?: string;
  content_digest?: string;
}

function promotedByFrom(body: unknown): string {
  const raw = (body as PromoteBody | null | undefined)?.promoted_by;
  if (typeof raw !== "string" || raw.trim().length === 0) return "operator";
  return raw.trim().slice(0, 120);
}

function contentDigestFrom(body: unknown): string | null {
  const raw = (body as PromoteBody | null | undefined)?.content_digest;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  return raw.trim().toLowerCase();
}

export const registerAdminRecipesRoute: FastifyPluginAsync<AdminRecipesRouteDeps> = async (
  fastify: FastifyInstance,
  opts,
) => {
  function denyIfNotAdmin(req: { headers: Record<string, unknown> }, reply: FastifyReply): boolean {
    if (opts.adminBearer === undefined || opts.adminBearer.length === 0) {
      reply.code(503).send({ ok: false, error: "admin_not_configured" });
      return true;
    }
    const header = req.headers["authorization"];
    const presented = typeof header === "string" ? header : "";
    const expected = `Bearer ${opts.adminBearer}`;
    if (!bearerEquals(presented, expected)) {
      reply.code(401).send({ ok: false, error: "unauthorized" });
      return true;
    }
    return false;
  }

  // ── GET /admin/recipe-candidates ────────────────────────────────
  fastify.get<{ Querystring: { limit?: string } }>(
    "/admin/recipe-candidates",
    async (req, reply) => {
      if (denyIfNotAdmin(req as { headers: Record<string, unknown> }, reply)) return;
      const raw = req.query.limit;
      const limit =
        raw !== undefined
          ? Math.max(
              1,
              Math.min(CANDIDATE_LIST_MAX_LIMIT, Number(raw) || CANDIDATE_LIST_DEFAULT_LIMIT),
            )
          : CANDIDATE_LIST_DEFAULT_LIMIT;
      const candidates = await opts.candidateStore.listCandidates(limit);
      reply.send({
        ok: true,
        items: candidates.map((c) => ({
          key: c.key,
          verb: c.verb,
          domain: c.domain,
          recipe: c.payload,
          content_digest: recipeCandidateDigest(c.payload),
          submitted_at: c.submitted_at.toISOString(),
        })),
      });
    },
  );

  // ── POST /admin/recipes/:verb/:domain/promote ───────────────────
  fastify.post<{ Params: { verb: string; domain: string }; Body: PromoteBody }>(
    "/admin/recipes/:verb/:domain/promote",
    async (req, reply) => {
      if (denyIfNotAdmin(req as { headers: Record<string, unknown> }, reply)) return;
      const { verb, domain } = req.params;
      const candidate = await opts.candidateStore.findByKey(verb, domain.toLowerCase());
      if (candidate === null) {
        return reply.code(404).send({ ok: false, error: "no_candidate_for_key" });
      }
      // Pin the promotion to the vetted bytes. Without this, an
      // unauthenticated POST /recipes could swap the slot's content between
      // the operator's review and this call, and the promote would ship the
      // swapped payload live.
      const expectedDigest = contentDigestFrom(req.body);
      if (expectedDigest === null) {
        return reply.code(400).send({
          ok: false,
          error: "missing_content_digest",
          detail:
            "Promote requires the content_digest of the reviewed candidate " +
            "(from GET /admin/recipe-candidates).",
        });
      }
      if (recipeCandidateDigest(candidate.payload) !== expectedDigest) {
        return reply.code(409).send({
          ok: false,
          error: "not_current",
          detail:
            "The candidate's current content no longer matches the reviewed " +
            "digest — it was overwritten after review. Re-review before promoting.",
        });
      }
      // Re-check eligibility at promotion time too — a candidate written
      // against an older, laxer client build shouldn't get a free pass.
      const eligibility = isRecipeShareEligible(candidate.payload);
      if (!eligibility.eligible) {
        return reply.code(400).send({
          ok: false,
          error: "not_share_eligible",
          reasons: eligibility.reasons,
        });
      }
      const promoted = await opts.store.promote({
        verb: candidate.verb,
        domain: candidate.domain,
        recipe: candidate.payload,
        promotedBy: promotedByFrom(req.body),
      });
      await opts.candidateStore.remove(verb, domain.toLowerCase());
      reply.send({
        ok: true,
        key: promoted.key,
        promoted_at: promoted.promoted_at.toISOString(),
        promoted_by: promoted.promoted_by,
      });
    },
  );

  // ── POST /admin/recipes/:verb/:domain/reject ────────────────────
  fastify.post<{ Params: { verb: string; domain: string } }>(
    "/admin/recipes/:verb/:domain/reject",
    async (req, reply) => {
      if (denyIfNotAdmin(req as { headers: Record<string, unknown> }, reply)) return;
      const { verb, domain } = req.params;
      const removed = await opts.candidateStore.remove(verb, domain.toLowerCase());
      if (!removed) {
        return reply.code(404).send({ ok: false, error: "no_candidate_for_key" });
      }
      reply.send({ ok: true });
    },
  );
};
