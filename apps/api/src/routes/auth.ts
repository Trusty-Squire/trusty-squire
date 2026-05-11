// POST /v1/auth/login — Vouchflow login bundle exchange for a session.
// POST /v1/auth/logout — revoke the active web session.

import { z } from "zod";
import { type FastifyPluginAsync, type FastifyReply, type FastifyRequest } from "fastify";
import { issueSession } from "../auth/session.js";
import { clearSessionCookie, setSessionCookie } from "../auth/middleware.js";
import type { ApiDeps } from "../services/deps.js";

const LOGIN_CONTEXT = "login";

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

const loginPayloadSchema = z.object({
  email: z.string().email(),
});

export const registerAuthRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> = async (fastify, opts) => {
  fastify.post("/v1/auth/login", async (req, reply) => {
    const parsed = z.object({ bundle: bundleSchema }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }

    let claims;
    try {
      claims = await opts.deps.vouchflowVerifier.verify(parsed.data.bundle, LOGIN_CONTEXT, "medium");
    } catch (err) {
      reply.code(401).send({
        error: "bundle_verification_failed",
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (await opts.deps.validatorDeps.isNonceUsed(claims.session_id)) {
      reply.code(409).send({ error: "bundle_already_used" });
      return;
    }

    let payload: { email: string };
    try {
      payload = opts.deps.vouchflowVerifier.parsePayload(parsed.data.bundle);
    } catch {
      reply.code(400).send({ error: "payload_not_json" });
      return;
    }
    const payloadCheck = loginPayloadSchema.safeParse(payload);
    if (!payloadCheck.success) {
      reply.code(400).send({ error: "invalid_payload", issues: payloadCheck.error.issues });
      return;
    }

    const account = await opts.deps.accountStore.findAccountByEmail(payloadCheck.data.email);
    if (account === null) {
      reply.code(404).send({ error: "account_not_found" });
      return;
    }

    const now = opts.deps.now?.() ?? new Date();
    await opts.deps.accountStore.touchDevice({
      account_id: account.id,
      signing_device_id: claims.signing_device_id,
      platform: claims.platform,
      now,
    });
    await opts.deps.validatorDeps.recordNonce(claims.session_id);

    const { record, jwt } = issueSession({
      account_id: account.id,
      ip: req.ip ?? null,
      user_agent: req.headers["user-agent"] ?? null,
      now,
    });
    await opts.deps.sessionStore.insert(record);
    setSessionCookie(reply, jwt, opts.deps.sessionSecret);

    return reply.code(200).send({
      account: { id: account.id, email: account.email },
      session: { id: record.id, absolute_expires_at: record.absolute_expires_at.toISOString() },
    });
  });

  fastify.post("/v1/auth/logout", { preHandler: opts.requireWeb }, async (req, reply) => {
    const auth = req.auth;
    if (auth?.kind !== "web") {
      reply.code(401).send({ error: "web_session_required" });
      return;
    }
    await opts.deps.sessionStore.revoke(auth.jwt_id, "user_logout");
    clearSessionCookie(reply);
    return reply.code(200).send({ ok: true });
  });
};
