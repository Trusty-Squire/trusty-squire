// Auth guards. Two kinds of authenticated request:
//   - Web: ts_session cookie, JWT, idle + absolute expiry, Session row
//   - Agent: Authorization: Bearer mcp_session_<token>, AgentSession row
//
// `requireWeb` and `requireAgent` are explicit guards; `requireAny`
// accepts either and used on shared routes like /v1/runs (POST is
// agent-or-web; GET is the same).

import type { FastifyReply, FastifyRequest } from "fastify";
import {
  hashToken,
  type AgentSessionStore,
} from "./agent.js";
import {
  SESSION_COOKIE_NAME,
  signSessionJwt,
  verifySessionJwt,
  type SessionStore,
} from "./session.js";

export interface AuthDeps {
  sessionStore: SessionStore;
  agentSessionStore: AgentSessionStore;
  sessionSecret: string;
  now?: () => Date;
}

const BEARER_PREFIX = "Bearer mcp_session_";

export function makeAuthMiddleware(deps: AuthDeps) {
  const now = (): Date => deps.now?.() ?? new Date();

  async function attachWebSession(req: FastifyRequest): Promise<void> {
    const cookie = req.cookies?.[SESSION_COOKIE_NAME];
    if (cookie === undefined || cookie.length === 0) return;
    const decoded = verifySessionJwt(cookie, deps.sessionSecret);
    if (decoded === null) return;
    const record = await deps.sessionStore.findActive(decoded.jti, now());
    if (record === null) return;

    // Idle refresh — bump last_active_at + re-sign cookie if iat is
    // older than ~1 minute (avoids hammering the DB on every request
    // in a tight loop).
    await deps.sessionStore.touch(decoded.jti, now());

    req.auth = {
      kind: "web",
      account_id: record.account_id,
      session_id: record.id,
      jwt_id: record.jwt_id,
    };
  }

  async function attachAgentSession(req: FastifyRequest): Promise<void> {
    const auth = req.headers.authorization;
    if (typeof auth !== "string" || !auth.startsWith(BEARER_PREFIX)) return;
    const raw = auth.slice(7); // strip "Bearer "
    const tokenHash = hashToken(raw);
    const record = await deps.agentSessionStore.findActiveByHash(tokenHash, now());
    if (record === null) return;
    await deps.agentSessionStore.bumpUse(record.id, now());

    req.auth = {
      kind: "agent",
      account_id: record.account_id,
      agent_session_id: record.id,
      agent_identity: record.agent_identity,
    };
  }

  async function resolveAuth(req: FastifyRequest): Promise<void> {
    if (req.auth !== undefined) return;
    await attachWebSession(req);
    if (req.auth === undefined) await attachAgentSession(req);
  }

  return {
    resolveAuth,

    async requireWeb(req: FastifyRequest, reply: FastifyReply): Promise<void> {
      await resolveAuth(req);
      if (req.auth?.kind !== "web") {
        reply.code(401).send({ error: "web_session_required" });
        return reply;
      }
    },

    async requireAgent(req: FastifyRequest, reply: FastifyReply): Promise<void> {
      await resolveAuth(req);
      if (req.auth?.kind !== "agent") {
        reply.code(401).send({ error: "agent_session_required" });
        return reply;
      }
    },

    async requireAny(req: FastifyRequest, reply: FastifyReply): Promise<void> {
      await resolveAuth(req);
      if (req.auth === undefined) {
        reply.code(401).send({ error: "authentication_required" });
        return reply;
      }
    },
  };
}

// Helper for routes that issue a new session cookie.
export function setSessionCookie(
  reply: FastifyReply,
  jwt: Parameters<typeof signSessionJwt>[0],
  secret: string,
): void {
  const token = signSessionJwt(jwt, secret);
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // Cookie outlives the idle window but not the absolute one — the
    // server-side check is authoritative.
    expires: new Date(jwt.exp * 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.setCookie(SESSION_COOKIE_NAME, "", { path: "/", expires: new Date(0) });
}
