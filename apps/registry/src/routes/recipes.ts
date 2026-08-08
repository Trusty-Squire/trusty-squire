// HTTP routes for shared Operator Recipes (replay-serve-live-domainlock).
// Two endpoints:
//
//   POST /recipes             — write a recipe LIVE for its (verb, domain) key
//   GET  /recipes/:verb/:domain — fetch the live recipe for a key
//
// POST is unauthenticated — a recipe becomes replayable by any install the
// instant this route accepts it. There is no candidate/promotion tier.
// The primary boundary between an unauthenticated write and another user's
// replay browser is the HARD DOMAIN-LOCK (recipeDomainLockViolations): every
// entry_url / allowed_hosts entry / goto+allow_host target must resolve to
// the recipe's own eTLD+1, checked here and re-checked at replay time by
// the mcp client. The share-eligibility gate (isRecipeShareEligible) is
// the second layer, guarding against baked-in user data rather than
// off-domain navigation. A rejected publish is a 400, not a 500 — the
// caller falls back to local-only storage. The complete contract is owned by
// docs/DESIGN-replay-engine.md.

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  OperatorVerbSchema,
  parseOperatorRecipe,
  isRecipeShareEligible,
  recipeDomainLockViolations,
  isCheckoutShapeKey,
  type OperatorRecipe,
} from "@trusty-squire/recipe-schema";
import type { OperatorRecipeStore } from "../recipe-store.js";

// Per-IP rolling-hour cap on recipe submission. POST /recipes is
// unauthenticated and every accepted body upserts a DB row, so without a cap
// a single source can flood the served pool. A legit install submits one
// recipe per completed operator task — a handful per hour at most — so 30
// is generous. Same sliding-window style as UPLOAD_RATE_LIMIT_PER_HOUR
// (extract-failure-store.ts); in-memory / single-instance like the API's
// INSTALL_IP_HOURLY_LIMIT backstop.
export const RECIPE_SUBMIT_IP_HOURLY_LIMIT = 30;
const RECIPE_SUBMIT_WINDOW_MS = 60 * 60 * 1000;

// Real client IP behind Fly's proxy — req.ip is the proxy, so key off
// fly-client-ip, then the first x-forwarded-for hop (same resolution the
// API's install route uses).
function clientIp(req: FastifyRequest): string {
  const fly = req.headers["fly-client-ip"];
  if (typeof fly === "string" && fly.trim().length > 0) return fly.trim();
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0]!.trim();
  return req.ip ?? "unknown";
}

// Cheap hostname-plausibility check on the recipe's (eTLD+1) domain key —
// not DNS or PSL registrability, just "could this be a registrable
// hostname": dot-separated labels of [a-z0-9-] without edge hyphens, and an
// alphabetic TLD. A legit client derives the domain from a real URL, so
// anything this rejects is junk that would only pollute the served pool.
//
// replay-per-leg-signature: the key slot also accepts a CHECKOUT-LEG shape
// key (`shape:<sha256 hex>`, see checkoutFieldSetSignature in
// @trusty-squire/recipe-schema) — a checkout page's field-name-set
// signature, not a hostname at all. It's checked explicitly here rather
// than disguised as a fake hostname so this function's contract stays
// honest: "a plausible recipe key domain-slot", either form.
const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export function isPlausibleRecipeDomain(domain: string): boolean {
  if (isCheckoutShapeKey(domain)) return true;
  if (domain.length === 0 || domain.length > 253) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => DOMAIN_LABEL.test(label))) return false;
  const tld = labels[labels.length - 1]!;
  return /^[a-z]{2,}$/.test(tld) || tld.startsWith("xn--");
}

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
  const submitHits = new Map<string, number[]>();
  function overSubmitRate(ip: string): boolean {
    const nowMs = Date.now();
    const cutoff = nowMs - RECIPE_SUBMIT_WINDOW_MS;
    const recent = (submitHits.get(ip) ?? []).filter((t) => t > cutoff);
    if (recent.length >= RECIPE_SUBMIT_IP_HOURLY_LIMIT) {
      submitHits.set(ip, recent);
      return true;
    }
    recent.push(nowMs);
    submitHits.set(ip, recent);
    return false;
  }

  // ── POST /recipes ──────────────────────────────────────────────
  fastify.post<{ Body: PublishRecipeBody }>("/recipes", async (req, reply) => {
    if (overSubmitRate(clientIp(req))) {
      return reply.code(429).send({
        ok: false,
        error: "rate_limited",
        scope: "ip",
        limit_per_hour: RECIPE_SUBMIT_IP_HOURLY_LIMIT,
      });
    }
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

    if (!isPlausibleRecipeDomain(recipe.domain.toLowerCase())) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_domain",
        detail: "The recipe domain is not a plausible hostname.",
      });
    }

    // The primary safety control: every navigation target the recipe could
    // ever drive the browser to must stay on its own site. Checked BEFORE
    // eligibility — a recipe that fails this can never become live
    // regardless of how clean its data is.
    const domainLockViolations = recipeDomainLockViolations(recipe);
    if (domainLockViolations.length > 0) {
      return reply.code(400).send({
        ok: false,
        error: "domain_lock_violation",
        violations: domainLockViolations,
      });
    }

    // Re-run the share-eligibility gate server-side. The client is
    // expected to have already refused to publish an ineligible recipe —
    // this is the backstop that keeps the served pool safe even if a
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
      status: "live",
    });
  });

  // ── GET /recipes/:verb/:domain ──────────────────────────────────
  // A key nobody has ever written to 404s exactly like it always has; the
  // caller (operate_use) falls back to local storage or cold driving
  // either way.
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
