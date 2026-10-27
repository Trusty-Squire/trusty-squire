// Sealed delivery to the app that asked: the SDK's `credentials.requestReveal`
// and `payments.request`.
//
// An app that requests a reveal or a payment names its own HPKE public key.
// The approval is then bound to that key AND to the agent session that asked:
//
//   * the passkey signs over the key's hash (reveal: `recipient_pubkey_hash`
//     in the fetch payload; payment: the same field the broker's payment
//     payload already carries), so the human approves delivery to that key;
//   * only that session can claim, and only once (`markClaimed`);
//   * the value travels sealed to that key with the broker's HPKE suite
//     (`@trusty-squire/vault/hpke`), never in plaintext.
//
// Approvals with no row here are the MCP broker's, and every existing route
// treats them exactly as before.

import { createHash } from "node:crypto";
import type { ApiPrismaClient, SealedApprovalClaimRow } from "./api-prisma-client.js";

export type SealedClaimKind = "credential_fetch" | "payment";

export interface SealedClaimBinding {
  approvalId: string;
  kind: SealedClaimKind;
  accountId: string;
  agentSessionId: string;
  recipientPublicKey: string;
  claimedAt: Date | null;
  createdAt: Date;
}

export interface SealedClaimStore {
  create(input: Omit<SealedClaimBinding, "claimedAt" | "createdAt">): Promise<void>;
  get(approvalId: string): Promise<SealedClaimBinding | null>;
  /** True exactly once per approval: the single-use claim. */
  markClaimed(approvalId: string, agentSessionId: string, at: Date): Promise<boolean>;
}

/** An X25519 public key, base64url, as the broker's HPKE module serializes it. */
export function isRecipientPublicKey(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  return Buffer.from(value, "base64url").byteLength === 32;
}

/** The same hash the payment payload binds as `recipient_pubkey_hash`. */
export function recipientPublicKeyHash(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url");
}

/**
 * The HPKE associated data for a sealed reveal. It names the approval, so a
 * sealed delivery cannot be replayed as the answer to a different approval.
 * The SDK builds the same bytes to open it.
 */
export function revealSealAad(approvalId: string): Uint8Array {
  return new TextEncoder().encode(`trusty-squire/credential-reveal/v1\n${approvalId}`);
}

export class InMemorySealedClaimStore implements SealedClaimStore {
  private readonly rows = new Map<string, SealedClaimBinding>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(input: Omit<SealedClaimBinding, "claimedAt" | "createdAt">): Promise<void> {
    if (this.rows.has(input.approvalId)) return;
    this.rows.set(input.approvalId, { ...input, claimedAt: null, createdAt: this.now() });
  }

  async get(approvalId: string): Promise<SealedClaimBinding | null> {
    const row = this.rows.get(approvalId);
    return row === undefined ? null : { ...row };
  }

  async markClaimed(approvalId: string, agentSessionId: string, at: Date): Promise<boolean> {
    const row = this.rows.get(approvalId);
    if (row === undefined || row.agentSessionId !== agentSessionId || row.claimedAt !== null) {
      return false;
    }
    row.claimedAt = at;
    return true;
  }
}

export class PrismaSealedClaimStore implements SealedClaimStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async create(input: Omit<SealedClaimBinding, "claimedAt" | "createdAt">): Promise<void> {
    await this.prisma.sealedApprovalClaim.createMany({
      data: [
        {
          approval_id: input.approvalId,
          kind: input.kind,
          account_id: input.accountId,
          agent_session_id: input.agentSessionId,
          recipient_public_key: input.recipientPublicKey,
        },
      ],
      skipDuplicates: true,
    });
  }

  async get(approvalId: string): Promise<SealedClaimBinding | null> {
    const row = await this.prisma.sealedApprovalClaim.findUnique({
      where: { approval_id: approvalId },
    });
    return row === null ? null : toBinding(row);
  }

  async markClaimed(approvalId: string, agentSessionId: string, at: Date): Promise<boolean> {
    const moved = await this.prisma.sealedApprovalClaim.updateMany({
      where: { approval_id: approvalId, agent_session_id: agentSessionId, claimed_at: null },
      data: { claimed_at: at },
    });
    return moved.count === 1;
  }
}

function toBinding(row: SealedApprovalClaimRow): SealedClaimBinding {
  return {
    approvalId: row.approval_id,
    kind: row.kind === "payment" ? "payment" : "credential_fetch",
    accountId: row.account_id,
    agentSessionId: row.agent_session_id,
    recipientPublicKey: row.recipient_public_key,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
  };
}
