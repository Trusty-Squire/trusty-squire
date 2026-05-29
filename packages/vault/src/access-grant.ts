// AccessGrant — the broker record behind agent-mediated credential
// access. An agent asks for a credential (raw value, or a server-side
// proxied HTTP call); the user approves in the web UI; the grant tracks
// that decision and its lifetime.
//
// State machine (see DESIGN doc / plan):
//
//   pending ──5min──→ expired
//      │
//      ├─ deny    → denied
//      └─ approve → approved ──┬─ once       → consumed (single use)
//                              ├─ session    → (value until expires_at)
//                              └─ persistent → (value until expires_at)
//
//   rotate(reference)           → approved persistent grants → revoked
//   user revoke                 → pending|approved           → revoked
//
// Every transition is a conditional UPDATE guarded on the current
// status (and account_id) so double-clicks and approve/revoke races
// resolve to a single winner — the loser sees zero rows affected.

// Window a pending request stays actionable before it auto-expires.
export const PENDING_TTL_SECONDS = 5 * 60; // 5 min
// Default + ceiling for an approved persistent grant (user-locked).
export const DEFAULT_PERSISTENT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7d
export const MAX_PERSISTENT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30d

export type GrantIntent = "value" | "proxy";
export type GrantMode = "once" | "session" | "persistent";
export type GrantStatus =
  | "pending"
  | "approved"
  | "denied"
  | "revoked"
  | "consumed"
  | "expired";

export interface AccessGrantRecord {
  id: string;
  account_id: string;
  reference: string;
  agent_session_id: string;
  intent: GrantIntent;
  mode: GrantMode;
  ttl_seconds: number;
  purpose: string;
  // Required when intent="value" (justifies why the proxy won't do).
  reason_proxy_not_possible: string | null;
  // intent="proxy" only — the host the proxy will call; checked against
  // the credential's advisory allowlist for trusted auto-approval.
  requested_target_host: string | null;
  requested_at: Date;
  decided_at: Date | null;
  // For pending: the request deadline. For approved: the grant's death.
  expires_at: Date | null;
  status: GrantStatus;
  auto_approved: boolean;
}

// Effective status accounting for the clock — a pending request past
// its deadline, or an approved grant past expires_at, reads as expired
// without needing a sweep to have run. The stored status is unchanged;
// callers persist the transition lazily where it matters.
export function effectiveGrantStatus(
  record: Pick<AccessGrantRecord, "status" | "expires_at">,
  now: Date,
): GrantStatus {
  if (
    (record.status === "pending" || record.status === "approved") &&
    record.expires_at !== null &&
    now.getTime() > record.expires_at.getTime()
  ) {
    return "expired";
  }
  return record.status;
}

export interface AccessGrantStore {
  insert(record: AccessGrantRecord): Promise<void>;

  // Account-scoped single lookup — the web approval surface.
  findByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<AccessGrantRecord | null>;
  // Agent-session-scoped single lookup — the agent's poll path. The
  // agent may only ever see grants its own session created.
  findByIdForAgentSession(
    id: string,
    agentSessionId: string,
  ): Promise<AccessGrantRecord | null>;

  // Web dashboard: still-pending requests for the account, newest first.
  listPendingByAccount(accountId: string): Promise<AccessGrantRecord[]>;
  // Cheap nav-badge count.
  countPendingByAccount(accountId: string): Promise<number>;

  // ── Conditional transitions (return rows affected) ───────────
  // Each guards on the prior status so concurrent callers race to a
  // single winner. Zero rows → the caller lost the race / illegal move.

  // pending → approved (sets mode, ttl, expires_at, decided_at).
  approve(input: {
    id: string;
    accountId: string;
    mode: GrantMode;
    ttlSeconds: number;
    expiresAt: Date;
    decidedAt: Date;
  }): Promise<number>;
  // pending → denied.
  deny(input: { id: string; accountId: string; decidedAt: Date }): Promise<number>;
  // pending|approved → revoked.
  revoke(input: { id: string; accountId: string }): Promise<number>;
  // approved → consumed (single-use "once" grants).
  consume(input: { id: string; accountId: string }): Promise<number>;

  // Rotation cascade: every approved persistent grant for a reference
  // → revoked. Returns the count revoked.
  revokePersistentByReference(
    reference: string,
    accountId: string,
  ): Promise<number>;
}

// ── In-memory implementation (tests + dev) ─────────────────────

function clone(r: AccessGrantRecord): AccessGrantRecord {
  return { ...r };
}

export class InMemoryAccessGrantStore implements AccessGrantStore {
  private readonly byId = new Map<string, AccessGrantRecord>();

  async insert(record: AccessGrantRecord): Promise<void> {
    if (this.byId.has(record.id)) {
      throw new Error(`access grant already exists: ${record.id}`);
    }
    this.byId.set(record.id, clone(record));
  }

  async findByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<AccessGrantRecord | null> {
    const r = this.byId.get(id);
    return r !== undefined && r.account_id === accountId ? clone(r) : null;
  }

  async findByIdForAgentSession(
    id: string,
    agentSessionId: string,
  ): Promise<AccessGrantRecord | null> {
    const r = this.byId.get(id);
    return r !== undefined && r.agent_session_id === agentSessionId
      ? clone(r)
      : null;
  }

  async listPendingByAccount(accountId: string): Promise<AccessGrantRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.account_id === accountId && r.status === "pending")
      .sort((a, b) => b.requested_at.getTime() - a.requested_at.getTime())
      .map(clone);
  }

  async countPendingByAccount(accountId: string): Promise<number> {
    return [...this.byId.values()].filter(
      (r) => r.account_id === accountId && r.status === "pending",
    ).length;
  }

  async approve(input: {
    id: string;
    accountId: string;
    mode: GrantMode;
    ttlSeconds: number;
    expiresAt: Date;
    decidedAt: Date;
  }): Promise<number> {
    const r = this.byId.get(input.id);
    if (r === undefined || r.account_id !== input.accountId || r.status !== "pending") {
      return 0;
    }
    r.status = "approved";
    r.mode = input.mode;
    r.ttl_seconds = input.ttlSeconds;
    r.expires_at = input.expiresAt;
    r.decided_at = input.decidedAt;
    return 1;
  }

  async deny(input: {
    id: string;
    accountId: string;
    decidedAt: Date;
  }): Promise<number> {
    const r = this.byId.get(input.id);
    if (r === undefined || r.account_id !== input.accountId || r.status !== "pending") {
      return 0;
    }
    r.status = "denied";
    r.decided_at = input.decidedAt;
    return 1;
  }

  async revoke(input: { id: string; accountId: string }): Promise<number> {
    const r = this.byId.get(input.id);
    if (
      r === undefined ||
      r.account_id !== input.accountId ||
      (r.status !== "pending" && r.status !== "approved")
    ) {
      return 0;
    }
    r.status = "revoked";
    return 1;
  }

  async consume(input: { id: string; accountId: string }): Promise<number> {
    const r = this.byId.get(input.id);
    if (r === undefined || r.account_id !== input.accountId || r.status !== "approved") {
      return 0;
    }
    r.status = "consumed";
    return 1;
  }

  async revokePersistentByReference(
    reference: string,
    accountId: string,
  ): Promise<number> {
    let count = 0;
    for (const r of this.byId.values()) {
      if (
        r.account_id === accountId &&
        r.reference === reference &&
        r.mode === "persistent" &&
        r.status === "approved"
      ) {
        r.status = "revoked";
        count += 1;
      }
    }
    return count;
  }
}
