// POST /v1/accounts — registration. Two supported contexts on the
// signed bundle:
//
//   1. `account_register`              — registration only, medium confidence.
//      Payload: { email, display_name }.
//      Mandate must be signed in a separate ceremony via POST /v1/mandates.
//
//   2. `account_register_with_mandate` — registration + first mandate
//      in a single ceremony, high confidence. Payload:
//      { email, display_name, policy, expires_at }.
//      Server creates account, derives canonical Mandate from policy,
//      stores both atomically, returns both. Cuts onboarding ceremonies
//      from 3 (enroll + register + sign-mandate) to 2 (enroll + combined).
//
// `account_register*` contexts are distinct from `login` so a stolen
// login bundle can't be used to register a different account.

import { z } from "zod";
import { type FastifyPluginAsync } from "fastify";
import { ApiError } from "../types.js";
import { issueSession } from "../auth/session.js";
import { setSessionCookie } from "../auth/middleware.js";
import type { ApiDeps } from "../services/deps.js";
import { policyToMandate } from "../services/policy-to-mandate.js";
import type { SigningDevice, ConfidenceLevel } from "@trusty-squire/mandate-validator";

const REGISTER_CONTEXT = "account_register";
const REGISTER_WITH_MANDATE_CONTEXT = "account_register_with_mandate";

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

const confidenceLevel = z.enum(["low", "medium", "high"]);

const policySchema = z.object({
  spend_limit_cents_per_month: z.number().int().nonnegative(),
  allowed_categories: z.array(z.string()),
  silent_signup: z.object({
    max_monthly_cost_cents: z.number().int().nonnegative(),
    allow_free: z.boolean(),
  }),
  approval_required_categories: z.array(z.string()),
  confidence_requirements: z.object({
    login: confidenceLevel,
    mandate_signing: confidenceLevel,
    delta_mandate_signing: confidenceLevel,
    provision_silent: confidenceLevel,
    provision_approved: confidenceLevel,
    amend_mandate: confidenceLevel,
    cancel: confidenceLevel,
    rotate: confidenceLevel,
    release_identity: confidenceLevel,
  }),
});

const registerPayloadSchema = z.object({
  email: z.string().email(),
  display_name: z.string().min(1).max(120),
});

const registerWithMandatePayloadSchema = registerPayloadSchema.extend({
  policy: policySchema,
  expires_at: z.string().datetime(),
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

    // Route on context. Unknown context = explicit 400 — never silently
    // fall through to a different verification path.
    const isCombined = bundle.context === REGISTER_WITH_MANDATE_CONTEXT;
    const isRegisterOnly = bundle.context === REGISTER_CONTEXT;
    if (!isCombined && !isRegisterOnly) {
      reply.code(400).send({ error: "unsupported_context", context: bundle.context });
      return;
    }

    // Combined ceremony requires high confidence (it covers a
    // mandate-signing); register-only requires medium.
    const requiredConfidence = isCombined ? "high" : "medium";
    const context = isCombined ? REGISTER_WITH_MANDATE_CONTEXT : REGISTER_CONTEXT;

    let claims;
    try {
      claims = await opts.deps.vouchflowVerifier.verify(bundle, context, requiredConfidence);
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

    let rawPayload: unknown;
    try {
      rawPayload = opts.deps.vouchflowVerifier.parsePayload(bundle);
    } catch {
      reply.code(400).send({ error: "payload_not_json" });
      return;
    }

    const now = opts.deps.now?.() ?? new Date();

    if (isCombined) {
      const payloadCheck = registerWithMandatePayloadSchema.safeParse(rawPayload);
      if (!payloadCheck.success) {
        reply.code(400).send({ error: "invalid_payload", issues: payloadCheck.error.issues });
        return;
      }
      const data = payloadCheck.data;

      const account = await opts.deps.accountStore.createAccount(data.email, data.display_name);

      await opts.deps.accountStore.touchDevice({
        account_id: account.id,
        signing_device_id: claims.signing_device_id,
        platform: claims.platform,
        now,
      });

      const signingDevice: SigningDevice = {
        id: claims.signing_device_id,
        // The Vouchflow JWS uses EdDSA over Ed25519 in v1; we record it
        // here as the registered platform credential's signing alg.
        alg: "Ed25519",
        public_key: "",
        platform: claims.platform,
        registered_at: now.toISOString(),
        revoked_at: null,
      };

      const mandate = policyToMandate({
        policy: data.policy as unknown as Parameters<typeof policyToMandate>[0]["policy"],
        accountId: account.id,
        signedAt: now.toISOString(),
        expiresAt: data.expires_at,
        signingDevice,
      });

      await opts.deps.accountStore.setActiveMandate({
        account_id: account.id,
        mandate,
        signed_by_device: claims.signing_device_id,
        vouchflow_device_token: claims.device_token,
        session_id: claims.session_id,
        installed_at: now,
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
        mandate: {
          id: mandate.id,
          not_before: mandate.not_before,
          not_after: mandate.not_after,
        },
        session: { id: record.id, absolute_expires_at: record.absolute_expires_at.toISOString() },
      });
    }

    // Register-only path (backward compat).
    const payloadCheck = registerPayloadSchema.safeParse(rawPayload);
    if (!payloadCheck.success) {
      reply.code(400).send({ error: "invalid_payload", issues: payloadCheck.error.issues });
      return;
    }

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

// Exported for unused-import suppression in the helper above.
export type { ConfidenceLevel };
export { ApiError };
