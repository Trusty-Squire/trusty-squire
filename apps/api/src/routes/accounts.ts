// POST /v1/accounts — registration. Two-shot pattern:
//   1. Client calls Vouchflow.shared.signPayload({ context: 'account_register',
//      payload: { email, display_name }, minConfidence: 'medium' })
//   2. Client POSTs the bundle here.
// We verify the bundle, create the Account row, record the signing
// device, and issue a fresh session cookie.
//
// `account_register` is its own context — distinct from `login` so a
// stolen login bundle can't be used to register a different account.

import { z } from "zod";
import { type FastifyPluginAsync } from "fastify";
import { ApiError } from "../types.js";
import { issueSession } from "../auth/session.js";
import { setSessionCookie } from "../auth/middleware.js";
import type { ApiDeps } from "../services/deps.js";

const REGISTER_CONTEXT = "account_register";

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

const bodySchema = z.object({
  bundle: bundleSchema,
});

export const registerAccountsRoute: FastifyPluginAsync<{ deps: ApiDeps }> = async (
  fastify,
  opts,
) => {
  fastify.post("/v1/accounts", async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const { bundle } = parsed.data;

    let claims;
    try {
      claims = await opts.deps.vouchflowVerifier.verify(bundle, REGISTER_CONTEXT, "medium");
    } catch (err) {
      reply.code(401).send({
        error: "bundle_verification_failed",
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Burn the Vouchflow session_id so the same bundle can't register
    // twice. The bundle's session_id is single-use on Vouchflow's
    // side too; this is defense-in-depth.
    if (await opts.deps.validatorDeps.isNonceUsed(claims.session_id)) {
      reply.code(409).send({ error: "bundle_already_used" });
      return;
    }

    let payload: { email: string; display_name: string };
    try {
      payload = opts.deps.vouchflowVerifier.parsePayload(bundle);
    } catch {
      reply.code(400).send({ error: "payload_not_json" });
      return;
    }

    const payloadCheck = registerPayloadSchema.safeParse(payload);
    if (!payloadCheck.success) {
      reply.code(400).send({ error: "invalid_payload", issues: payloadCheck.error.issues });
      return;
    }

    const now = opts.deps.now?.() ?? new Date();
    const account = await opts.deps.accountStore.createAccount(
      payloadCheck.data.email,
      payloadCheck.data.display_name,
    );

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

    return reply.code(201).send({
      account: {
        id: account.id,
        email: account.email,
        display_name: account.display_name,
      },
      session: { id: record.id, absolute_expires_at: record.absolute_expires_at.toISOString() },
    });
  });
};

const registerPayloadSchema = z.object({
  email: z.string().email(),
  display_name: z.string().min(1).max(120),
});

export { ApiError };
