// Durable, deliberately non-secret recovery record for the one live operator
// session.  This file is a breadcrumb for reconnecting a restarted MCP process;
// it is not a second session store and must never contain card data, sealed
// slots, credentials, or the approval HPKE private key.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CheckoutSummary } from "./browser.js";

export interface OperatorResumePendingFill {
  approval_id: string;
  approval_url: string;
  checkout: CheckoutSummary;
  // The PAN, CVV, card reference, last four digits, billing data, and any
  // vault/key material never enter this record.
  mandate_id?: string;
}

export interface OperatorResumeMetadata {
  version: 1;
  reconnect_token: string;
  session_id: string;
  url: string;
  start_url: string;
  allowed_hosts: Array<{ host: string; source: "start" | "mid_session" | "auto_widen" }>;
  generation: number;
  cart_summary: { checkout: CheckoutSummary; url: string; observed_at: number } | null;
  approval_id: string | null;
  pending_fill: OperatorResumePendingFill | null;
}

export interface OperatorResumeStore {
  read(): OperatorResumeMetadata | null;
  write(metadata: OperatorResumeMetadata): void;
  clear(): void;
}

function defaultResumeFile(): string {
  if (process.env.TRUSTY_SQUIRE_OPERATOR_RESUME_FILE !== undefined) {
    return process.env.TRUSTY_SQUIRE_OPERATOR_RESUME_FILE;
  }
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "trusty-squire", "operator-resume.json");
}

function validMetadata(value: unknown): value is OperatorResumeMetadata {
  if (value === null || typeof value !== "object") return false;
  const data = value as Partial<OperatorResumeMetadata>;
  return (
    data.version === 1 &&
    typeof data.reconnect_token === "string" &&
    typeof data.session_id === "string" &&
    typeof data.url === "string" &&
    typeof data.start_url === "string" &&
    Array.isArray(data.allowed_hosts) &&
    typeof data.generation === "number" &&
    (data.approval_id === null || typeof data.approval_id === "string") &&
    (data.pending_fill === null || typeof data.pending_fill === "object")
  );
}

export class FileOperatorResumeStore implements OperatorResumeStore {
  constructor(private readonly filePath = defaultResumeFile()) {}

  read(): OperatorResumeMetadata | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      return validMetadata(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  write(metadata: OperatorResumeMetadata): void {
    const dir = path.dirname(this.filePath);
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify(metadata, null, 2), { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch {
      // Recovery is best-effort. A read-only home must not turn an otherwise
      // safe browser action into a server failure.
      try {
        unlinkSync(tmp);
      } catch {
        // no-op
      }
    }
  }

  clear(): void {
    try {
      unlinkSync(this.filePath);
    } catch {
      // no-op
    }
  }
}

export function defaultOperatorResumeStore(): OperatorResumeStore {
  return new FileOperatorResumeStore();
}
