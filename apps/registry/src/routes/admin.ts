// Admin routes — operator-only endpoints that drive the closed-loop
// strategy's verifier worker (Phase 3) and, in upcoming phases, the
// discovery worker (Phase 6) and dashboard (Phase 7).
//
//   GET  /admin/verifier/queue                       — what to verify next
//   POST /admin/skills/:skill_id/verifier-outcome   — record a verifier result
//
// Auth: a single shared bearer token (REGISTRY_ADMIN_BEARER env on
// the server, passed via `Authorization: Bearer <token>` by callers).
// Production should rotate this and scope it to operator machines;
// tests inject a known value via the deps argument.

import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import type {
  SkillStore,
  RecordVerifierOutcomeResult,
} from "../skill-store.js";
import type { BotFailureStore } from "../bot-failure-store.js";
import type { ProvisionEventStore } from "../provision-event-store.js";
import { mergeHarvestCandidates } from "../harvest-candidates.js";

// Constant-time bearer compare. Length mismatch returns false without
// invoking timingSafeEqual (which requires equal-length inputs).
export function bearerEquals(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(
    Buffer.from(presented, "utf8"),
    Buffer.from(expected, "utf8"),
  );
}

export interface AdminRouteDeps {
  store: SkillStore;
  // Closed-loop Phase 5: receives universal-bot failure telemetry,
  // serves discovery-candidate aggregations. When unset the bot-
  // telemetry routes return 503 (same shape as missing adminBearer).
  botFailureStore?: BotFailureStore;
  // Demand signal for the harvest queue (design Decision 4). When wired,
  // GET /admin/discovery-candidates merges per-service provision volume
  // with the failure-driven candidates. Optional — falls back to
  // failure-only candidates when unset.
  provisionEventStore?: ProvisionEventStore;
  // The expected bearer value. When undefined the route refuses every
  // request — production must wire this from env. Tests inject directly.
  adminBearer?: string;
  // T20 — same demotion webhook the existing replay-outcome route uses.
  // Fired when a verifier-driven freshness sweep auto-demotes a
  // currently-active skill. Failed sends are best-effort.
  demotionWebhookUrl?: string;
  fetchFn?: typeof globalThis.fetch;
  // Account resolver for the bot-telemetry POST. Reuses the same
  // x-account-id-header semantics as the other routes. The verifier
  // endpoints don't need this (admin-bearer is the auth there);
  // the telemetry POST is open to any authenticated account.
  resolveAccountId?: (req: { headers: Record<string, unknown> }) => string;
}

const VERIFIER_REASON_MAX_LENGTH = 2000;

