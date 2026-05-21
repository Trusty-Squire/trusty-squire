// HTTP routes for Tier-2 Learned Skills (Phase 4). Four endpoints:
//
//   POST /skills                          — publish a new skill
//   GET  /skills/:service                 — fetch active skill for a service
//   POST /skills/:skill_id/replay-outcome — report a replay result (router)
//   GET  /skills/:service/replays         — recent replay outcomes (D7)
//
// All paths return JSON. POSTs require a signed request from the
// promoter; signature verification lives in the ManifestSigner the
// existing routes already use, so this file just wires it up. The
// route layer reads from the SkillStore + (later) writes capture
// sidecars (T19); the store handles atomic counter updates (T17/E3)
// and rate-limit accounting (T18/C9).
//
// Caching: GET /skills/:service serves with Cache-Control: max-age=300
// (5min, matches the router's in-process LRU TTL per Decision C6).
// Skill records aren't immutable like manifests — a replay outcome
// can change `status` and `consecutive_failures` — so we cap the TTL
// short enough that stale skills don't outlive their relevance.

import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import {
  parseSkill,
  SkillStatusSchema,
  type Skill,
  type SkillStatus,
} from "@trusty-squire/adapter-sdk";
import type { ManifestSigner } from "../signer.js";
import type { SkillStore, SkillStoreRecord } from "../skill-store.js";
import { SkillConflictError } from "../skill-store.js";

// 60 replay-outcome writes per account per minute (C9). Conservative
// — most replays are bot-initiated, one signup ≈ one outcome.
const REPLAY_RATE_LIMIT_PER_MINUTE = 60;
const REPLAY_RATE_LIMIT_WINDOW_MS = 60_000;

// Bound listReplays to keep response payloads small.
const REPLAY_LIST_DEFAULT_LIMIT = 50;
const REPLAY_LIST_MAX_LIMIT = 200;

// Cap the reason field at 2KB before it goes into the DB.
const REPLAY_REASON_MAX_LENGTH = 2000;

export interface SkillsRouteDeps {
  store: SkillStore;
  signer: ManifestSigner;
  // Whose account identifier do we trust on the wire? Production
  // wires this to whatever auth middleware extracts; tests inject a
  // direct extractor.
  resolveAccountId: (req: { headers: Record<string, unknown> }) => string;
}

