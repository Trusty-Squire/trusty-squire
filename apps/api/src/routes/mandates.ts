// POST /v1/mandates — submit a Vouchflow-signed mandate
// GET  /v1/mandates/active — fetch the user's current mandate

import { z } from "zod";
import { type FastifyPluginAsync, type FastifyReply, type FastifyRequest } from "fastify";
import type { ApiDeps } from "../services/deps.js";

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

export const registerMandatesRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> = async (fastify, opts) => {
  fastify.post("/v1/mandates", { preHandler: opts.requireWeb }, async (req, reply) => {
    const parsed = z.object({ bundle: bundleSchema }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const auth = req.auth!;
    if (auth.kind !== "web") return; // requireWeb above guards this

    const result = await opts.deps.mandateValidator.verifyMandateBundle(parsed.data.bundle);
    if (!result.result.valid || result.mandate === undefined || result.claims === undefined) {
      reply.code(400).send({
        error: "mandate_bundle_invalid",
        reason: result.result.reason ?? "unknown",
      });
      return;
    }

    // Mandate must belong to the authenticated account.
    if (result.mandate.account_id !== auth.account_id) {
      reply.code(403).send({ error: "mandate_account_mismatch" });
      return;
    }

    const now = opts.deps.now?.() ?? new Date();
    await opts.deps.accountStore.setActiveMandate({
      account_id: auth.account_id,
      mandate: result.mandate,
      signed_by_device: result.claims.signing_device_id,
      vouchflow_device_token: result.claims.device_token,
      session_id: result.claims.session_id,
      installed_at: now,
    });
    await opts.deps.accountStore.touchDevice({
      account_id: auth.account_id,
      signing_device_id: result.claims.signing_device_id,
      platform: result.claims.platform,
      now,
    });

    return reply.code(201).send({
      mandate_id: result.mandate.id,
      installed_at: now.toISOString(),
    });
  });

  fastify.get("/v1/mandates/active", { preHandler: opts.requireWeb }, async (req, reply) => {
    const auth = req.auth!;
    if (auth.kind !== "web") return;
    const active = await opts.deps.accountStore.getActiveMandate(auth.account_id);
    if (active === null) {
      reply.code(404).send({ error: "no_active_mandate" });
      return;
    }
    return reply.code(200).send({
      mandate: active.mandate,
      installed_at: active.installed_at.toISOString(),
      signed_by_device: active.signed_by_device,
    });
  });
};
