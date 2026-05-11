// Single-use approval tokens for PENDING_APPROVAL runs.
//
// 32 random bytes base64url-encoded → 43-char token. 5-minute expiry.
// Single-use (burned on successful grant). The PWA navigates to
// /approve/<token>, the user authorizes via Vouchflow, the resulting
// bundle is verified and the token marked used.

import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;
const APPROVAL_TTL_MS = 5 * 60 * 1000;

export interface ApprovalTokenRecord {
  token: string;
  run_id: string;
  account_id: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

export interface ApprovalTokenStore {
  insert(record: ApprovalTokenRecord): Promise<void>;
  findActive(token: string, now: Date): Promise<ApprovalTokenRecord | null>;
  markUsed(token: string, usedAt: Date): Promise<void>;
}

export function issueApprovalToken(input: {
  run_id: string;
  account_id: string;
  now: Date;
}): ApprovalTokenRecord {
  return {
    token: Buffer.from(randomBytes(TOKEN_BYTES)).toString("base64url"),
    run_id: input.run_id,
    account_id: input.account_id,
    expires_at: new Date(input.now.getTime() + APPROVAL_TTL_MS),
    used_at: null,
    created_at: input.now,
  };
}

export function approvalTokenInvalidReason(
  record: ApprovalTokenRecord,
  now: Date,
): null | "used" | "expired" {
  if (record.used_at !== null) return "used";
  if (now > record.expires_at) return "expired";
  return null;
}

export class InMemoryApprovalTokenStore implements ApprovalTokenStore {
  private readonly tokens = new Map<string, ApprovalTokenRecord>();

  async insert(record: ApprovalTokenRecord): Promise<void> {
    this.tokens.set(record.token, { ...record });
  }

  async findActive(token: string, now: Date): Promise<ApprovalTokenRecord | null> {
    const r = this.tokens.get(token);
    if (r === undefined) return null;
    return approvalTokenInvalidReason(r, now) === null ? { ...r } : null;
  }

  async markUsed(token: string, usedAt: Date): Promise<void> {
    const r = this.tokens.get(token);
    if (r === undefined) return;
    r.used_at = usedAt;
  }
}
