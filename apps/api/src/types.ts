// Shared types for the API gateway.
//
// AuthIdentity is the union of "who's calling this endpoint":
//   - web: a passkey-authenticated user, Session row in DB
//   - agent: an MCP server bearer token, AgentSession row in DB

export interface WebAuthIdentity {
  kind: "web";
  account_id: string;
  session_id: string;
  jwt_id: string;
}

export interface AgentAuthIdentity {
  kind: "agent";
  account_id: string;
  agent_session_id: string;
  agent_identity: string | null;
}

export type AuthIdentity = WebAuthIdentity | AgentAuthIdentity;

declare module "fastify" {
  // Attach the verified identity to the FastifyRequest so route
  // handlers can read it without re-parsing the cookie/header.
  interface FastifyRequest {
    auth?: AuthIdentity;
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
