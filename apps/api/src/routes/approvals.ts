// GET  /v1/approvals/:token — fetch pending approval details for the PWA
// POST /v1/approvals/:token/grant — submit signed delta bundle
// POST /v1/approvals/:token/deny — user declines the action

import { z } from "zod";
import { type FastifyPluginAsync, type FastifyReply, type FastifyRequest } from "fastify";
import { transition } from "@trusty-squire/runtime";
import {
  DEFAULT_CONFIDENCE_REQUIREMENTS as VALIDATOR_DEFAULTS,
  type ConfidenceLevel,
} from "@trusty-squire/mandate-validator";
import { approvalTokenInvalidReason } from "../auth/approval-token.js";
import type { ApiDeps } from "../services/deps.js";

void approvalTokenInvalidReason;

const bundleSchema = z.object({
  payload: z.string(),
  context: z.string(),
  assertion: z.string(),
  signingDeviceId: z.string(),
  deviceToken: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  signedAt: z.string(),
  platform: z.enum(["ios", "android", "web"]),
});

export const registerApprovalsRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> = async (fastify, opts) => {
  fastify.get<{ Params: { token: string } }>(
    "/v1/approvals/:token",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const now = opts.deps.now?.() ?? new Date();
      const record = await opts.deps.approvalTokenStore.findActive(req.params.token, now);
      if (record === null) {
        reply.code(404).send({ error: "approval_not_found_or_expired" });
        return;
      }
      if (record.account_id !== auth.account_id) {
        reply.code(403).send({ error: "wrong_account" });
        return;
      }
      const run = await opts.deps.runStore.loadRun(record.run_id).catch(() => null);
      if (run === null) {
        reply.code(404).send({ error: "run_not_found" });
        return;
      }
      return reply.code(200).send({
        token: record.token,
        run: {
          id: run.id,
          service: run.service,
          plan: run.plan,
          project_name: run.project_name,
          state: run.state,
        },
        expires_at: record.expires_at.toISOString(),
      });
    },
  );

  fastify.post<{ Params: { token: string } }>(
    "/v1/approvals/:token/grant",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;

      const parsed = z.object({ bundle: bundleSchema }).safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }

      const now = opts.deps.now?.() ?? new Date();
      const tokenRecord = await opts.deps.approvalTokenStore.findActive(req.params.token, now);
      if (tokenRecord === null) {
        reply.code(404).send({ error: "approval_not_found_or_expired" });
        return;
      }
      if (tokenRecord.account_id !== auth.account_id) {
        reply.code(403).send({ error: "wrong_account" });
        return;
      }

      const run = await opts.deps.runStore.loadRun(tokenRecord.run_id).catch(() => null);
      if (run === null || run.state !== "PENDING_APPROVAL") {
        reply.code(409).send({ error: "run_not_pending_approval" });
        return;
      }

      const mandateRow = await opts.deps.accountStore.getActiveMandate(auth.account_id);
      if (mandateRow === null) {
        reply.code(409).send({ error: "no_active_mandate" });
        return;
      }

      // Confidence required for delta_mandate_signing — pull from
      // mandate (action.type=provision) or fall back to the floor.
      const requiredConfidence: ConfidenceLevel =
        mandateRow.mandate.confidence_requirements.provision ??
        VALIDATOR_DEFAULTS.delta_mandate_signing;

      const verification = await opts.deps.mandateValidator.verifyDeltaBundle(
        parsed.data.bundle,
        mandateRow.mandate,
        requiredConfidence,
      );
      if (!verification.result.valid || verification.delta === undefined) {
        reply.code(400).send({
          error: "delta_bundle_invalid",
          reason: verification.result.reason ?? "unknown",
        });
        return;
      }
      const delta = verification.delta;

      if (delta.action.run_id !== run.id) {
        reply.code(400).send({ error: "delta_run_id_mismatch" });
        return;
      }

      // Apply approval_granted transition.
      const t = transition(
        run,
        { kind: "approval_granted", delta_mandate_id: delta.id },
        now.toISOString(),
      );
      const provisioning = await opts.deps.runStore.applyTransition(run.id, t);

      await opts.deps.approvalTokenStore.markUsed(req.params.token, now);

      return reply.code(200).send({
        run: { id: provisioning.id, state: provisioning.state },
        delta_id: delta.id,
      });
    },
  );

  fastify.post<{ Params: { token: string } }>(
    "/v1/approvals/:token/deny",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;

      const now = opts.deps.now?.() ?? new Date();
      const tokenRecord = await opts.deps.approvalTokenStore.findActive(req.params.token, now);
      if (tokenRecord === null) {
        reply.code(404).send({ error: "approval_not_found_or_expired" });
        return;
      }
      if (tokenRecord.account_id !== auth.account_id) {
        reply.code(403).send({ error: "wrong_account" });
        return;
      }
      const run = await opts.deps.runStore.loadRun(tokenRecord.run_id).catch(() => null);
      if (run === null || run.state !== "PENDING_APPROVAL") {
        reply.code(409).send({ error: "run_not_pending_approval" });
        return;
      }

      const t = transition(
        run,
        { kind: "approval_denied", reason: "user_denied" },
        now.toISOString(),
      );
      await opts.deps.runStore.applyTransition(run.id, t);
      await opts.deps.approvalTokenStore.markUsed(req.params.token, now);

      return reply.code(200).send({ ok: true });
    },
  );
};
