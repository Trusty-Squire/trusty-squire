// Auth utility routes — logout + whoami.
//
// /v1/auth/logout: revoke the active web session.
// /v1/auth/whoami: report which provider identities are bound to the
//                  current session's account. Powers the install
//                  wizard's "which steps are done?" state — the
//                  wizard polls this after each OAuth round-trip.
//
// The Vouchflow-signed-bundle /v1/auth/login route was retired
// alongside the native-provision sunset (0.8) — OAuth (Google /
// GitHub) is the sole live login path now, handled by routes/oauth.ts.

import { z } from "zod";
import { ulid } from "ulid";
import { type FastifyPluginAsync, type FastifyReply, type FastifyRequest } from "fastify";
import { clearSessionCookie } from "../auth/middleware.js";
import type { ApiDeps } from "../services/deps.js";

// Body of a recorded passkey step-up. The browser's
// navigator.credentials.get() yields an assertion whose credential id
// we stash for the audit trail; the gating signal is the recency of
// the recorded row, not (yet) a verified signature (see
// passkey-assertion-store.ts).
const passkeyAssertionBody = z.object({
  credential_id: z.string().min(1).max(512).optional(),
});

export const registerAuthRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> = async (fastify, opts) => {
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

  // GET /v1/auth/whoami — used by the install wizard. Returns
  // account_id + the list of OAuth providers the account has bound.
  // Anonymous callers get a 200 with `signed_in: false` (not 401) so
  // the wizard can render its first-step CTA without distinguishing
  // "no session" from "auth broken." No preHandler — the resolveAuth
  // hook already populated req.auth optimistically.
  fastify.get("/v1/auth/whoami", async (req, reply) => {
    const auth = req.auth;
    if (auth?.kind !== "web") {
      return reply.code(200).send({ signed_in: false, identities: [] });
    }
    const identities = await opts.deps.oauthIdentityStore.listByAccount(
      auth.account_id,
    );
    return reply.code(200).send({
      signed_in: true,
      account_id: auth.account_id,
      identities: identities.map((i) => i.provider).sort(),
    });
  });

  // POST /v1/auth/passkey-assertion — record a passkey step-up for the
  // current web session's account. The trusted-session toggle
  // (PATCH /v1/mcp/sessions/:id) gates on one of these being ≤24h old.
  fastify.post(
    "/v1/auth/passkey-assertion",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth;
      if (auth?.kind !== "web") {
        reply.code(401).send({ error: "web_session_required" });
        return;
      }
      const parsed = passkeyAssertionBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply
          .code(400)
          .send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const now = opts.deps.now?.() ?? new Date();
      await opts.deps.passkeyAssertionStore.record({
        id: ulid(),
        account_id: auth.account_id,
        credential_id: parsed.data.credential_id ?? null,
        web_session_id: auth.session_id,
        asserted_at: now,
      });
      return reply.code(201).send({ asserted_at: now.toISOString() });
    },
  );
};
