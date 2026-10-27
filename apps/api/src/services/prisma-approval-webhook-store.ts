import type {
  ApiPrismaClient,
  ApprovalWebhookDeliveryRow,
  ApprovalWebhookEndpointRow,
  ApprovalWebhookSubscriptionRow,
} from "./api-prisma-client.js";
import type { ApprovalKind, ApprovalStatus } from "./approval-card.js";
import type {
  ApprovalWebhookDelivery,
  ApprovalWebhookEndpoint,
  ApprovalWebhookStore,
  ApprovalWebhookSubscription,
  NewApprovalWebhookDelivery,
} from "./approval-webhooks.js";
import { ulid } from "ulid";

const KINDS: ReadonlySet<string> = new Set([
  "payment",
  "credential_fetch",
  "credential_mutation",
  "card_mutation",
]);
const STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "approved",
  "processing",
  "completed",
  "failed",
  "denied",
  "expired",
]);

export class PrismaApprovalWebhookStore implements ApprovalWebhookStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async upsertEndpoint(input: {
    accountId: string;
    agentSessionId: string;
    url: string;
    secretSalt: string;
  }): Promise<ApprovalWebhookEndpoint> {
    const now = new Date();
    const row = await this.prisma.approvalWebhookEndpoint.upsert({
      where: { agent_session_id: input.agentSessionId },
      create: {
        id: ulid(),
        account_id: input.accountId,
        agent_session_id: input.agentSessionId,
        url: input.url,
        secret_salt: input.secretSalt,
        created_at: now,
      },
      update: {
        account_id: input.accountId,
        url: input.url,
        secret_salt: input.secretSalt,
        created_at: now,
      },
    });
    return toEndpoint(row);
  }

  async getEndpointForSession(agentSessionId: string): Promise<ApprovalWebhookEndpoint | null> {
    const row = await this.prisma.approvalWebhookEndpoint.findUnique({
      where: { agent_session_id: agentSessionId },
    });
    return row === null ? null : toEndpoint(row);
  }

  async getEndpointById(id: string): Promise<ApprovalWebhookEndpoint | null> {
    const row = await this.prisma.approvalWebhookEndpoint.findUnique({ where: { id } });
    return row === null ? null : toEndpoint(row);
  }

  async deleteEndpointForSession(agentSessionId: string): Promise<boolean> {
    const deleted = await this.prisma.approvalWebhookEndpoint.deleteMany({
      where: { agent_session_id: agentSessionId },
    });
    return deleted.count > 0;
  }

  async subscribe(input: {
    approvalId: string;
    kind: ApprovalKind;
    accountId: string;
    endpointId: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.prisma.approvalWebhookSubscription.createMany({
      data: [
        {
          approval_id: input.approvalId,
          kind: input.kind,
          account_id: input.accountId,
          endpoint_id: input.endpointId,
          last_status: null,
          open: true,
          expires_at: input.expiresAt,
        },
      ],
      skipDuplicates: true,
    });
  }

  async getSubscription(approvalId: string): Promise<ApprovalWebhookSubscription | null> {
    const row = await this.prisma.approvalWebhookSubscription.findUnique({
      where: { approval_id: approvalId },
    });
    return row === null ? null : toSubscription(row);
  }

  async listOpenSubscriptions(limit: number): Promise<ApprovalWebhookSubscription[]> {
    const rows = await this.prisma.approvalWebhookSubscription.findMany({
      where: { open: true },
      orderBy: { created_at: "asc" },
      take: limit,
    });
    return rows.map(toSubscription);
  }

  async advanceSubscription(
    approvalId: string,
    expected: ApprovalStatus | null,
    next: ApprovalStatus,
    open: boolean,
    delivery: NewApprovalWebhookDelivery | null,
  ): Promise<boolean> {
    return await this.prisma.$transaction(async (tx) => {
      const moved = await tx.approvalWebhookSubscription.updateMany({
        where: { approval_id: approvalId, open: true, last_status: expected },
        data: { last_status: next, open },
      });
      if (moved.count !== 1) return false;
      if (delivery !== null) {
        await tx.approvalWebhookDelivery.create({
          data: {
            id: delivery.id,
            endpoint_id: delivery.endpointId,
            approval_id: delivery.approvalId,
            payload: delivery.payload,
            attempts: 0,
            next_attempt_at: delivery.nextAttemptAt,
          },
        });
      }
      return true;
    });
  }

  async listDueDeliveries(now: Date, limit: number): Promise<ApprovalWebhookDelivery[]> {
    const rows = await this.prisma.approvalWebhookDelivery.findMany({
      where: { delivered_at: null, abandoned_at: null, next_attempt_at: { lte: now } },
      orderBy: { next_attempt_at: "asc" },
      take: limit,
    });
    return rows.map(toDelivery);
  }

  async claimDelivery(id: string, expectedAttempts: number, leaseUntil: Date): Promise<boolean> {
    const claimed = await this.prisma.approvalWebhookDelivery.updateMany({
      where: { id, attempts: expectedAttempts, delivered_at: null, abandoned_at: null },
      data: { attempts: expectedAttempts + 1, next_attempt_at: leaseUntil },
    });
    return claimed.count === 1;
  }

  async markDelivered(id: string, at: Date): Promise<void> {
    await this.prisma.approvalWebhookDelivery.updateMany({
      where: { id },
      data: { delivered_at: at, last_error: null },
    });
  }

  async markFailed(id: string, error: string, nextAttemptAt: Date | null, at: Date): Promise<void> {
    await this.prisma.approvalWebhookDelivery.updateMany({
      where: { id },
      data:
        nextAttemptAt === null
          ? { last_error: error, abandoned_at: at }
          : { last_error: error, next_attempt_at: nextAttemptAt },
    });
  }

  async purge(before: Date): Promise<void> {
    await this.prisma.approvalWebhookDelivery.deleteMany({
      where: {
        OR: [{ delivered_at: { lt: before } }, { abandoned_at: { lt: before } }],
      },
    });
    await this.prisma.approvalWebhookSubscription.deleteMany({
      where: { open: false, expires_at: { lt: before } },
    });
  }
}

function toEndpoint(row: ApprovalWebhookEndpointRow): ApprovalWebhookEndpoint {
  return {
    id: row.id,
    accountId: row.account_id,
    agentSessionId: row.agent_session_id,
    url: row.url,
    secretSalt: row.secret_salt,
    createdAt: row.created_at,
  };
}

function toSubscription(row: ApprovalWebhookSubscriptionRow): ApprovalWebhookSubscription {
  if (!KINDS.has(row.kind)) throw new Error("invalid approval webhook subscription kind");
  if (row.last_status !== null && !STATUSES.has(row.last_status)) {
    throw new Error("invalid approval webhook subscription status");
  }
  return {
    approvalId: row.approval_id,
    kind: row.kind as ApprovalKind,
    accountId: row.account_id,
    endpointId: row.endpoint_id,
    lastStatus: row.last_status as ApprovalStatus | null,
    open: row.open,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function toDelivery(row: ApprovalWebhookDeliveryRow): ApprovalWebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    approvalId: row.approval_id,
    payload: row.payload,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    deliveredAt: row.delivered_at,
    abandonedAt: row.abandoned_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}
