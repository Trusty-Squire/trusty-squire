// Prisma-backed OpenIssue store (memory-overhaul Phase 4). Optimistic
// concurrency is enforced via updateMany({ where: { id, version } }) — a
// count of 0 means the version moved under us → conflict. The close-gate
// (checkCloseGate) is the SAME shared rule the in-memory store uses, so the
// two can't diverge on the one constraint that matters.

import {
  createRegistryPrismaClient,
  type RegistryPrismaClient,
} from "./registry-prisma-client.js";
import {
  checkCloseGate,
  issueId,
  type CloseResult,
  type Falsification,
  type IssueStatus,
  type OpenIssueRecord,
  type OpenIssueStore,
} from "./open-issue-store.js";

type Row = {
  id: string;
  service: string;
  failure_kind: string;
  status: string;
  first_seen: Date;
  attempts: number;
  resolved_run: string | null;
  falsified: unknown;
  actor: string | null;
  version: number;
  updated_at: Date;
};

function mapRow(r: Row): OpenIssueRecord {
  return {
    id: r.id,
    service: r.service,
    failure_kind: r.failure_kind,
    status: r.status as IssueStatus,
    first_seen: r.first_seen,
    attempts: r.attempts,
    resolved_run: r.resolved_run,
    falsified: (r.falsified as Falsification | null) ?? null,
    actor: r.actor,
    version: r.version,
    updated_at: r.updated_at,
  };
}

export class PrismaOpenIssueStore implements OpenIssueStore {
  private constructor(private readonly client: RegistryPrismaClient) {}

  static async fromEnv(): Promise<PrismaOpenIssueStore> {
    const client = createRegistryPrismaClient();
    await client.$connect();
    return new PrismaOpenIssueStore(client);
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }

  async seedFailure(service: string, failureKind: string): Promise<OpenIssueRecord> {
    const id = issueId(service, failureKind);
    const prior = await this.client.openIssue.findUnique({ where: { id } });
    if (prior === null) {
      const row = await this.client.openIssue.create({
        data: { id, service, failure_kind: failureKind, status: "open", attempts: 1 },
      });
      return mapRow(row as Row);
    }
    const p = mapRow(prior as Row);
    const reopened: IssueStatus =
      p.status === "resolved" || p.status === "wall" ? "open" : p.status;
    const row = await this.client.openIssue.update({
      where: { id },
      data: {
        status: reopened,
        attempts: p.attempts + 1,
        version: p.version + 1,
        ...(reopened === "open" && p.status !== "open"
          ? { resolved_run: null, falsified: null, actor: null }
          : {}),
      },
    });
    return mapRow(row as Row);
  }

  async resolveServiceOnSuccess(service: string, greenRun: string): Promise<number> {
    const { count } = await this.client.openIssue.updateMany({
      where: { service, status: { not: "resolved" } },
      data: { status: "resolved", resolved_run: greenRun, actor: "auto", falsified: null },
    });
    return count;
  }

  private async versionedUpdate(
    id: string,
    expectedVersion: number,
    data: Record<string, unknown>,
  ): Promise<CloseResult> {
    const { count } = await this.client.openIssue.updateMany({
      where: { id, version: expectedVersion },
      data: { ...data, version: expectedVersion + 1 },
    });
    if (count === 0) {
      const cur = await this.client.openIssue.findUnique({ where: { id } });
      if (cur === null) return { kind: "not_found" };
      return { kind: "version_conflict", current: (cur as Row).version };
    }
    const row = await this.client.openIssue.findUnique({ where: { id } });
    return { kind: "ok", issue: mapRow(row as Row) };
  }

  async claim(id: string, actor: string, expectedVersion: number): Promise<CloseResult> {
    return this.versionedUpdate(id, expectedVersion, { status: "in_progress", actor });
  }

  async closeResolved(
    id: string,
    resolvedRun: string,
    actor: string,
    expectedVersion: number,
  ): Promise<CloseResult> {
    const gate = checkCloseGate("resolved", { resolvedRun });
    if (!gate.ok) return { kind: "missing_evidence", need: gate.need };
    return this.versionedUpdate(id, expectedVersion, {
      status: "resolved",
      resolved_run: resolvedRun,
      actor,
    });
  }

  async closeWall(
    id: string,
    falsified: Falsification,
    actor: string,
    expectedVersion: number,
  ): Promise<CloseResult> {
    const gate = checkCloseGate("wall", { falsified });
    if (!gate.ok) return { kind: "missing_evidence", need: gate.need };
    return this.versionedUpdate(id, expectedVersion, {
      status: "wall",
      falsified: falsified as unknown as Record<string, unknown>,
      actor,
    });
  }

  async get(id: string): Promise<OpenIssueRecord | null> {
    const r = await this.client.openIssue.findUnique({ where: { id } });
    return r === null ? null : mapRow(r as Row);
  }

  async list(status?: IssueStatus): Promise<OpenIssueRecord[]> {
    const rows = await this.client.openIssue.findMany({
      ...(status !== undefined ? { where: { status } } : {}),
      orderBy: { attempts: "desc" },
    });
    return (rows as Row[]).map(mapRow);
  }
}
