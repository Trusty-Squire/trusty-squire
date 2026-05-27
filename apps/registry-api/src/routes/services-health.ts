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
import type { ProvisionAttemptStore } from "../provision-attempt-store.js";
import type { SkillStore } from "../skill-store.js";

export interface ServicesHealthRouteDeps {
  attemptStore: ProvisionAttemptStore;
  skillStore: SkillStore;
  resolveAccountId: (req: { headers: Record<string, unknown> }) => string;
  /** Override score config — surfaced for env-tunables on bootstrap. */
  scoreOptions?: CompatScoreOptions;
}

const PostBodySchema = z.object({
  status: z.enum(["success", "failed"]),
  failure_kind: z.string().min(1).max(120).optional(),
  signup_url: z.string().max(2048).optional(),
  mcp_version: z.string().min(1).max(40),
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
  const { attemptStore, skillStore, resolveAccountId } = opts;
  const scoreOpts = opts.scoreOptions ?? {};

  const isValidSlug = (s: string): boolean =>
    typeof s === "string" && /^[a-z0-9][a-z0-9-]*$/.test(s) && s.length <= 80;

  async function buildHealth(service: string): Promise<CompatHealth> {
    const [attempts, activeSkill] = await Promise.all([
      attemptStore.listByService(service, LOOKBACK_MS),
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
      const { id } = await attemptStore.record({
        service: slug,
        status: parsed.data.status,
        ...(parsed.data.failure_kind !== undefined
          ? { failure_kind: parsed.data.failure_kind }
          : {}),
        ...(parsed.data.signup_url !== undefined
          ? { signup_url: parsed.data.signup_url }
          : {}),
        account_id,
        mcp_version: parsed.data.mcp_version,
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
