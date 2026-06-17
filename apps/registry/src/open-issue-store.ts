// OpenIssue — memory-overhaul Phase 4. The drainable failure-ledger with a
// SERVER-SIDE close-gate. The gate is the whole point: a ticket cannot reach
// `resolved` without a green-run pointer, nor `wall` without a falsification
// record. That's what mechanically blocks "I gave up and called it a wall".
//
// Seeded from the ProvisionEvent firehose; a success drains the service's open
// tickets; optimistic concurrency keeps parallel loop workers from stomping.

export type IssueStatus = "open" | "in_progress" | "resolved" | "wall";

// The falsification record required to close a ticket as a `wall`. Mirrors the
// STATE.md discipline: name the experiment + its result, optionally point at
// the evidence (a provision_id / artifacts_uri).
export interface Falsification {
  experiment: string;
  result: string;
  evidence_ref?: string;
}

export interface OpenIssueRecord {
  id: string;
  service: string;
  failure_kind: string;
  status: IssueStatus;
  first_seen: Date;
  attempts: number;
  resolved_run: string | null;
  falsified: Falsification | null;
  actor: string | null;
  version: number;
  updated_at: Date;
}

export function issueId(service: string, failureKind: string): string {
  return `${service}:${failureKind}`;
}

// Close-gate verdicts — the store returns these instead of throwing so the
// route maps them to clean HTTP codes.
export type CloseResult =
  | { kind: "ok"; issue: OpenIssueRecord }
  | { kind: "not_found" }
  | { kind: "version_conflict"; current: number }
  | { kind: "missing_evidence"; need: "resolved_run" | "falsified" };

export interface OpenIssueStore {
  /** Seed/reopen a ticket on a failed run. Open or in_progress stays as-is
   *  (attempts++); a resolved/wall ticket REOPENS (the failure recurred). */
  seedFailure(service: string, failureKind: string): Promise<OpenIssueRecord>;
  /** Drain on green: resolve every non-resolved ticket for the service with
   *  the green run id (actor="auto"). Returns how many it closed. A green run
   *  even resolves a `wall` — if it went green, it wasn't a wall. */
  resolveServiceOnSuccess(service: string, greenRun: string): Promise<number>;
  /** Loop worker claims a ticket → in_progress. Optimistic concurrency. */
  claim(id: string, actor: string, expectedVersion: number): Promise<CloseResult>;
  /** Close `resolved` — REQUIRES a green-run pointer. */
  closeResolved(
    id: string,
    resolvedRun: string,
    actor: string,
    expectedVersion: number,
  ): Promise<CloseResult>;
  /** Close `wall` — REQUIRES a falsification record. */
  closeWall(
    id: string,
    falsified: Falsification,
    actor: string,
    expectedVersion: number,
  ): Promise<CloseResult>;
  get(id: string): Promise<OpenIssueRecord | null>;
  list(status?: IssueStatus): Promise<OpenIssueRecord[]>;
}

// Shared close-gate so the in-memory and Prisma stores can't diverge on the
// one rule that matters. Returns the evidence verdict; the caller applies it.
export function checkCloseGate(
  target: "resolved" | "wall",
  evidence: { resolvedRun?: string; falsified?: Falsification },
): { ok: true } | { ok: false; need: "resolved_run" | "falsified" } {
  if (target === "resolved") {
    return evidence.resolvedRun !== undefined && evidence.resolvedRun.length > 0
      ? { ok: true }
      : { ok: false, need: "resolved_run" };
  }
  // wall: require a non-empty experiment AND result.
  const f = evidence.falsified;
  const valid =
    f !== undefined &&
    typeof f.experiment === "string" &&
    f.experiment.trim().length > 0 &&
    typeof f.result === "string" &&
    f.result.trim().length > 0;
  return valid ? { ok: true } : { ok: false, need: "falsified" };
}

export class InMemoryOpenIssueStore implements OpenIssueStore {
  private readonly rows = new Map<string, OpenIssueRecord>();

  async seedFailure(service: string, failureKind: string): Promise<OpenIssueRecord> {
    const id = issueId(service, failureKind);
    const prior = this.rows.get(id);
    if (prior === undefined) {
      const row: OpenIssueRecord = {
        id,
        service,
        failure_kind: failureKind,
        status: "open",
        first_seen: new Date(),
        attempts: 1,
        resolved_run: null,
        falsified: null,
        actor: null,
        version: 0,
        updated_at: new Date(),
      };
      this.rows.set(id, row);
      return row;
    }
    // A recurrence: bump attempts; a resolved/wall ticket reopens (the bug
    // came back, or the "wall" wasn't one). open/in_progress just counts up.
    const reopened: IssueStatus =
      prior.status === "resolved" || prior.status === "wall" ? "open" : prior.status;
    const row: OpenIssueRecord = {
      ...prior,
      status: reopened,
      attempts: prior.attempts + 1,
      // Clear stale close-evidence on reopen.
      ...(reopened === "open" && prior.status !== "open"
        ? { resolved_run: null, falsified: null, actor: null }
        : {}),
      version: prior.version + 1,
      updated_at: new Date(),
    };
    this.rows.set(id, row);
    return row;
  }

  async resolveServiceOnSuccess(service: string, greenRun: string): Promise<number> {
    let n = 0;
    for (const [id, row] of this.rows) {
      if (row.service !== service || row.status === "resolved") continue;
      this.rows.set(id, {
        ...row,
        status: "resolved",
        resolved_run: greenRun,
        actor: "auto",
        falsified: null,
        version: row.version + 1,
        updated_at: new Date(),
      });
      n += 1;
    }
    return n;
  }

  private transition(
    id: string,
    expectedVersion: number,
    mutate: (r: OpenIssueRecord) => OpenIssueRecord,
  ): CloseResult {
    const prior = this.rows.get(id);
    if (prior === undefined) return { kind: "not_found" };
    if (prior.version !== expectedVersion) {
      return { kind: "version_conflict", current: prior.version };
    }
    const next = mutate(prior);
    this.rows.set(id, next);
    return { kind: "ok", issue: next };
  }

  async claim(id: string, actor: string, expectedVersion: number): Promise<CloseResult> {
    return this.transition(id, expectedVersion, (r) => ({
      ...r,
      status: "in_progress",
      actor,
      version: r.version + 1,
      updated_at: new Date(),
    }));
  }

  async closeResolved(
    id: string,
    resolvedRun: string,
    actor: string,
    expectedVersion: number,
  ): Promise<CloseResult> {
    const gate = checkCloseGate("resolved", { resolvedRun });
    if (!gate.ok) return { kind: "missing_evidence", need: gate.need };
    return this.transition(id, expectedVersion, (r) => ({
      ...r,
      status: "resolved",
      resolved_run: resolvedRun,
      actor,
      version: r.version + 1,
      updated_at: new Date(),
    }));
  }

  async closeWall(
    id: string,
    falsified: Falsification,
    actor: string,
    expectedVersion: number,
  ): Promise<CloseResult> {
    const gate = checkCloseGate("wall", { falsified });
    if (!gate.ok) return { kind: "missing_evidence", need: gate.need };
    return this.transition(id, expectedVersion, (r) => ({
      ...r,
      status: "wall",
      falsified,
      actor,
      version: r.version + 1,
      updated_at: new Date(),
    }));
  }

  async get(id: string): Promise<OpenIssueRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async list(status?: IssueStatus): Promise<OpenIssueRecord[]> {
    const all = [...this.rows.values()];
    const filtered = status === undefined ? all : all.filter((r) => r.status === status);
    return filtered.sort((a, b) => b.attempts - a.attempts);
  }
}