export const registerAdminRoutes: FastifyPluginAsync<AdminRouteDeps> = async (
  fastify: FastifyInstance,
  opts,
) => {
  // ── auth gate ───────────────────────────────────────────────────
  function denyIfNotAdmin(
    req: { headers: Record<string, unknown> },
    reply: FastifyReply,
  ): boolean {
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

  // ── GET /admin/verifier/queue ──────────────────────────────────
  fastify.get<{ Querystring: { limit?: string } }>(
    "/admin/verifier/queue",
    async (req, reply) => {
      if (denyIfNotAdmin(req as { headers: Record<string, unknown> }, reply)) return;
      const raw = req.query.limit;
      const limit = raw !== undefined ? Math.max(1, Math.min(100, Number(raw) || 20)) : 20;
      const queue = await opts.store.listVerifierQueue({ limit });
      // Strip payload bytes from the list response — workers fetch
      // the full skill via GET /skills/by-id/:id after picking one
      // from the queue. Keeps this endpoint cheap to poll.
      reply.send({
        ok: true,
        items: queue.map((s) => ({
          skill_id: s.skill_id,
          service: s.service,
          version: s.version,
          status: s.status,
          verifier_succeeded: s.verifier_succeeded,
          verifier_failed: s.verifier_failed,
          consecutive_verifier_failures: s.consecutive_verifier_failures,
          last_verified_at: s.last_verified_at?.toISOString() ?? null,
          next_freshness_due_at: s.next_freshness_due_at?.toISOString() ?? null,
        })),
      });
    },
  );

  // ── POST /admin/skills/:skill_id/verifier-outcome ──────────────
  fastify.post<{
    Params: { skill_id: string };
    Body: VerifierOutcomeBody;
  }>(
    "/admin/skills/:skill_id/verifier-outcome",
    async (req, reply) => {
      if (denyIfNotAdmin(req as { headers: Record<string, unknown> }, reply)) return;
      if (!isVerifierOutcomeBody(req.body)) {
        return reply.code(400).send({
          ok: false,
          error: "invalid_request",
          detail: 'Expected { kind: "success" | "failure", reason: string, duration_ms?: number }.',
        });
      }
      const reason = req.body.reason.slice(0, VERIFIER_REASON_MAX_LENGTH);

      let result: RecordVerifierOutcomeResult;
      try {
        result = await opts.store.recordVerifierOutcome({
          skill_id: req.params.skill_id,
          kind: req.body.kind,
          reason,
          ...(req.body.failure_kind !== undefined
            ? { failure_kind: req.body.failure_kind }
            : {}),
          ...(req.body.duration_ms !== undefined
            ? { duration_ms: req.body.duration_ms }
            : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("unknown skill") || msg.includes("Record to update not found")) {
          return reply.code(404).send({ ok: false, error: "skill_not_found" });
        }
        throw err;
      }

      // Webhook fan-out — same wiring the replay-outcome route uses.
      // Only fires on terminal verifier transitions to keep noise low.
      if (
        opts.demotionWebhookUrl !== undefined &&
        (result.transition === "demoted" ||
          result.transition === "retired" ||
          result.transition === "quarantined")
      ) {
        const fetchFn = opts.fetchFn ?? globalThis.fetch;
        void fetchFn(opts.demotionWebhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: "verifier",
            transition: result.transition,
            skill_id: result.record.skill_id,
            service: result.record.service,
            version: result.record.version,
            reason,
          }),
        }).catch((webhookErr: unknown) => {
          fastify.log.warn(
            { err: webhookErr, skill_id: result.record.skill_id },
            "verifier demotion webhook failed",
          );
        });
      }

      reply.send({
        ok: true,
        transition: result.transition,
        skill_id: result.record.skill_id,
        service: result.record.service,
        status: result.record.status,
        verifier_succeeded: result.record.verifier_succeeded,
        verifier_failed: result.record.verifier_failed,
        consecutive_verifier_failures: result.record.consecutive_verifier_failures,
        last_verified_at: result.record.last_verified_at?.toISOString() ?? null,
        next_freshness_due_at: result.record.next_freshness_due_at?.toISOString() ?? null,
      });
    },
  );

  // ── POST /v1/telemetry/universal-bot-failure ───────────────────
  // Closed-loop Phase 5: end-user MCPs post terminal universal-bot
  // failures here. Used to seed the discovery worker's queue. Auth
  // is x-account-id (the same shape other user-facing endpoints
  // use) — admin bearer is NOT required because this is telemetry,
  // not authoritative state.
  fastify.post<{ Body: BotFailureBody }>(
    "/v1/telemetry/universal-bot-failure",
    async (req, reply) => {
      if (opts.botFailureStore === undefined) {
        return reply.code(503).send({ ok: false, error: "telemetry_not_configured" });
      }
      if (opts.resolveAccountId === undefined) {
        return reply.code(503).send({ ok: false, error: "telemetry_not_configured" });
      }
      const account_id = opts.resolveAccountId(req as { headers: Record<string, unknown> });
      // Reject anonymous posts — without an authenticated account_id
      // we can't enforce the ≥3 DISTINCT-accounts gate that protects
      // the discovery queue from poisoning. Any caller can produce
      // an unlimited stream of fabricated account_ids on the wire
      // anyway, but rejecting "anonymous" lifts the floor: now the
      // attacker has to forge MULTIPLE machine tokens, not just
      // hit the URL with no auth.
      if (account_id === "anonymous" || account_id.length === 0) {
        return reply.code(401).send({
          ok: false,
          error: "unauthorized",
          detail: "telemetry requires an authenticated account (x-account-id header).",
        });
      }
      if (!isBotFailureBody(req.body)) {
        return reply.code(400).send({
          ok: false,
          error: "invalid_request",
          detail: "Expected { service, error_kind, reason, mcp_version }.",
        });
      }
      // Per-account rate limit — 60 telemetry posts per minute.
      // Conservative; a runaway bot loop on one user's machine
      // shouldn't be able to dominate the discovery queue.
      const since = new Date(Date.now() - 60_000);
      const recent = await opts.botFailureStore.countRecentByAccount(
        account_id,
        since,
      );
      if (recent >= 60) {
        return reply.code(429).send({
          ok: false,
          error: "rate_limited",
          detail: "max 60 telemetry posts per minute per account",
        });
      }
      const row = await opts.botFailureStore.insert({
        service: req.body.service.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
        error_kind: req.body.error_kind.slice(0, 80),
        reason: req.body.reason.slice(0, 2000),
        account_id,
        mcp_version: req.body.mcp_version.slice(0, 40),
      });
      reply.code(201).send({ ok: true, id: row.id });
    },
  );

  // ── GET /admin/discovery-candidates ────────────────────────────
  // Closed-loop Phase 5: aggregation surface for the discovery
  // worker. Returns services where ≥3 distinct end-users have hit
  // terminal failures in the last 14 days AND no active skill exists.
  fastify.get<{ Querystring: { limit?: string; since_days?: string; min_distinct?: string } }>(
    "/admin/discovery-candidates",
    async (req, reply) => {
      if (denyIfNotAdmin(req as { headers: Record<string, unknown> }, reply)) return;
      if (opts.botFailureStore === undefined) {
        return reply.code(503).send({ ok: false, error: "telemetry_not_configured" });
      }
      const limit = numFromQuery(req.query.limit, 20, 1, 100);
      const sinceDays = numFromQuery(req.query.since_days, 14, 1, 90);
      const minDistinct = numFromQuery(req.query.min_distinct, 3, 1, 100);

      // The excludeServices set is "services with an active skill".
      // We pull active skills once and pass the slug-set down — the
      // store can't see across into SkillStore.
      const [activeSkills, demotedSkills, quarantinedSkills] = await Promise.all([
        opts.store.listSkills({ status: "active", limit: 500 }),
        opts.store.listSkills({ status: "demoted", limit: 500 }),
        opts.store.listSkills({ status: "quarantined", limit: 500 }),
      ]);
      const excludeServices = new Set(activeSkills.map((s) => s.service));
      // T5 — closed loop: a quarantined (wall) service is routed to the
      // human pile, NEVER auto-rediscovered, so exclude it from candidates.
      for (const s of quarantinedSkills) excludeServices.add(s.service);
      // A freshly-demoted (rot) skill's service should be re-skilled
      // REGARDLESS of demand — that's the demotion→rediscovery handoff.
      // Prepended below so a known-broken skill gets re-captured ahead of
      // demand-only candidates.
      const demotedServices = [
        ...new Set(
          demotedSkills.map((s) => s.service).filter((svc) => !excludeServices.has(svc)),
        ),
      ];

      const failureCandidates = await opts.botFailureStore.listDiscoveryCandidates({
        sinceDays,
        minDistinct,
        excludeServices,
        // Pull a wider failure set than `limit` so the demand merge has
        // room to re-rank before the final cap.
        limit: Math.min(100, limit * 3),
      });

      // Decision 4: when the demand signal is wired, merge per-service
      // provision volume with the failure candidates, dedupe, apply the
      // wall damper, and rank demand-first. Falls back to failure-only
      // candidates when the event store isn't configured.
      if (opts.provisionEventStore !== undefined) {
        const sinceMs = sinceDays * 86_400_000;
        const demandRows = await opts.provisionEventStore.demandByService(sinceMs, 100);
        const merged = mergeHarvestCandidates({
          demandRows,
          failureCandidates,
          activeServices: excludeServices,
          limit,
        });
        const demandItems = merged.map((c) => ({
          service: c.service,
          // Kept for backward-compat with the housekeeper queue mapper.
          distinct_failures: c.distinct_failures,
          top_error_kind: c.top_error_kind,
          most_recent_at: c.most_recent_at?.toISOString() ?? null,
          // New demand-signal fields.
          volume: c.volume,
          source: c.source,
          wall_ratio: c.wall_ratio,
        }));
        const seen = new Set(demandItems.map((i) => i.service));
        const demotedItems = demotedServices
          .filter((svc) => !seen.has(svc))
          .map((svc) => ({
            service: svc,
            distinct_failures: 0,
            top_error_kind: "demoted",
            most_recent_at: null,
            volume: 0,
            source: "demoted",
            wall_ratio: 0,
          }));
        reply.send({
          ok: true,
          since_days: sinceDays,
          min_distinct: minDistinct,
          // Demoted (rot) services first — re-skill known-broken skills
          // ahead of demand-only discoveries — then the demand merge.
          items: [...demotedItems, ...demandItems].slice(0, limit),
        });
        return;
      }

      const failureItems = failureCandidates.map((c) => ({
        service: c.service,
        distinct_failures: c.distinct_failures,
        top_error_kind: c.top_error_kind,
        most_recent_at: c.most_recent_at.toISOString() as string | null,
      }));
      const seenF = new Set(failureItems.map((i) => i.service));
      const demotedItemsF = demotedServices
        .filter((svc) => !seenF.has(svc))
        .map((svc) => ({
          service: svc,
          distinct_failures: 0,
          top_error_kind: "demoted",
          most_recent_at: null,
        }));
      reply.send({
        ok: true,
        since_days: sinceDays,
        min_distinct: minDistinct,
        items: [...demotedItemsF, ...failureItems].slice(0, limit),
      });
    },
  );

  // ── GET /admin/needs-human ─────────────────────────────────────────
  // T6 — the operator worklist. A sole operator won't crawl per-skill
  // panels, so this rolls up everything that needs a human into one
  // sortable list: demoted (rot — a fast-follow auto-rediscovery may
  // re-skill it, but until then it's broken) and quarantined (wall /
  // gave-up — needs a manual signup or harder anti-bot work). Each row
  // carries WHY (demotion_reason), the last attempt, and the skill_id as
  // the capture handle so the operator can pick up where the bot left
  // off. Read-only — resolution is the existing reactivate/approve paths.
  fastify.get<{ Querystring: { limit?: string } }>(
    "/admin/needs-human",
    async (req, reply) => {
      if (denyIfNotAdmin(req as { headers: Record<string, unknown> }, reply)) return;
      const limit = numFromQuery(req.query.limit, 100, 1, 500);
      const [demoted, quarantined] = await Promise.all([
        opts.store.listSkills({ status: "demoted", limit }),
        opts.store.listSkills({ status: "quarantined", limit }),
      ]);
      const rows = [...demoted, ...quarantined].map((s) => ({
        service: s.service,
        skill_id: s.skill_id,
        status: s.status,
        // rot:<kind> / wall:<kind> / manual:<reason> — null on legacy
        // rows demoted before T4.
        reason: s.demotion_reason,
        // Quarantine (wall) blocks the bot; demotion (rot) may auto-heal.
        needs: s.status === "quarantined" ? "manual" : "rediscovery-or-manual",
        last_attempt_at:
          (s.last_verified_at ?? s.last_replayed_at)?.toISOString() ?? null,
        verifier_failed: s.verifier_failed,
      }));
      // Most-recently-failed first so the operator sees fresh breakage.
      rows.sort(
        (a, b) =>
          (b.last_attempt_at ?? "").localeCompare(a.last_attempt_at ?? ""),
      );
      reply.send({ ok: true, count: rows.length, items: rows.slice(0, limit) });
    },
  );

  // ── POST /admin/heal-heartbeat ─────────────────────────────────────
  // T10 — the heal pass reports in after each run. The dashboard reads the
  // latest + its age to show whether the self-healing timer is alive (the
  // timer runs on the operator's box; the registry can't see systemd).
  fastify.post<{ Body: unknown }>(
    "/admin/heal-heartbeat",
    async (req, reply) => {
      if (denyIfNotAdmin(req as { headers: Record<string, unknown> }, reply)) return;
      const b = (req.body ?? {}) as Record<string, unknown>;
      const intField = (k: string): number => {
        const v = b[k];
        return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
      };
      const rec = await opts.store.recordHealRun({
        verified: intField("verified"),
        demoted: intField("demoted"),
        quarantined: intField("quarantined"),
        reskilled: intField("reskilled"),
        needs_human: intField("needs_human"),
        ...(typeof b["mcp_version"] === "string"
          ? { mcp_version: (b["mcp_version"] as string).slice(0, 40) }
          : {}),
      });
      reply.code(201).send({ ok: true, id: rec.id, ran_at: rec.ran_at.toISOString() });
    },
  );
};

