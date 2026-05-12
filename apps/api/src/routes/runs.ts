// POST /v1/runs — create a run, run mandate evaluator, route silent /
//   needs_approval / reject.
// GET  /v1/runs/:id — fetch a run (auth: web or agent for same account).

import { z } from "zod";
import { type FastifyPluginAsync, type FastifyReply, type FastifyRequest } from "fastify";
import { ulid } from "ulid";
import {
  executeOneStep,
  isTerminal,
  transition,
  type ExecutorConfig,
  type RunContext,
} from "@trusty-squire/runtime";
import type { ProposedAction } from "@trusty-squire/mandate-validator";
import { issueApprovalToken } from "../auth/approval-token.js";
import type { ApiDeps } from "../services/deps.js";

const createRunBody = z.object({
  service: z.string().min(1),
  plan: z.string().min(1),
  project_name: z.string().min(1).max(120),
  user_facing_purpose: z.string().nullable().optional(),
  category: z.string().min(1),
  cost_cents: z.number().int().nonnegative(),
  recurrence: z.enum(["one_time", "monthly", "yearly", "none"]),
  // Caller may provide an idempotency key to dedupe retries.
  idempotency_key: z.string().optional(),
});

export const registerRunsRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireAny: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  approvalBaseUrl?: string;
}> = async (fastify, opts) => {
  const approvalBaseUrl = opts.approvalBaseUrl ?? "https://app.trustysquire.ai/approve";

  fastify.post("/v1/runs", { preHandler: opts.requireAny }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = createRunBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const body = parsed.data;

    const mandateRow = await opts.deps.accountStore.getActiveMandate(auth.account_id);
    if (mandateRow === null) {
      reply.code(409).send({ error: "no_active_mandate" });
      return;
    }

    const action: ProposedAction = {
      type: "provision",
      service: body.service,
      category: body.category,
      plan: body.plan,
      cost_cents: body.cost_cents,
      recurrence: body.recurrence,
    };
    const now = opts.deps.now?.() ?? new Date();
    const decision = await opts.deps.mandateValidator.evaluateAction(
      mandateRow.mandate,
      action,
      { now: now.toISOString(), session_anomaly_flags: [] },
    );

    if (decision.kind === "reject") {
      reply.code(403).send({ error: "policy_reject", reason: decision.reason });
      return;
    }

    const context: RunContext = {
      email_alias: `${auth.account_id}.${body.service}.${ulid().slice(0, 12).toLowerCase()}@mail.trustysquire.ai`,
      project_name: body.project_name,
      user_display_name: null,
      generated: {},
      steps: {},
      vault: {},
    };

    const created = await opts.deps.runStore.createRun({
      account_id: auth.account_id,
      service: body.service,
      plan: body.plan,
      project_name: body.project_name,
      user_facing_purpose: body.user_facing_purpose ?? null,
      mandate_id: mandateRow.mandate.id,
      adapter_id: body.service,
      adapter_version: "0.1.0",
      ...(body.idempotency_key !== undefined
        ? { idempotency_key: body.idempotency_key }
        : {}),
      context,
    });

    // Drive CREATED → MANDATE_VALIDATED-equivalent transition. The
    // state machine routes mandate_validated directly to either
    // PENDING_APPROVAL or PROVISIONING based on needs_approval.
    const needsApproval = decision.kind === "needs_approval";
    const t = transition(
      created.run,
      { kind: "mandate_validated", needs_approval: needsApproval },
      now.toISOString(),
    );
    const run = await opts.deps.runStore.applyTransition(created.run.id, t);

    if (decision.kind === "needs_approval") {
      const approvalToken = issueApprovalToken({
        run_id: run.id,
        account_id: auth.account_id,
        now,
      });
      await opts.deps.approvalTokenStore.insert(approvalToken);
      return reply.code(201).send({
        run: { id: run.id, state: run.state },
        decision: "needs_approval",
        reasons: decision.reasons,
        required_confidence: decision.required_confidence,
        approval_url: `${approvalBaseUrl}/${approvalToken.token}`,
      });
    }

    // Silent path. In production a BullMQ worker drains the run queue.
    // For demo mode (DEMO_MODE=true) we drive the run to completion
    // synchronously in this request so the caller sees the final state
    // immediately — adequate because the demo adapter (mock-resend) is
    // pure HTTP with no inbox waits. Hard cap on iterations is a safety
    // net against infinite-loop bugs in the state machine.
    if (process.env.DEMO_MODE === "true") {
      const config = executorConfigFrom(opts.deps);
      let current = run;
      let i = 0;
      const MAX_STEPS = 20;
      while (!isTerminal(current.state) && current.state !== "PENDING_APPROVAL" && i < MAX_STEPS) {
        current = await executeOneStep(config, current.id);
        i += 1;
      }
      return reply.code(201).send({
        run: {
          id: current.id,
          state: current.state,
          steps_count: current.steps.length,
          side_effects_count: current.side_effects.length,
          subscription_id: current.subscription_id,
          failure_reason: current.failure_reason,
        },
        decision: "silent",
      });
    }

    return reply.code(201).send({
      run: { id: run.id, state: run.state },
      decision: "silent",
    });
  });

  fastify.get<{ Params: { id: string } }>(
    "/v1/runs/:id",
    { preHandler: opts.requireAny },
    async (req, reply) => {
      const auth = req.auth!;
      const run = await opts.deps.runStore.loadRun(req.params.id).catch(() => null);
      if (run === null) {
        reply.code(404).send({ error: "run_not_found" });
        return;
      }
      if (run.account_id !== auth.account_id) {
        reply.code(403).send({ error: "wrong_account" });
        return;
      }
      return reply.code(200).send({
        id: run.id,
        state: run.state,
        service: run.service,
        plan: run.plan,
        project_name: run.project_name,
        current_tier: run.current_tier,
        retry_count: run.retry_count,
        steps_count: run.steps.length,
        side_effects_count: run.side_effects.length,
        subscription_id: run.subscription_id,
        failure_reason: run.failure_reason,
        created_at: run.created_at,
        completed_at: run.completed_at,
      });
    },
  );
};

// Helper used by the worker — re-exported so the worker module can
// re-create an ExecutorConfig from ApiDeps without duplicating wiring.
export function executorConfigFrom(deps: ApiDeps): ExecutorConfig {
  return {
    runStore: deps.runStore,
    registry: deps.adapterRegistry,
    vault: deps.vault,
    inbox: deps.inbox,
    ...(deps.now !== undefined ? { now: () => (deps.now ?? (() => new Date()))().toISOString() } : {}),
  };
}

export { executeOneStep };
