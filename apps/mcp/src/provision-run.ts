import { randomBytes } from "crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type EvidenceSeverity = "debug" | "info" | "warn" | "error";

export interface EvidenceEvent {
  at: string;
  kind: string;
  severity: EvidenceSeverity;
  data?: Record<string, unknown>;
}

export interface EvidencePersistenceStatus {
  path?: string;
  attempted: boolean;
  ok: boolean | null;
  error?: string;
}

export class EvidenceLedger {
  private readonly events: EvidenceEvent[] = [];
  private attemptedPersist = false;
  private lastPersistOk: boolean | null = null;
  private lastPersistError: string | undefined;

  constructor(private readonly path?: string) {}

  append(kind: string, data?: Record<string, unknown>, severity: EvidenceSeverity = "info"): void {
    this.events.push({
      at: new Date().toISOString(),
      kind,
      severity,
      ...(data !== undefined ? { data } : {}),
    });
    this.persist();
  }

  snapshot(): EvidenceEvent[] {
    return this.events.map((event) => ({
      ...event,
      ...(event.data !== undefined ? { data: { ...event.data } } : {}),
    }));
  }

  persistenceStatus(): EvidencePersistenceStatus {
    return {
      ...(this.path !== undefined ? { path: this.path } : {}),
      attempted: this.attemptedPersist,
      ok: this.lastPersistOk,
      ...(this.lastPersistError !== undefined ? { error: this.lastPersistError } : {}),
    };
  }

  private persist(): void {
    if (this.path === undefined) return;
    this.attemptedPersist = true;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2));
      renameSync(tmp, this.path);
      this.lastPersistOk = true;
      this.lastPersistError = undefined;
    } catch (err) {
      this.lastPersistOk = false;
      this.lastPersistError = err instanceof Error ? err.message : String(err);
      // Evidence must never break provisioning. The in-memory ledger remains
      // authoritative for the current run; the sidecar is best-effort durability.
    }
  }
}

export interface ProvisionRunInit {
  service: string;
  accountId: string;
  runId?: string;
  provisionId?: string;
  evidenceDir?: string | null;
}

export interface ProvisionRun {
  runId: string;
  provisionId: string;
  service: string;
  accountId: string;
  startedAt: number;
  evidence: EvidenceLedger;
  evidencePath?: string;
}

export function generateRunId(): string {
  return `mcp-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function generateProvisionRunId(): string {
  return `prov-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

function evidenceDirFromEnv(): string | null {
  const raw = process.env.TRUSTY_SQUIRE_PROVISION_EVIDENCE_DIR;
  if (raw !== undefined) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed === "off" || trimmed === "0") return null;
    return trimmed;
  }
  return join(homedir(), ".trusty-squire", "provision-runs");
}

function slugOf(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "service";
}

export function createProvisionRun(init: ProvisionRunInit): ProvisionRun {
  const provisionId = init.provisionId ?? generateProvisionRunId();
  const evidenceDir = init.evidenceDir === undefined ? evidenceDirFromEnv() : init.evidenceDir;
  const evidencePath =
    evidenceDir === null
      ? undefined
      : join(evidenceDir, `${slugOf(init.service)}-${provisionId}.evidence.json`);
  const run: ProvisionRun = {
    runId: init.runId ?? generateRunId(),
    provisionId,
    service: init.service,
    accountId: init.accountId,
    startedAt: Date.now(),
    evidence: new EvidenceLedger(evidencePath),
    ...(evidencePath !== undefined ? { evidencePath } : {}),
  };
  run.evidence.append("provision.run.started", {
    run_id: run.runId,
    provision_id: run.provisionId,
    service: run.service,
    account_id: run.accountId,
  });
  return run;
}
