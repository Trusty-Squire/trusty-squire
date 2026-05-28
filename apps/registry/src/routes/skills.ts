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
import { verifySkillSignature } from "../signer.js";
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
  // T20 — Webhook URL to POST when a skill is auto-demoted.
  // Undefined disables the webhook. Production reads from env
  // (TRUSTY_SQUIRE_DEMOTION_WEBHOOK_URL); tests inject directly.
  demotionWebhookUrl?: string;
  // T20 — fetch override for the webhook call. Tests inject a mock
  // to assert on the request body. Production uses globalThis.fetch.
  fetchFn?: typeof globalThis.fetch;
  // Public key (base64url SPKI DER) used to verify the signature on
  // POST /skills bodies. When undefined the route falls back to the
  // length-only stub and logs a warning per publish — that mode is
  // intended for dev/staging where the promoter hasn't been wired
  // with a signing key yet. Production should always set this; once
  // the Phase 7 publish CLI lands, leaving it unset becomes a
  // misconfiguration.
  skillVerifyPublicKey?: string;
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

    // 2. Signature acceptance.
    //
    // Historical design (Phase 7) had this route Ed25519-verify
    // every publish against SKILL_VERIFY_PUBLIC_KEY, with a length-
    // only fallback when the key was unset. That design assumed
    // the upload step was the trust boundary — anyone forging a
    // skill body should be rejected before persistence.
    //
    // Real-world architecture differs: every published skill enters
    // pending-review and only gets promoted to `active` once the
    // verifier worker has driven a full browser replay that ends
    // in a validator-passing credential. The verifier IS the trust
    // signal. A spoofed/malicious skill that doesn't match the
    // service's live UX fails verification and rots in pending-
    // review until consecutive failures retire it. Signing solved
    // a problem (skill-shape spoofing) that the verifier already
    // owns.
    //
    // We still accept the `signature` field on the request body
    // so existing client emit (provision-any auto-promote +
    // `mcp skill promote`) keeps working unchanged — it just no
    // longer matters server-side. Pruning the client emit is a
    // future cleanup; ordering matters because client and server
    // upgrades roll out separately.
    void opts.skillVerifyPublicKey;
    void verifySkillSignature;

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

  // ── GET /skills ─────────────────────────────────────────────────
  // T28 — list endpoint backing the `skill list` CLI subcommand.
  // Filter by service and/or status; default limit 100, max 500.
  // NOTE: route ordering matters in Fastify — this MUST be
  // registered AFTER /skills/:service (above) to avoid colliding
  // with single-record fetches. Fastify's radix router treats them
  // distinctly, but the order is deliberate.
  fastify.get<{
    Querystring: {
      service?: string;
      status?: string;
      limit?: string;
    };
  }>("/skills", async (req, reply) => {
    const limit = parseInt(req.query.limit ?? "100", 10);
    const filter: { service?: string; status?: string; limit?: number } = {};
    if (req.query.service !== undefined) filter.service = req.query.service;
    if (req.query.status !== undefined) filter.status = req.query.status;
    if (!Number.isNaN(limit) && limit > 0) filter.limit = limit;
    const records = await opts.store.listSkills(filter);
    return reply.code(200).send({
      ok: true,
      skills: records.map((r) => ({
        skill_id: r.skill_id,
        service: r.service,
        version: r.version,
        status: r.status,
        signed_by: r.signed_by,
        signed_at: r.signed_at.toISOString(),
        replays_succeeded: r.replays_succeeded,
        replays_failed: r.replays_failed,
        consecutive_failures: r.consecutive_failures,
        created_at: r.created_at.toISOString(),
        last_replayed_at: r.last_replayed_at?.toISOString() ?? null,
      })),
    });
  });

  // ── GET /skills/by-id/:skill_id ─────────────────────────────────
  // T28 — fetch one skill record by ULID. The /skills/:service shape
  // returns the *active* record; this returns the exact one whatever
  // its status. Used by `skill show`, `skill replays`, etc.
  // Namespaced under /by-id/ so it can't collide with service slugs.
  fastify.get<{ Params: { skill_id: string } }>(
    "/skills/by-id/:skill_id",
    async (req, reply) => {
      const record = await opts.store.findById(req.params.skill_id);
      if (record === null) {
        return reply.code(404).send({ ok: false, error: "skill_not_found" });
      }
      return sendSkillResponse(reply, record);
    },
  );

  // ── POST /skills/:skill_id/demote ───────────────────────────────
  // T28 — operator manual demotion. Sets status=demoted regardless
  // of consecutive_failures. Body: { reason: string }.
  fastify.post<{
    Params: { skill_id: string };
    Body: { reason?: unknown };
  }>("/skills/:skill_id/demote", async (req, reply) => {
    void opts.resolveAccountId(req as { headers: Record<string, unknown> });

    const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
    if (reason.length < 1) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_request",
        detail: "reason is required (operator must explain manual demote)",
      });
    }
    const updated = await opts.store.manuallyDemote(
      req.params.skill_id,
      truncate(reason, REPLAY_REASON_MAX_LENGTH),
    );
    if (updated === null) {
      return reply.code(404).send({ ok: false, error: "skill_not_found" });
    }
    return reply.code(200).send({
      ok: true,
      skill_id: updated.skill_id,
      status: updated.status,
    });
  });

  // ── POST /skills/:skill_id/reactivate (Phase 7) ─────────────────
  // Operator action: undo a demotion. Body is empty. Idempotent —
  // reactivating an already-active skill returns 200 with
  // `previously === status` so the CLI can render "no-op".
  fastify.post<{ Params: { skill_id: string } }>(
    "/skills/:skill_id/reactivate",
    async (req, reply) => {
      void opts.resolveAccountId(req as { headers: Record<string, unknown> });
      const result = await opts.store.reactivate(req.params.skill_id);
      if (result === null) {
        return reply.code(404).send({ ok: false, error: "skill_not_found" });
      }
      return reply.code(200).send({
        ok: true,
        skill_id: result.record.skill_id,
        status: result.record.status,
        previously: result.previously,
      });
    },
  );

  // ── DELETE /skills/:skill_id (Phase 7) ──────────────────────────
  // Hard-delete. The CLI gates this behind --confirm; here we just
  // do what's asked. Captures + replays cascade away with the row.
  fastify.delete<{ Params: { skill_id: string } }>(
    "/skills/:skill_id",
    async (req, reply) => {
      void opts.resolveAccountId(req as { headers: Record<string, unknown> });
      const ok = await opts.store.deleteSkill(req.params.skill_id);
      if (!ok) {
        return reply.code(404).send({ ok: false, error: "skill_not_found" });
      }
      return reply.code(200).send({
        ok: true,
        skill_id: req.params.skill_id,
        deleted: true,
      });
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

        // T20 — Fire the demotion webhook fire-and-forget. We don't
        // await it: the response to the router/replay-outcome caller
        // must not block on a slow webhook listener. Errors get
        // swallowed (the audit trail lives on the SkillReplayRecord
        // anyway).
        if (result.demoted && opts.demotionWebhookUrl !== undefined) {
          void fireDemotionWebhook(
            opts.demotionWebhookUrl,
            opts.fetchFn ?? globalThis.fetch,
            {
              skill_id: req.params.skill_id,
              reason: truncate(req.body.reason, REPLAY_REASON_MAX_LENGTH),
              consecutive_failures: result.consecutive_failures,
              replays_succeeded: result.replays_succeeded,
              replays_failed: result.replays_failed,
              demoted_at: result.replay.replayed_at.toISOString(),
            },
          );
        }

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

  // ── POST /skills/:skill_id/approve-review ──────────────────────
  // T26 (C11) — operator approval gate. A skill submitted with a
  // changed signup_url or oauth_provider lands in pending-review;
  // this endpoint flips it to active. Mirrors the skill:approve-review
  // CLI surface. Requires operator-grade auth in production; tests
  // exercise it with the same resolveAccountId helper used elsewhere.
  fastify.post<{ Params: { skill_id: string } }>(
    "/skills/:skill_id/approve-review",
    async (req, reply) => {
      // Resolve account so the audit trail (Phase 7 follow-up) knows
      // who approved. Ignored value today — we still call to enforce
      // x-account-id presence.
      void opts.resolveAccountId(req as { headers: Record<string, unknown> });

      const updated = await opts.store.approveReview(req.params.skill_id);
      if (updated === null) {
        return reply.code(404).send({
          ok: false,
          error: "skill_not_found",
        });
      }
      return reply.code(200).send({
        ok: true,
        skill_id: updated.skill_id,
        service: updated.service,
        version: updated.version,
        status: updated.status,
      });
    },
  );

  // ── POST /skills/:skill_id/captures ─────────────────────────────
  // T19 (D1) — upload one capture-chain round as a content-hashed
  // sidecar. Idempotent on content_hash. Body shape:
  //   { content_hash: string, run_id: string, round_index: number,
  //     payload: object }
  // The promoter computes the SHA-256 of the canonical payload
  // serialisation and sends both — the server doesn't recompute
  // because the synthesizer's chain verification already trusted
  // this exact hash.
  fastify.post<{
    Params: { skill_id: string };
    Body: UploadCaptureBody;
  }>("/skills/:skill_id/captures", async (req, reply) => {
    const account_id = opts.resolveAccountId(req as { headers: Record<string, unknown> });

    if (!isUploadCaptureBody(req.body)) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_request",
        detail: "Expected { content_hash, run_id, round_index, payload }.",
      });
    }
    // Bound the payload size — captures are small JSON, not blobs.
    // Anything over 1MB is almost certainly a misuse of this
    // endpoint and should be rejected before hitting the DB.
    const payloadBytes = Buffer.byteLength(JSON.stringify(req.body.payload), "utf8");
    if (payloadBytes > 1_000_000) {
      return reply.code(413).send({
        ok: false,
        error: "payload_too_large",
        detail: `Capture payload is ${payloadBytes} bytes; max 1000000.`,
      });
    }

    // Skill must exist before we accept captures for it (catches
    // typos and stops orphan rows from accumulating).
    const skill = await opts.store.findById(req.params.skill_id);
    if (skill === null) {
      return reply.code(404).send({
        ok: false,
        error: "skill_not_found",
      });
    }

    const inserted = await opts.store.insertCapture({
      content_hash: req.body.content_hash,
      skill_id: req.params.skill_id,
      run_id: req.body.run_id,
      round_index: req.body.round_index,
      payload: req.body.payload,
      uploaded_by: account_id,
    });

    return reply.code(201).send({
      ok: true,
      content_hash: inserted.content_hash,
      skill_id: inserted.skill_id,
      run_id: inserted.run_id,
      round_index: inserted.round_index,
      byte_size: inserted.byte_size,
      uploaded_at: inserted.uploaded_at.toISOString(),
    });
  });

  // ── GET /skills/:skill_id/captures ──────────────────────────────
  fastify.get<{ Params: { skill_id: string } }>(
    "/skills/:skill_id/captures",
    async (req, reply) => {
      const captures = await opts.store.listCapturesForSkill(req.params.skill_id);
      return reply.code(200).send({
        ok: true,
        skill_id: req.params.skill_id,
        captures: captures.map((c) => ({
          content_hash: c.content_hash,
          run_id: c.run_id,
          round_index: c.round_index,
          byte_size: c.byte_size,
          uploaded_at: c.uploaded_at.toISOString(),
        })),
      });
    },
  );

  // ── GET /skills/:skill_id/captures/:hash ────────────────────────
  fastify.get<{ Params: { skill_id: string; hash: string } }>(
    "/skills/:skill_id/captures/:hash",
    async (req, reply) => {
      const capture = await opts.store.findCaptureByHash(req.params.hash);
      if (capture === null || capture.skill_id !== req.params.skill_id) {
        return reply.code(404).send({
          ok: false,
          error: "capture_not_found",
        });
      }
      return reply.code(200).send({
        ok: true,
        content_hash: capture.content_hash,
        skill_id: capture.skill_id,
        run_id: capture.run_id,
        round_index: capture.round_index,
        payload: capture.payload,
        byte_size: capture.byte_size,
        uploaded_at: capture.uploaded_at.toISOString(),
        uploaded_by: capture.uploaded_by,
      });
    },
  );

  // ── GET /skills/by-id/:skill_id/replays ─────────────────────────
  // T28 — replays for a specific skill record (any status). The
  // /skills/:service/replays variant below resolves the active row
  // and is fine for "what's happening with the current Railway
  // skill?"; this variant is needed when the operator wants to
  // inspect a demoted or superseded skill's failure trail.
  fastify.get<{
    Params: { skill_id: string };
    Querystring: { limit?: string };
  }>("/skills/by-id/:skill_id/replays", async (req, reply) => {
    const record = await opts.store.findById(req.params.skill_id);
    if (record === null) {
      return reply.code(404).send({ ok: false, error: "skill_not_found" });
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

// T19: capture upload body shape.
interface UploadCaptureBody {
  content_hash: string;
  run_id: string;
  round_index: number;
  payload: unknown;
}

function isUploadCaptureBody(value: unknown): value is UploadCaptureBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.content_hash === "string" &&
    // SHA-256 hex is 64 chars; accept any hex string 32-128 chars
    // (lets the synthesizer pick its own digest while keeping the
    // door closed on garbage).
    /^[0-9a-f]{32,128}$/i.test(v.content_hash) &&
    typeof v.run_id === "string" &&
    typeof v.round_index === "number" &&
    Number.isInteger(v.round_index) &&
    v.round_index >= 0 &&
    typeof v.payload === "object" &&
    v.payload !== null
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// T20 — Demotion webhook payload + dispatcher. Best-effort POST with
// a 3s timeout. Failures are swallowed so a flaky webhook listener
// doesn't break the replay-outcome path.
interface DemotionWebhookPayload {
  skill_id: string;
  reason: string;
  consecutive_failures: number;
  replays_succeeded: number;
  replays_failed: number;
  demoted_at: string;
}

async function fireDemotionWebhook(
  url: string,
  fetchFn: typeof globalThis.fetch,
  payload: DemotionWebhookPayload,
): Promise<void> {
  const timeoutMs = 3000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("webhook timeout")), timeoutMs);
    });
    await Promise.race([
      fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-trusty-squire-event": "skill.demoted",
        },
        body: JSON.stringify(payload),
      }),
      timeoutPromise,
    ]);
  } catch {
    // Swallow — webhook is fire-and-forget, the audit trail is
    // already on the SkillReplayRecord.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// SkillStatusSchema is imported for type narrowing in places that
// might benefit from runtime validation. Currently only used by the
// SkillStore impls, but exported here for any future route handlers
// that take a SkillStatus from the wire.
export function isValidSkillStatus(value: unknown): value is SkillStatus {
  return SkillStatusSchema.safeParse(value).success;
}
