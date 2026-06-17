// OpenIssue routes — memory-overhaul Phase 4. The drainable failure ledger's
// HTTP surface. The READ (worklist) is admin-bearer gated like the rest of
// /admin; the MUTATIONS (claim / resolve / wall) carry the SERVER-SIDE
// close-gate that refuses to close a ticket without the matching evidence.
//
//   GET  /admin/issues?status=open        — the loop's worklist
//   GET  /admin/issues/:id                — one ticket
//   POST /admin/issues/:id/claim          — { actor, version } → in_progress
//   POST /admin/issues/:id/resolve        — { actor, version, resolved_run }
//   POST /admin/issues/:id/wall           — { actor, version, falsified:{experiment,result,evidence_ref?} }

import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { bearerEquals } from "./admin.js";
import type {
  CloseResult,
  IssueStatus,
  OpenIssueStore,
} from "../open-issue-store.js";
import type { ServiceStateStore } from "../service-state-store.js";

export interface IssuesRouteDeps {
  openIssueStore: OpenIssueStore;
  // Memory-overhaul Phase 4 follow-up — the materialized ServiceState list
  // feeds the `mcp housekeeper state-doc` generator (STATE.md projection).
  serviceStateStore?: ServiceStateStore;
  adminBearer?: string;
}

const STATUSES = ["open", "in_progress", "resolved", "wall"] as const;

const ClaimBody = z.object({
  actor: z.string().min(1).max(80),
  version: z.number().int().nonnegative(),
});
const ResolveBody = z.object({
  actor: z.string().min(1).max(80),
  version: z.number().int().nonnegative(),
  resolved_run: z.string().min(1).max(120),
});
const WallBody = z.object({
  actor: z.string().min(1).max(80),
  version: z.number().int().nonnegative(),
  falsified: z.object({
    experiment: z.string().min(1).max(2000),
    result: z.string().min(1).max(2000),
    evidence_ref: z.string().min(1).max(200).optional(),
  }),
});

// Map a store CloseResult to an HTTP reply. The close-gate's
// `missing_evidence` is a 422 — the request was well-formed but violated the
// "no close without evidence" invariant, which is the whole point.
function sendCloseResult(reply: FastifyReply, r: CloseResult): FastifyReply {
  switch (r.kind) {
    case "ok":
      return reply.code(200).send({ ok: true, issue: r.issue });
    case "not_found":
      return reply.code(404).send({ ok: false, error: "not_found" });
    case "version_conflict":
      return reply
        .code(409)
        .send({ ok: false, error: "version_conflict", current: r.current });
    case "missing_evidence":
      return reply
        .code(422)
        .send({ ok: false, error: "missing_evidence", need: r.need });
  }
}

export const registerIssuesRoutes: FastifyPluginAsync<IssuesRouteDeps> = async (
  fastify: FastifyInstance,
  opts,
) => {
  const store = opts.openIssueStore;

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
    if (!bearerEquals(presented, `Bearer ${opts.adminBearer}`)) {
      reply.code(401).send({ ok: false, error: "unauthorized" });
      return true;
    }
    return false;
  }

  fastify.get<{ Querystring: { status?: string } }>(
    "/admin/issues",
    async (req, reply) => {
      if (denyIfNotAdmin(req as { headers: Record<string, unknown> }, reply)) return;
      const s = req.query.status;
      const status =
        s !== undefined && (STATUSES as readonly string[]).includes(s)
          ? (s as IssueStatus)
          : undefined;
      const issues = await store.list(status);
      return reply.send({ ok: true, issues, count: issues.length });
    },
  );

  // Materialized ServiceState list — the source for the STATE.md generator.
  fastify.get("/admin/service-states", async (req, reply) => {
    if (denyIfNotAdmin(req as { headers: Record<string, unknown> }, reply)) return;
    if (opts.serviceStateStore === undefined) {
      return reply.send({ ok: true, states: [], count: 0 });
    }
    const states = await opts.serviceStateStore.list();
    return reply.send({ ok: true, states, count: states.length });
  });

  fastify.get<{ Params: { id: string } }>(
    "/admin/issues/:id",
    async (req, reply) => {
      if (denyIfNotAdmin(req as { headers: Record<string, unknown> }, reply)) return;
      const issue = await store.get(req.params.id);
      if (issue === null) return reply.code(404).send({ ok: false, error: "not_found" });
      return reply.send({ ok: true, issue });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/admin/issues/:id/claim",
    async (req, reply) => {
      if (denyIfNotAdmin(req as { headers: Record<string, unknown> }, reply)) return;
      const parsed = ClaimBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_body" });
      }
      return sendCloseResult(
        reply,
        await store.claim(req.params.id, parsed.data.actor, parsed.data.version),
      );
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/admin/issues/:id/resolve",
    async (req, reply) => {
      if (denyIfNotAdmin(req as { headers: Record<string, unknown> }, reply)) return;
      const parsed = ResolveBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_body" });
      }
      return sendCloseResult(
        reply,
        await store.closeResolved(
          req.params.id,
          parsed.data.resolved_run,
          parsed.data.actor,
          parsed.data.version,
        ),
      );
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/admin/issues/:id/wall",
    async (req, reply) => {
      if (denyIfNotAdmin(req as { headers: Record<string, unknown> }, reply)) return;
      const parsed = WallBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: "invalid_body" });
      }
      const f = parsed.data.falsified;
      // Normalize the optional evidence_ref away when absent
      // (exactOptionalPropertyTypes: present-and-string, not string|undefined).
      const falsified = {
        experiment: f.experiment,
        result: f.result,
        ...(f.evidence_ref !== undefined ? { evidence_ref: f.evidence_ref } : {}),
      };
      return sendCloseResult(
        reply,
        await store.closeWall(req.params.id, falsified, parsed.data.actor, parsed.data.version),
      );
    },
  );
};
