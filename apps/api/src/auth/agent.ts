// Agent (MCP) session management.
//
// The raw bearer token (`mcp_session_<base64url>`) is shown to the
// MCP installer ONCE at issuance and never persisted. The DB stores
// SHA-256(token) so a DB leak alone is not credential exposure.

import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { ulid } from "ulid";

const RAW_PREFIX = "mcp_session_";
const TOKEN_RANDOM_BYTES = 32;
const AGENT_ABSOLUTE_MS = 24 * 60 * 60 * 1000;

export interface AgentSessionRecord {
  id: string;
  account_id: string;
  token_hash: string;
  agent_identity: string | null;
  agent_version: string | null;
  issued_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  use_count: number;
  revoked_at: Date | null;
  revocation_reason: string | null;
}

export interface AgentSessionStore {
  insert(record: AgentSessionRecord): Promise<void>;
  findActiveByHash(tokenHash: string, now: Date): Promise<AgentSessionRecord | null>;
  bumpUse(id: string, lastUsedAt: Date): Promise<void>;
  revoke(id: string, reason: string): Promise<void>;
}

export function issueAgentSession(input: {
  account_id: string;
  agent_identity: string | null;
  agent_version: string | null;
  now: Date;
}): { raw_token: string; record: AgentSessionRecord } {
  const raw = `${RAW_PREFIX}${Buffer.from(randomBytes(TOKEN_RANDOM_BYTES)).toString("base64url")}`;
  const token_hash = hashToken(raw);
  const record: AgentSessionRecord = {
    id: ulid(),
    account_id: input.account_id,
    token_hash,
    agent_identity: input.agent_identity,
    agent_version: input.agent_version,
    issued_at: input.now,
    expires_at: new Date(input.now.getTime() + AGENT_ABSOLUTE_MS),
    last_used_at: null,
    use_count: 0,
    revoked_at: null,
    revocation_reason: null,
  };
  return { raw_token: raw, record };
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function agentSessionRejectionReason(
  record: AgentSessionRecord,
  now: Date,
): null | "revoked" | "expired" {
  if (record.revoked_at !== null) return "revoked";
  if (now > record.expires_at) return "expired";
  return null;
}

// ── In-memory ────────────────────────────────────────────────

export class InMemoryAgentSessionStore implements AgentSessionStore {
  private readonly byHash = new Map<string, AgentSessionRecord>();

  async insert(record: AgentSessionRecord): Promise<void> {
    this.byHash.set(record.token_hash, { ...record });
  }

  async findActiveByHash(tokenHash: string, now: Date): Promise<AgentSessionRecord | null> {
    const r = this.byHash.get(tokenHash);
    if (r === undefined) return null;
    return agentSessionRejectionReason(r, now) === null ? { ...r } : null;
  }

  async bumpUse(id: string, lastUsedAt: Date): Promise<void> {
    for (const r of this.byHash.values()) {
      if (r.id === id) {
        r.last_used_at = lastUsedAt;
        r.use_count += 1;
        return;
      }
    }
  }

  async revoke(id: string, reason: string): Promise<void> {
    for (const r of this.byHash.values()) {
      if (r.id === id) {
        r.revoked_at = new Date();
        r.revocation_reason = reason;
        return;
      }
    }
  }
}
