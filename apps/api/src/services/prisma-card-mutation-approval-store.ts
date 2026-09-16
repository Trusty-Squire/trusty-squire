import { ulid } from "ulid";
import type { ApiPrismaClient } from "./api-prisma-client.js";
import type {
  CardMutationApprovalInput,
  CardMutationApprovalRecord,
  CardMutationApprovalStore,
  CardMutationApplied,
  CardMutationCommitResult,
  CardMutationMetadata,
  CardMutationRequesterKind,
  CardMutationApprovalStatus,
} from "./card-mutation-approval-store.js";
import { cardMutationAuditEvent } from "./card-mutation-approval-store.js";

export class PrismaCardMutationApprovalStore implements CardMutationApprovalStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async create(accountId: string, input: CardMutationApprovalInput): Promise<string> {
    const row = await this.prisma.cardMutationApproval.create({
      data: {
        id: ulid(),
        account_id: accountId,
        operation: input.operation,
        card_id: input.cardId,
        card_label: input.cardLabel,
        before_metadata: input.before,
        after_metadata: input.after,
        nonce: input.nonce,
        agent: input.agent,
        requester_kind: input.requesterKind,
        intent_hash: input.intentHash,
        status: "pending",
        expires_at: input.expiresAt,
      },
      select: { id: true },
    });
    return row.id;
  }

  async findReusablePending(
    accountId: string,
    intentHash: string,
    now: Date,
  ): Promise<CardMutationApprovalRecord | null> {
    const row = await this.prisma.cardMutationApproval.findFirst({
      where: {
        account_id: accountId,
        intent_hash: intentHash,
        status: "pending",
        expires_at: { gt: now },
      },
      orderBy: { created_at: "desc" },
    });
    return row === null ? null : toRecord(row);
  }

  async getById(id: string): Promise<CardMutationApprovalRecord | null> {
    const row = await this.prisma.cardMutationApproval.findFirst({ where: { id } });
    return row === null ? null : toRecord(row);
  }

  async getByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<CardMutationApprovalRecord | null> {
    const row = await this.prisma.cardMutationApproval.findFirst({
      where: { id, account_id: accountId },
    });
    return row === null ? null : toRecord(row);
  }

  async commit(
    id: string,
    mandateId: string | null,
    applied: CardMutationApplied,
  ): Promise<CardMutationCommitResult> {
    return await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<CardMutationApprovalRow[]>`
        SELECT id, account_id, operation, card_id, card_label, before_metadata,
               after_metadata, nonce, agent, requester_kind, intent_hash, status,
               failure_code, mandate_id, created_at, expires_at, executed_at
        FROM card_mutation_approvals
        WHERE id = ${id}
        FOR UPDATE
      `;
      const row = locked[0];
      if (row === undefined) return "not_pending";
      const record = toRecord(row);
      if (record.status === "approved") return "already_approved";
      const clock = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT clock_timestamp() AS now
      `;
      const now = clock[0]?.now;
      if (now === undefined) throw new Error("card mutation transaction clock unavailable");
      if (record.expiresAt <= now) return "expired";
      if (record.status !== "pending") return "not_pending";

      const cards = await tx.$queryRaw<SafeCardRow[]>`
        SELECT id, account_id, label, blob, brand, last4
        FROM e2e_credentials
        WHERE id = ${record.cardId}
          AND account_id = ${record.accountId}
        LIMIT 1
      `;
      const card = cards[0];
      if (card === undefined) {
        await markFailed(tx, record.id, "card_not_found", now);
        return "card_not_found";
      }
      if (!sameMetadata(cardMetadataOf(card), record.before)) {
        await markFailed(tx, record.id, "card_changed", now);
        return "card_changed";
      }

      const updated = await tx.e2ECredential.updateMany({
        where: {
          id: record.cardId,
          account_id: record.accountId,
          label: card.label,
          brand: card.brand,
          last4: card.last4,
        },
        data: {
          label: applied.label,
          blob: applied.blob,
          brand: applied.brand,
          last4: applied.last4,
        },
      });
      if (updated.count === 0) {
        await markFailed(tx, record.id, "card_changed", now);
        return "card_changed";
      }

      const event = cardMutationAuditEvent(record, applied);
      await tx.vaultAuditEvent.create({
        data: {
          id: ulid(),
          account_id: event.account_id,
          type: event.type,
          payload: event.payload as unknown as Record<string, unknown>,
          emitted_at: now,
        },
      });
      const completed = await tx.cardMutationApproval.updateMany({
        where: { id: record.id, status: "pending" },
        data: {
          status: "approved",
          mandate_id: mandateId,
          executed_at: now,
          after_metadata: {
            label: applied.label,
            brand: applied.brand,
            last4: applied.last4,
          },
        },
      });
      if (completed.count !== 1) throw new Error("card mutation approval lost DB claim");
      return "approved";
    });
  }
}

interface CardMutationApprovalRow {
  id: string;
  account_id: string;
  operation: string;
  card_id: string;
  card_label: string;
  before_metadata: unknown;
  after_metadata: unknown;
  nonce: string;
  agent: string;
  requester_kind: string;
  intent_hash: string;
  status: string;
  failure_code: string | null;
  mandate_id: string | null;
  created_at: Date;
  expires_at: Date;
  executed_at: Date | null;
}

interface SafeCardRow {
  id: string;
  account_id: string;
  label: string;
  blob: string;
  brand: string | null;
  last4: string | null;
}

function cardMetadataOf(card: {
  label: string;
  brand: string | null;
  last4: string | null;
}): CardMutationMetadata {
  return { label: card.label, brand: card.brand, last4: card.last4 };
}

function sameMetadata(left: CardMutationMetadata, right: CardMutationMetadata): boolean {
  return left.label === right.label && left.brand === right.brand && left.last4 === right.last4;
}

async function markFailed(
  tx: ApiPrismaClient,
  id: string,
  failureCode: string,
  now: Date,
): Promise<void> {
  await tx.cardMutationApproval.updateMany({
    where: { id, status: "pending" },
    data: { status: "failed", failure_code: failureCode, executed_at: now },
  });
}

function cardMetadata(value: unknown): CardMutationMetadata {
  if (value === null || typeof value !== "object") {
    throw new Error("invalid card mutation metadata");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.label !== "string" ||
    !(candidate.brand === null || candidate.brand === undefined || typeof candidate.brand === "string") ||
    !(candidate.last4 === null || candidate.last4 === undefined || typeof candidate.last4 === "string")
  ) {
    throw new Error("invalid card mutation metadata");
  }
  return {
    label: candidate.label,
    brand: typeof candidate.brand === "string" ? candidate.brand : null,
    last4: typeof candidate.last4 === "string" ? candidate.last4 : null,
  };
}

function toRecord(row: CardMutationApprovalRow): CardMutationApprovalRecord {
  if (row.operation !== "edit_card") {
    throw new Error("invalid card mutation operation");
  }
  if (row.status !== "pending" && row.status !== "approved" && row.status !== "failed") {
    throw new Error("invalid card mutation approval status");
  }
  if (row.requester_kind !== "web" && row.requester_kind !== "agent") {
    throw new Error("invalid card mutation requester kind");
  }
  return {
    id: row.id,
    accountId: row.account_id,
    operation: row.operation,
    cardId: row.card_id,
    cardLabel: row.card_label,
    before: cardMetadata(row.before_metadata),
    after: row.after_metadata === null ? null : cardMetadata(row.after_metadata),
    nonce: row.nonce,
    agent: row.agent,
    requesterKind: row.requester_kind as CardMutationRequesterKind,
    intentHash: row.intent_hash,
    status: row.status as CardMutationApprovalStatus,
    failureCode: row.failure_code,
    mandateId: row.mandate_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    executedAt: row.executed_at,
  };
}