function numFromQuery(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

interface VerifierOutcomeBody {
  kind: "success" | "failure";
  reason: string;
  // Structured failure kind (step_failed / validator_failed /
  // extraction_failed / fetch_error / …) → drives the T4 demotion
  // classifier. Optional: legacy workers omit it; a failure with no kind
  // classifies as transient and never demotes.
  failure_kind?: string;
  duration_ms?: number;
}

interface BotFailureBody {
  service: string;
  error_kind: string;
  reason: string;
  mcp_version: string;
}

function isBotFailureBody(body: unknown): body is BotFailureBody {
  if (body === null || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b["service"] !== "string" || b["service"].length === 0) return false;
  if (typeof b["error_kind"] !== "string" || b["error_kind"].length === 0) return false;
  if (typeof b["reason"] !== "string") return false;
  if (typeof b["mcp_version"] !== "string" || b["mcp_version"].length === 0) return false;
  return true;
}

function isVerifierOutcomeBody(body: unknown): body is VerifierOutcomeBody {
  if (body === null || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b["kind"] !== "success" && b["kind"] !== "failure") return false;
  if (typeof b["reason"] !== "string") return false;
  if (b["failure_kind"] !== undefined && typeof b["failure_kind"] !== "string") return false;
  if (b["duration_ms"] !== undefined && typeof b["duration_ms"] !== "number") return false;
  return true;
}
