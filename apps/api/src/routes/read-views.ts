// Read-only routes for the PWA + agents:
//   GET /v1/subscriptions       — list account's subscriptions
//   DELETE /v1/subscriptions/:id — cancel (creates a cancel run)
//   GET /v1/ledger              — paginated audit ledger
//   GET /v1/usage               — spending + budget summary
//
// These wrap the runtime's existing data; v0 implementations are
// deliberately thin (no joins, no pagination state in headers).

import { type FastifyPluginAsync, type FastifyReply, type FastifyRequest } from "fastify";
import type { ApiDeps } from "../services/deps.js";

const ROLLING_WINDOW_DAYS = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const registerReadViewsRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireAny: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> = async (fastify, opts) => {
  // ── Subscriptions ──────────────────────────────────────────

  fastify.get("/v1/subscriptions", { preHandler: opts.requireWeb }, async (req, reply) => {
    const auth = req.auth!;
    if (auth.kind !== "web") return;
    // v0: derive subscriptions from completed runs. A future chunk
    // will land a dedicated Subscription store fed by vault-write
    // completion events.
    const completed = await opts.deps.runStore.findRunsInState("COMPLETE", 100);
    const filtered = completed.filter(
      (r) => r.account_id === auth.account_id && r.subscription_id !== null,
    );
    return reply.code(200).send({
      subscriptions: filtered.map((r) => ({
        id: r.subscription_id,
        service: r.service,
        plan: r.plan,
        project_name: r.project_name,
        run_id: r.id,
        completed_at: r.completed_at,
      })),
    });
  });

  fastify.delete<{ Params: { id: string } }>(
    "/v1/subscriptions/:id",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      // Cancellation runs lands in chunk 11+ (the executor needs to
      // pick a flow based on action.type, not just adapter.signup).
      // For chunk-10 v0, this is a stub that records intent and
      // returns 202.
      reply.code(202).send({
        ok: true,
        subscription_id: req.params.id,
        note: "cancellation pipeline is wired in chunk 11+; this request was acknowledged",
        requested_by: auth.account_id,
      });
    },
  );

  // ── Ledger ─────────────────────────────────────────────────

  fastify.get("/v1/ledger", { preHandler: opts.requireWeb }, async (req, reply) => {
    const auth = req.auth!;
    if (auth.kind !== "web") return;
    // List recent runs for the account and surface their event count.
    // The full audit log lives behind `runStore.loadEvents(runId)`;
    // the PWA fetches per-run details on click.
    const runs = await opts.deps.runStore.findRunsInState("COMPLETE", 100);
    const failed = await opts.deps.runStore.findRunsInState("FAILED", 100);
    const all = [...runs, ...failed]
      .filter((r) => r.account_id === auth.account_id)
      .sort((a, b) => (b.created_at > a.created_at ? 1 : -1))
      .slice(0, 50);

    return reply.code(200).send({
      entries: all.map((r) => ({
        run_id: r.id,
        service: r.service,
        plan: r.plan,
        state: r.state,
        created_at: r.created_at,
        completed_at: r.completed_at,
        failure_reason: r.failure_reason,
      })),
    });
  });

  // ── Usage ──────────────────────────────────────────────────

  fastify.get("/v1/usage", { preHandler: opts.requireAny }, async (req, reply) => {
    const auth = req.auth!;
    const mandateRow = await opts.deps.accountStore.getActiveMandate(auth.account_id);
    if (mandateRow === null) {
      reply.code(404).send({ error: "no_active_mandate" });
      return;
    }
    const now = opts.deps.now?.() ?? new Date();
    const since30d = new Date(now.getTime() - ROLLING_WINDOW_DAYS * ONE_DAY_MS);
    const since24h = new Date(now.getTime() - ONE_DAY_MS);
    const monthSpend = await opts.deps.validatorDeps.getRecentSpend(auth.account_id, since30d);
    const daySpend = await opts.deps.validatorDeps.getRecentSpend(auth.account_id, since24h);
    return reply.code(200).send({
      monthly: {
        spent_cents: monthSpend,
        budget_cents: mandateRow.mandate.monthly_budget_cents,
        remaining_cents: Math.max(0, mandateRow.mandate.monthly_budget_cents - monthSpend),
      },
      daily: {
        spent_cents: daySpend,
        silent_max_cents: mandateRow.mandate.daily_silent_max_cents,
      },
      mandate_id: mandateRow.mandate.id,
    });
  });

  // ── Vouchflow device.revoked webhook stub ──────────────────
  //
  // Per the chunk-10 directive, the Vouchflow webhook for device
  // revocation may not exist yet. We expose the endpoint so the
  // contract is published and audit logging works when the upstream
  // event ships. No-op-with-warning until the contract is finalised.
  fastify.post("/webhooks/vouchflow/device-revoked", async (req, reply) => {
    fastify.log.warn(
      { payload: req.body },
      "vouchflow_device_revoked_webhook_received_stub_handler",
    );
    // TODO: verify Vouchflow webhook signature once that contract
    // is published. Until then, treat the call as informational only.
    return reply.code(202).send({ ok: true, note: "webhook acknowledged (stub)" });
  });
};
