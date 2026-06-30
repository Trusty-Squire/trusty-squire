// T44 — service compatibility-score endpoints.
//
//   POST /v1/services/:slug/attempts        — bot reports an outcome
//   GET  /v1/services/:slug/health          — health for ONE service
//   GET  /v1/services/:slug/health?peers=…  — health + category-peer alternates
//
// Recommendation logic (the `alternates` field) only fires when the
// requested service's state is "hard-block". For all other states the
// MCP shouldn't recommend a switch.

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  buildCompatHealth,
  type CompatHealth,
  type CompatScoreOptions,
} from "../compat-score.js";
import type { ProvisionEventStore } from "../provision-event-store.js";
import type { SkillStore } from "../skill-store.js";
import {
  projectServiceState,
  type ServiceStateStore,
} from "../service-state-store.js";
import type { OpenIssueStore } from "../open-issue-store.js";

export interface ServicesHealthRouteDeps {
  eventStore: ProvisionEventStore;
  skillStore: SkillStore;
  resolveAccountId: (req: { headers: Record<string, unknown> }) => string;
  /** Override score config — surfaced for env-tunables on bootstrap. */
  scoreOptions?: CompatScoreOptions;
  /** Memory-overhaul Phase 3 — materialized per-service status. When wired,
   *  a POSTed attempt recomputes the projection on insert and the dossier
   *  endpoint reads it. Optional so legacy bootstraps work unchanged. */
  serviceStateStore?: ServiceStateStore;
  /** Memory-overhaul Phase 4 — the drainable ledger. A failed attempt seeds
   *  an OpenIssue from the firehose; a success drains the service's open
   *  tickets. Optional. */
  openIssueStore?: OpenIssueStore;
}

const PostBodySchema = z.object({
  status: z.enum(["success", "failed"]),
  // Dispatch model (Decision 10). All optional: old MCP clients
  // (pre-event) send none, and the handler blind-defaults the
  // strategy fields to "bot" (Decision 5 + 12) — historically true,
  // since only the bot path ever posted attempts.
  initial_strategy: z.enum(["replay", "bot"]).optional(),
  final_strategy: z.enum(["replay", "bot"]).optional(),
  replay_outcome: z.enum(["ok", "miss", "na"]).optional(),
  final_outcome: z.enum(["ok", "failed", "blocked"]).optional(),
  failure_kind: z.string().min(1).max(120).optional(),
  signup_url: z.string().max(2048).optional(),
  // Memory-overhaul Phase 1 — housekeeper context + captcha summary
  // (partial fold). All optional; legacy clients omit them.
  mode: z.enum(["discover", "verify", "replay"]).optional(),
  captcha_kind: z.string().min(1).max(40).optional(),
  captcha_variant: z.string().min(1).max(40).optional(),
  captcha_blocked: z.boolean().optional(),
  mcp_version: z.string().min(1).max(40),
  // T45 — correlation id linking this attempt to ExtractFailureSnapshot
  // rows uploaded during the same provision call. Also the idempotency
  // key: a repeat post with the same provision_id upserts (Decision 11).
  provision_id: z.string().min(1).max(120).optional(),
  // T45 — inline step trail (truncated server-side past 32KB) for
  // failures that bail before any ExtractFailureSnapshot rows
  // exist for this run.
  step_trail: z.string().max(64 * 1024).optional(),
  // Cost telemetry (Decision 3). Non-negative; replay rows send 0.
  llm_cost: z.number().nonnegative().optional(),
  captcha_cost: z.number().nonnegative().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
});

const PeerSlugList = z
  .string()
  .max(2048)
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.length > 0 && /^[a-z0-9][a-z0-9-]*$/.test(x))
      .slice(0, 20),
  );

// 60 days — covers the longest reasonable look-back for a 14-day
// half-life (5.7 half-lives → weight ≈ 0.019, below noise). Anything
// older is ignored.
const LOOKBACK_MS = 60 * 86_400_000;

