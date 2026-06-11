// GET /v1/admin/funnel — Panel 1 acquisition-funnel API-side data.
//
// Auth: a DEDICATED read-only bearer (FUNNEL_METRICS_TOKEN), NOT the
// broad UNIVERSAL_BOT_API_KEY — least-privilege for the registry→API
// cross-service read. Returns counts ONLY (no account_ids/emails), so
// no PII crosses the trust boundary.
//
// The caller (registry dashboard) passes explicit window bounds so both
// services aggregate over identical boundaries.

import type { FastifyInstance } from "fastify";
import { verifyBearer } from "../auth/authorize-machine-or-admin.js";
import type { FunnelStatsStore } from "../services/funnel-stats.js";
import { fetchNpmDownloads } from "../services/npm-downloads.js";

const DEFAULT_NPM_PACKAGE = "@trusty-squire/mcp";
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface AdminFunnelRouteDeps {
  funnelStatsStore: FunnelStatsStore;
  // Test/demo/seed account_ids to drop from the counts.
  excludeAccountIds?: readonly string[];
  npmPackage?: string;
  // Injectable fetch for the npm call (tests stub it).
  fetchFn?: typeof globalThis.fetch;
  now?: () => Date;
}

export async function registerAdminFunnelRoute(
  fastify: FastifyInstance,
  opts: { deps: AdminFunnelRouteDeps },
): Promise<void> {
  const now = (): Date => opts.deps.now?.() ?? new Date();

  fastify.get<{ Querystring: { window_start?: string; window_end?: string } }>(
    "/v1/admin/funnel",
    async (req, reply) => {
      // Fail-closed when the metrics token isn't configured.
      const auth = verifyBearer(req, process.env.FUNNEL_METRICS_TOKEN);
      if (auth === "unconfigured") {
        reply.code(503).send({ error: "funnel_metrics_not_configured" });
        return;
      }
      if (auth !== "ok") {
        reply.code(401).send({ error: "unauthorized" });
        return;
      }

      // Window: explicit ISO bounds from the caller, else last 30d.
      const end = req.query.window_end !== undefined ? new Date(req.query.window_end) : now();
      const start =
        req.query.window_start !== undefined
          ? new Date(req.query.window_start)
          : new Date(end.getTime() - DEFAULT_WINDOW_MS);
      if (
        Number.isNaN(start.getTime()) ||
        Number.isNaN(end.getTime()) ||
        start.getTime() > end.getTime()
      ) {
        reply.code(400).send({ error: "invalid_window" });
        return;
      }

      const counts = await opts.deps.funnelStatsStore.apiCounts(
        { start, end },
        opts.deps.excludeAccountIds ?? [],
      );
      const npm_downloads = await fetchNpmDownloads({
        package: opts.deps.npmPackage ?? DEFAULT_NPM_PACKAGE,
        start,
        end,
        ...(opts.deps.fetchFn !== undefined ? { fetchFn: opts.deps.fetchFn } : {}),
      });

      reply.code(200).send({
        window_start: start.toISOString(),
        window_end: end.toISOString(),
        as_of: now().toISOString(),
        tokens_issued: counts.tokens_issued,
        residential_installs: counts.residential_installs,
        accounts_created: counts.accounts_created,
        new_accounts_series: counts.new_accounts_series,
        // null when npm is unreachable + no cached value (fail-soft).
        npm_downloads,
      });
    },
  );
}
