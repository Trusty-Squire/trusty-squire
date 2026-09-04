import type { AuthIdentity } from "../types.js";

export function authenticatedRequester(auth: AuthIdentity): string {
  if (auth.kind === "web") return `web-session:${auth.session_id}`;
  return auth.agent_identity ?? `agent-session:${auth.agent_session_id}`;
}