export const registerServicesHealthRoute: FastifyPluginAsync<
  ServicesHealthRouteDeps
> = async (fastify: FastifyInstance, opts) => {
  const { eventStore, skillStore, resolveAccountId } = opts;
  const scoreOpts = opts.scoreOptions ?? {};

  const isValidSlug = (s: string): boolean =>
    typeof s === "string" && /^[a-z0-9][a-z0-9-]*$/.test(s) && s.length <= 80;

  async function buildHealth(service: string): Promise<CompatHealth> {
    const [attempts, activeSkill] = await Promise.all([
      eventStore.listByService(service, LOOKBACK_MS),
      skillStore.findActiveByService(service),
    ]);
    return buildCompatHealth(attempts, activeSkill !== null, scoreOpts);
  }

  // Bot reports an outcome.
  fastify.post<{ Params: { slug: string } }>(
    "/v1/services/:slug/attempts",
    async (request, reply) => {
      const slug = request.params.slug?.toLowerCase();
      if (!isValidSlug(slug)) {
        return reply.code(400).send({ error: "invalid_slug" });
      }
      const parsed = PostBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", details: parsed.error.format() });
      }
      const account_id = resolveAccountId(request);
      const d = parsed.data;
      const { id } = await eventStore.record({
        service: slug,
        status: d.status,
        // Decision 12: a post with no strategy fields is a legacy
        // (pre-event) client, which only ever ran the bot — default
        // both legs to "bot". Version-gated provenance is a deferred
        // TODO (see docs/ARCHITECTURE.md).
        initial_strategy: d.initial_strategy ?? "bot",
        final_strategy: d.final_strategy ?? "bot",
        ...(d.replay_outcome !== undefined ? { replay_outcome: d.replay_outcome } : {}),
        ...(d.final_outcome !== undefined ? { final_outcome: d.final_outcome } : {}),
        ...(d.failure_kind !== undefined ? { failure_kind: d.failure_kind } : {}),
        ...(d.signup_url !== undefined ? { signup_url: d.signup_url } : {}),
        ...(d.mode !== undefined ? { mode: d.mode } : {}),
        ...(d.captcha_kind !== undefined ? { captcha_kind: d.captcha_kind } : {}),
        ...(d.captcha_variant !== undefined ? { captcha_variant: d.captcha_variant } : {}),
        ...(d.captcha_blocked !== undefined ? { captcha_blocked: d.captcha_blocked } : {}),
        ...(d.provision_id !== undefined ? { provision_id: d.provision_id } : {}),
        ...(d.step_trail !== undefined ? { step_trail: d.step_trail } : {}),
        ...(d.llm_cost !== undefined ? { llm_cost: d.llm_cost } : {}),
        ...(d.captcha_cost !== undefined ? { captcha_cost: d.captcha_cost } : {}),
        ...(d.duration_ms !== undefined ? { duration_ms: d.duration_ms } : {}),
        account_id,
        mcp_version: d.mcp_version,
      });
      // Memory-overhaul Phase 3 — recompute the materialized projection from
      // the (now-inclusive) event slice. Best-effort: a projection failure
      // must never fail the attempt POST. Convergent under concurrency —
      // reads the full committed slice, not just this event.
      if (opts.serviceStateStore !== undefined) {
        try {
          const [attempts, activeSkill] = await Promise.all([
            eventStore.listByService(slug, LOOKBACK_MS),
            skillStore.findActiveByService(slug),
          ]);
          await opts.serviceStateStore.recomputeFrom(
            projectServiceState(slug, attempts, activeSkill !== null, scoreOpts),
          );
        } catch (err) {
          request.log.warn(
            { err, service: slug },
            "ServiceState projection recompute failed (non-fatal)",
          );
        }
      }
      // Memory-overhaul Phase 4 — feed the drainable ledger from the firehose
      // (Codex #5: seed from ProvisionEvent, NOT UniversalBotFailureRecord —
      // UBF isn't populated on every failure path, which would leave silent
      // all-clear gaps). A failure seeds/reopens a ticket; a success with a
      // provision_id drains the service's open tickets (drain-on-green).
      // Best-effort — never fail the attempt POST.
      if (opts.openIssueStore !== undefined) {
        try {
          if (d.status === "failed" && d.failure_kind !== undefined) {
            await opts.openIssueStore.seedFailure(slug, d.failure_kind);
          } else if (d.status === "success" && d.provision_id !== undefined) {
            await opts.openIssueStore.resolveServiceOnSuccess(slug, d.provision_id);
          }
        } catch (err) {
          request.log.warn(
            { err, service: slug },
            "OpenIssue ledger update failed (non-fatal)",
          );
        }
      }
      return reply.code(201).send({ id });
    },
  );

  // Memory-overhaul Phase 3 — the DOSSIER: one read that answers "what's the
  // deal with service X" (replaces the 6-source hand-join). Materialized
  // status + the recent event slice (capped). Evidence + OpenIssue links join
  // in later slices. Public-readish: same surface as /health, no secrets.
  fastify.get<{ Params: { slug: string }; Querystring: { events?: string } }>(
    "/v1/services/:slug/dossier",
    async (request, reply) => {
      const slug = request.params.slug?.toLowerCase();
      if (!isValidSlug(slug)) {
        return reply.code(400).send({ error: "invalid_slug" });
      }
      // Cap the event page hard (Codex #9 — bound the join). Default 20, max 100.
      const reqN = Number.parseInt(request.query.events ?? "20", 10);
      const limit = Number.isFinite(reqN) ? Math.min(Math.max(reqN, 1), 100) : 20;
      const state =
        opts.serviceStateStore !== undefined
          ? await opts.serviceStateStore.get(slug)
          : null;
      const recent = (await eventStore.listByService(slug, LOOKBACK_MS)).slice(
        0,
        limit,
      );
      return reply.send({
        service: slug,
        state,
        recent_events: recent.map((e) => ({
          id: e.id,
          status: e.status,
          mode: e.mode,
          failure_kind: e.failure_kind,
          captcha_kind: e.captcha_kind,
          captcha_blocked: e.captcha_blocked,
          provision_id: e.provision_id,
          occurred_at: e.occurred_at,
        })),
        recent_count: recent.length,
      });
    },
  );

  // Health for ONE service. Optional `peers` query param returns
  // alternates when the requested service is hard-blocked.
  fastify.get<{ Params: { slug: string }; Querystring: { peers?: string } }>(
    "/v1/services/:slug/health",
    async (request, reply) => {
      const slug = request.params.slug?.toLowerCase();
      if (!isValidSlug(slug)) {
        return reply.code(400).send({ error: "invalid_slug" });
      }
      const requested = await buildHealth(slug);

      // No alternates needed unless the caller asked AND we're at
      // hard-block. Save the work otherwise.
      let alternates: Array<
        CompatHealth & { service: string; has_active_skill: boolean }
      > = [];
      if (requested.state === "hard-block" && request.query.peers !== undefined) {
        const peerSlugs = PeerSlugList.parse(request.query.peers).filter(
          (p) => p !== slug,
        );
        const peerHealths = await Promise.all(
          peerSlugs.map(async (peer) => {
            const h = await buildHealth(peer);
            return { service: peer, ...h, has_active_skill: h.state === "skill-active" };
          }),
        );
        alternates = peerHealths
          .filter((p) => p.state === "skill-active" || p.state === "working")
          .sort((a, b) => {
            // skill-active beats working; otherwise score desc.
            if (a.state !== b.state) {
              return a.state === "skill-active" ? -1 : 1;
            }
            return b.compat_score - a.compat_score;
          })
          .slice(0, 3);
      }

      return reply.send({
        service: slug,
        ...requested,
        has_active_skill: requested.state === "skill-active",
        alternates,
      });
    },
  );
};
