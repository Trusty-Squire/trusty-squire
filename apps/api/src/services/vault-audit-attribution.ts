import type { FastifyRequest } from "fastify";
import type { VaultAuditAttribution } from "@trusty-squire/vault";
import { authenticatedRequester } from "./requesting-agent.js";

function header(req: FastifyRequest, name: string): string | null {
  const value = req.headers[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Authenticated provenance for one API call, with safe fallbacks for older clients. */
export function requestAuditAttribution(
  req: FastifyRequest,
  taskFallback: string,
  purpose: string,
): VaultAuditAttribution {
  const auth = req.auth;
  if (auth === undefined) throw new Error("audit attribution requires authenticated request");
  return {
    task_id: header(req, "x-squire-task-id") ?? taskFallback,
    agent_identity: authenticatedRequester(auth),
    invocation_id: header(req, "x-squire-invocation-id") ?? String(req.id),
    purpose,
  };
}
