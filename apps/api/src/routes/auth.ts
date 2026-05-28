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

import { type FastifyPluginAsync, type FastifyReply, type FastifyRequest } from "fastify";
import { clearSessionCookie } from "../auth/middleware.js";
import type { ApiDeps } from "../services/deps.js";

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
};