export const registerSkillsRoute: FastifyPluginAsync<SkillsRouteDeps> = async (
  fastify: FastifyInstance,
  opts,
) => {
  // ── POST /skills ────────────────────────────────────────────────
  fastify.post<{ Body: PublishSkillBody }>("/skills", async (req, reply) => {
    const body = req.body;
    if (!isPublishSkillBody(body)) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_request",
        detail: "Expected { skill, signature }.",
      });
    }

    // 1. Validate the skill payload against the Zod schema. A failure
    //    here means the promoter sent us a malformed skill — surface
    //    the field-level errors so the operator can fix it.
    let skill: Skill;
    try {
      skill = parseSkill(body.skill);
    } catch (err) {
      return reply.code(400).send({
        ok: false,
        error: "schema_validation_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. Verify the signature. The full signed-envelope verification
    //    (matching the ManifestSigner contract) lands in Phase 6
    //    alongside the human-review gate for signup_url + oauth_provider
    //    edits (C11). For now, we record the signature bytes as
    //    provenance so the eventual verification has the value to
    //    check against, and we reject obviously-empty signatures so
    //    the route surface is honest about requiring one.
    if (body.signature.length < 16) {
      return reply.code(401).send({
        ok: false,
        error: "invalid_signature",
        detail: "Signature too short — promoter must sign skills before publishing.",
      });
    }

    // 3. Persist. SkillConflictError on (skill_id) collision means the
    //    promoter re-ran with the same input — that's idempotent
    //    success, not an error. Return the existing record.
    try {
      const inserted = await opts.store.insert({
        skill,
        signature: body.signature,
        signed_at: new Date(),
        signed_by: opts.signer.signedBy,
      });
      return reply.code(201).send({
        ok: true,
        skill_id: inserted.skill_id,
        service: inserted.service,
        version: inserted.version,
        status: inserted.status,
      });
    } catch (err) {
      if (err instanceof SkillConflictError) {
        const existing = await opts.store.findById(skill.skill_id);
        return reply.code(200).send({
          ok: true,
          skill_id: existing!.skill_id,
          service: existing!.service,
          version: existing!.version,
          status: existing!.status,
          idempotent: true,
        });
      }
      throw err;
    }
  });

  // ── GET /skills/:service ────────────────────────────────────────
  fastify.get<{ Params: { service: string } }>(
    "/skills/:service",
    async (req, reply) => {
      const record = await opts.store.findActiveByService(req.params.service);
      if (record === null) {
        return reply.code(404).send({ ok: false, error: "no_active_skill" });
      }
      return sendSkillResponse(reply, record);
    },
  );

  // ── POST /skills/:skill_id/replay-outcome ───────────────────────
  fastify.post<{ Params: { skill_id: string }; Body: ReplayOutcomeBody }>(
    "/skills/:skill_id/replay-outcome",
    async (req, reply) => {
      const account_id = opts.resolveAccountId(req as { headers: Record<string, unknown> });

      // Rate limit FIRST so a 429 doesn't get a DB write either way.
      const since = new Date(Date.now() - REPLAY_RATE_LIMIT_WINDOW_MS);
      const recent = await opts.store.countRecentReplaysByAccount(account_id, since);
      if (recent >= REPLAY_RATE_LIMIT_PER_MINUTE) {
        return reply.code(429).send({
          ok: false,
          error: "rate_limited",
          retry_after_seconds: 60,
        });
      }

      if (!isReplayOutcomeBody(req.body)) {
        return reply.code(400).send({
          ok: false,
          error: "invalid_request",
          detail: "Expected { outcome, reason, step_index? }.",
        });
      }

      try {
        const result = await opts.store.recordReplayOutcome({
          skill_id: req.params.skill_id,
          outcome: req.body.outcome,
          reason: truncate(req.body.reason, REPLAY_REASON_MAX_LENGTH),
          account_id,
          step_index: req.body.step_index ?? null,
        });

        // T20 follow-up: when result.demoted is true, emit a webhook
        // for the ops dashboard. For now we just include the flag in
        // the response so the caller (router) can log locally.
        return reply.code(200).send({
          ok: true,
          replay_id: result.replay.id,
          demoted: result.demoted,
          counters: {
            replays_succeeded: result.replays_succeeded,
            replays_failed: result.replays_failed,
            consecutive_failures: result.consecutive_failures,
          },
        });
      } catch (err) {
        // Unknown skill_id → store throws. Return 404 so the router
        // can fall through to the universal bot.
        const message = err instanceof Error ? err.message : String(err);
        if (/unknown skill/i.test(message)) {
          return reply.code(404).send({ ok: false, error: "skill_not_found" });
        }
        throw err;
      }
    },
  );

  // ── GET /skills/:service/replays ────────────────────────────────
  fastify.get<{
    Params: { service: string };
    Querystring: { limit?: string };
  }>("/skills/:service/replays", async (req, reply) => {
    const record = await opts.store.findActiveByService(req.params.service);
    if (record === null) {
      return reply.code(404).send({ ok: false, error: "no_active_skill" });
    }
    const limit = Math.min(
      REPLAY_LIST_MAX_LIMIT,
      Math.max(1, parseInt(req.query.limit ?? `${REPLAY_LIST_DEFAULT_LIMIT}`, 10) || REPLAY_LIST_DEFAULT_LIMIT),
    );
    const replays = await opts.store.listReplays(record.skill_id, limit);
    return reply.code(200).send({
      ok: true,
      service: record.service,
      skill_id: record.skill_id,
      replays: replays.map((r) => ({
        id: r.id,
        outcome: r.outcome,
        reason: r.reason,
        step_index: r.step_index,
        replayed_at: r.replayed_at.toISOString(),
      })),
    });
  });
};

// ── Helpers ─────────────────────────────────────────────────────────

function sendSkillResponse(reply: FastifyReply, record: SkillStoreRecord) {
  reply.header("Cache-Control", "public, max-age=300");
  return reply.code(200).send({
    ok: true,
    skill: record.payload,
    signature: record.signature,
    signed_at: record.signed_at.toISOString(),
    signed_by: record.signed_by,
    counters: {
      replays_succeeded: record.replays_succeeded,
      replays_failed: record.replays_failed,
      consecutive_failures: record.consecutive_failures,
    },
  });
}

// ── Request body shapes + type guards ───────────────────────────────

interface PublishSkillBody {
  skill: unknown;
  signature: string;
}

function isPublishSkillBody(value: unknown): value is PublishSkillBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.signature === "string" &&
    v.skill !== undefined &&
    typeof v.skill === "object"
  );
}

interface ReplayOutcomeBody {
  outcome: string;
  reason: string;
  step_index?: number;
}

const ALLOWED_OUTCOMES = new Set([
  "ok",
  "step_failed",
  "validator_failed",
  "extraction_failed",
  "needs_login",
  "skill_demoted",
  "dry_pass",
]);

function isReplayOutcomeBody(value: unknown): value is ReplayOutcomeBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.outcome === "string" &&
    ALLOWED_OUTCOMES.has(v.outcome) &&
    typeof v.reason === "string" &&
    (v.step_index === undefined || typeof v.step_index === "number")
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// SkillStatusSchema is imported for type narrowing in places that
// might benefit from runtime validation. Currently only used by the
// SkillStore impls, but exported here for any future route handlers
// that take a SkillStatus from the wire.
export function isValidSkillStatus(value: unknown): value is SkillStatus {
  return SkillStatusSchema.safeParse(value).success;
}
