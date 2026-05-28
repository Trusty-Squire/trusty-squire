// POST /v1/auth/logout — revoke the active web session.
//
// The Vouchflow-signed-bundle /v1/auth/login route was retired
// alongside the native-provision sunset (0.8) — OAuth (Google /
// GitHub) is the sole live login path now, handled by
// routes/oauth.ts. Logout stays because every web session — OAuth
// or otherwise — still needs a way to end.

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
};
