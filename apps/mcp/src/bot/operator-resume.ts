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

export class OperatorResumeStoreError extends Error {
  constructor(operation: "read" | "write" | "clear", cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`operator_resume_store_${operation}_failed: ${detail}`);
    this.name = "OperatorResumeStoreError";
  }
}

const SECRET_PATH_HINT =
  /^(?:verify|verification|confirm|confirmation|activate|activation|magic|passwordless|password-reset|reset-password|invitation|invite|one-time|oob|token|code|key|auth|secret|signature|sig|otp)$/i;

function safeResumeUrl(rawUrl: string, allowPublicApprovalPath = false): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new OperatorResumeStoreError("write", error);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OperatorResumeStoreError("write", `unsupported URL protocol ${url.protocol}`);
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  if (!allowPublicApprovalPath) {
    const segments = url.pathname.split("/").filter(Boolean);
    const sensitiveIndex = segments.findIndex((segment) => SECRET_PATH_HINT.test(segment));
    if (sensitiveIndex >= 0 && sensitiveIndex < segments.length - 1) {
      url.pathname = sensitiveIndex === 0 ? "/" : `/${segments.slice(0, sensitiveIndex).join("/")}`;
    }
  }
  return url.toString();
}

function safeCheckout(checkout: CheckoutSummary): CheckoutSummary {
  const originUrl = new URL(safeResumeUrl(checkout.checkout_origin));
  return {
    merchant: checkout.merchant,
    checkout_origin: originUrl.origin,
    amount_cents: checkout.amount_cents,
    currency: checkout.currency,
  };
}

export function sanitizeOperatorResumeMetadata(
  metadata: OperatorResumeMetadata,
): OperatorResumeMetadata {
  return {
    version: 1,
    reconnect_token: metadata.reconnect_token,
    session_id: metadata.session_id,
    url: safeResumeUrl(metadata.url),
    allowed_hosts: metadata.allowed_hosts.map(({ host, source }) => ({ host, source })),
    generation: metadata.generation,
    cart_summary:
      metadata.cart_summary === null
        ? null
        : {
            checkout: safeCheckout(metadata.cart_summary.checkout),
            url: safeResumeUrl(metadata.cart_summary.url),
            observed_at: metadata.cart_summary.observed_at,
          },
    approval_id: metadata.approval_id,
    pending_fill:
      metadata.pending_fill === null
        ? null
        : {
            approval_id: metadata.pending_fill.approval_id,
            approval_url: safeResumeUrl(metadata.pending_fill.approval_url, true),
            checkout: safeCheckout(metadata.pending_fill.checkout),
            ...(metadata.pending_fill.mandate_id !== undefined
              ? { mandate_id: metadata.pending_fill.mandate_id }
              : {}),
          },
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
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
  const validCheckout = (checkout: unknown): checkout is CheckoutSummary => {
    if (checkout === null || typeof checkout !== "object") return false;
    const candidate = checkout as Partial<CheckoutSummary>;
    return (
      typeof candidate.merchant === "string" &&
      typeof candidate.checkout_origin === "string" &&
      typeof candidate.amount_cents === "number" &&
      typeof candidate.currency === "string"
    );
  };
  const validCartSummary =
    data.cart_summary === null ||
    (data.cart_summary !== undefined &&
      validCheckout(data.cart_summary.checkout) &&
      typeof data.cart_summary.url === "string" &&
      typeof data.cart_summary.observed_at === "number");
  const validPendingFill =
    data.pending_fill === null ||
    (data.pending_fill !== undefined &&
      typeof data.pending_fill.approval_id === "string" &&
      typeof data.pending_fill.approval_url === "string" &&
      validCheckout(data.pending_fill.checkout) &&
      (data.pending_fill.mandate_id === undefined ||
        typeof data.pending_fill.mandate_id === "string"));
  return (
    data.version === 1 &&
    typeof data.reconnect_token === "string" &&
    typeof data.session_id === "string" &&
    typeof data.url === "string" &&
    Array.isArray(data.allowed_hosts) &&
    data.allowed_hosts.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof entry.host === "string" &&
        (entry.source === "start" ||
          entry.source === "mid_session" ||
          entry.source === "auto_widen"),
    ) &&
    typeof data.generation === "number" &&
    validCartSummary &&
    (data.approval_id === null || typeof data.approval_id === "string") &&
    validPendingFill
  );
}

export class FileOperatorResumeStore implements OperatorResumeStore {
  constructor(private readonly filePath = defaultResumeFile()) {}

  read(): OperatorResumeMetadata | null {
    let serialized: string;
    try {
      serialized = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new OperatorResumeStoreError("read", error);
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      return validMetadata(parsed) ? sanitizeOperatorResumeMetadata(parsed) : null;
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      if (error instanceof OperatorResumeStoreError) throw error;
      throw new OperatorResumeStoreError("read", error);
    }
  }

  write(metadata: OperatorResumeMetadata): void {
    const dir = path.dirname(this.filePath);
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      const safeMetadata = sanitizeOperatorResumeMetadata(metadata);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify(safeMetadata, null, 2), { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // no-op
      }
      if (error instanceof OperatorResumeStoreError) throw error;
      throw new OperatorResumeStoreError("write", error);
    }
  }

  clear(): void {
    try {
      unlinkSync(this.filePath);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw new OperatorResumeStoreError("clear", error);
    }
  }
}

export function defaultOperatorResumeStore(): OperatorResumeStore {
  return new FileOperatorResumeStore();
}
