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

export interface ServicesHealthRouteDeps {
  eventStore: ProvisionEventStore;
  skillStore: SkillStore;
  resolveAccountId: (req: { headers: Record<string, unknown> }) => string;
  /** Override score config — surfaced for env-tunables on bootstrap. */
  scoreOptions?: CompatScoreOptions;
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
        // TODO (see docs/DESIGN-provision-event-dashboard.md).
        initial_strategy: d.initial_strategy ?? "bot",
        final_strategy: d.final_strategy ?? "bot",
        ...(d.replay_outcome !== undefined ? { replay_outcome: d.replay_outcome } : {}),
        ...(d.final_outcome !== undefined ? { final_outcome: d.final_outcome } : {}),
        ...(d.failure_kind !== undefined ? { failure_kind: d.failure_kind } : {}),
        ...(d.signup_url !== undefined ? { signup_url: d.signup_url } : {}),
        ...(d.provision_id !== undefined ? { provision_id: d.provision_id } : {}),
        ...(d.step_trail !== undefined ? { step_trail: d.step_trail } : {}),
        ...(d.llm_cost !== undefined ? { llm_cost: d.llm_cost } : {}),
        ...(d.captcha_cost !== undefined ? { captcha_cost: d.captcha_cost } : {}),
        ...(d.duration_ms !== undefined ? { duration_ms: d.duration_ms } : {}),
        account_id,
        mcp_version: d.mcp_version,
      });
      return reply.code(201).send({ id });
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
