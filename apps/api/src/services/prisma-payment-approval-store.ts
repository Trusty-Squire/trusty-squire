import { ulid } from "ulid";
import type { ApiPrismaClient } from "./api-prisma-client.js";
import type {
  PendingPaymentApprovalInput,
  PendingPaymentApprovalRecord,
  PendingPaymentApprovalStore,
  BindCardForAccountResult,
} from "./in-memory-payment-approval-store.js";

export class PrismaPendingPaymentApprovalStore implements PendingPaymentApprovalStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async create(accountId: string, input: PendingPaymentApprovalInput): Promise<string> {
    const row = await this.prisma.pendingPaymentApproval.create({
      data: {
        id: ulid(),
        account_id: accountId,
        merchant: input.merchant,
        checkout_origin: input.checkoutOrigin,
        amount_cents: input.amountCents,
        currency: input.currency,
        nonce: input.nonce,
        card_ref: input.cardRef,
        operator_pubkey: input.operatorPubkey,
        item: input.item,
        reason: input.reason,
        agent: input.agent,
        status: "pending",
        expires_at: input.expiresAt,
      },
      select: { id: true },
    });
    return row.id;
  }

  async getByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<PendingPaymentApprovalRecord | null> {
    const row = await this.prisma.pendingPaymentApproval.findFirst({
      where: { id, account_id: accountId },
    });
    return row === null
      ? null
      : {
          id: row.id,
          accountId: row.account_id,
          merchant: row.merchant,
          checkoutOrigin: row.checkout_origin,
          amountCents: row.amount_cents,
          currency: row.currency,
          nonce: row.nonce,
          cardRef: row.card_ref,
          operatorPubkey: row.operator_pubkey,
          item: row.item,
          reason: row.reason,
          agent: row.agent,
          status: row.status as PendingPaymentApprovalRecord["status"],
          jws: row.jws,
          sealedCard: row.sealed_card,
          reviewJws: row.review_jws,
          reviewSealedCard: row.review_sealed_card,
          reviewCandidateFingerprint: row.review_candidate_fingerprint,
          reviewPhase: row.review_phase as PendingPaymentApprovalRecord["reviewPhase"],
          reviewExpiresAt: row.review_expires_at,
          submissionJws: row.submission_jws,
          submissionSealedCard: row.submission_sealed_card,
          submissionCandidateFingerprint: row.submission_candidate_fingerprint,
          submissionPhase: row.submission_phase as PendingPaymentApprovalRecord["submissionPhase"],
          submissionExpiresAt: row.submission_expires_at,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        };
  }

  async getById(id: string): Promise<PendingPaymentApprovalRecord | null> {
    const row = await this.prisma.pendingPaymentApproval.findFirst({ where: { id } });
    return row === null
      ? null
      : {
          id: row.id,
          accountId: row.account_id,
          merchant: row.merchant,
          checkoutOrigin: row.checkout_origin,
          amountCents: row.amount_cents,
          currency: row.currency,
          nonce: row.nonce,
          cardRef: row.card_ref,
          operatorPubkey: row.operator_pubkey,
          item: row.item,
          reason: row.reason,
          agent: row.agent,
          status: row.status as PendingPaymentApprovalRecord["status"],
          jws: row.jws,
          sealedCard: row.sealed_card,
          reviewJws: row.review_jws,
          reviewSealedCard: row.review_sealed_card,
          reviewCandidateFingerprint: row.review_candidate_fingerprint,
          reviewPhase: row.review_phase as PendingPaymentApprovalRecord["reviewPhase"],
          reviewExpiresAt: row.review_expires_at,
          submissionJws: row.submission_jws,
          submissionSealedCard: row.submission_sealed_card,
          submissionCandidateFingerprint: row.submission_candidate_fingerprint,
          submissionPhase: row.submission_phase as PendingPaymentApprovalRecord["submissionPhase"],
          submissionExpiresAt: row.submission_expires_at,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        };
  }

  async bindCardForAccount(
    id: string,
    accountId: string,
    cardRef: string,
    now: Date,
  ): Promise<BindCardForAccountResult> {
    return this.prisma.$transaction(async (tx) => {
      // FOR KEY SHARE blocks concurrent row deletion with the weakest lock used by FK checks.
      const cards = await tx.$queryRaw`
        SELECT id
        FROM "E2ECredential"
        WHERE id = ${cardRef} AND account_id = ${accountId}
        FOR KEY SHARE
      `;
      if (cards.length === 0) {
        return "card_not_found";
      }
      const result = await tx.pendingPaymentApproval.updateMany({
        where: {
          id,
          account_id: accountId,
          status: "pending",
          card_ref: null,
          expires_at: { gt: now },
        },
        data: { card_ref: cardRef },
      });
      return result.count > 0 ? "ok" : "not_bindable";
    });
  }

  async submitReviewCandidate(
    id: string,
    accountId: string,
    candidate: { jws: string; sealedCard: string; fingerprint: string },
    expiresAt: Date,
    now: Date,
  ): Promise<"submitted" | "in_progress" | "not_pending"> {
    const result = await this.prisma.pendingPaymentApproval.updateMany({
      where: {
        id,
        account_id: accountId,
        status: "pending",
        expires_at: { gt: now },
        OR: [{ review_phase: null }, { review_expires_at: { lte: now } }],
      },
      data: {
        review_jws: candidate.jws,
        review_sealed_card: candidate.sealedCard,
        review_candidate_fingerprint: candidate.fingerprint,
        review_phase: "submitted",
        review_expires_at: expiresAt,
      },
    });
    if (result.count > 0) return "submitted";
    const row = await this.prisma.pendingPaymentApproval.findFirst({
      where: { id, account_id: accountId },
      select: { status: true, expires_at: true, review_expires_at: true },
    });
    if (
      row !== null &&
      row.status === "pending" &&
      row.expires_at > now &&
      row.review_expires_at !== null &&
      row.review_expires_at > now
    )
      return "in_progress";
    return "not_pending";
  }

  async getReviewRelayForAccount(id: string, accountId: string, now: Date) {
    const row = await this.prisma.pendingPaymentApproval.findFirst({
      where: { id, account_id: accountId, review_expires_at: { gt: now } },
    });
    if (row === null || row.review_candidate_fingerprint === null) return null;
    if (row.review_phase === "confirmed")
      return { phase: "confirmed" as const, fingerprint: row.review_candidate_fingerprint };
    if (
      (row.review_phase !== "submitted" && row.review_phase !== "delivered") ||
      row.review_jws === null ||
      row.review_sealed_card === null
    )
      return null;
    await this.prisma.pendingPaymentApproval.updateMany({
      where: { id, account_id: accountId, review_phase: "submitted" },
      data: { review_phase: "delivered" },
    });
    return {
      phase: "delivered" as const,
      jws: row.review_jws,
      sealedCard: row.review_sealed_card,
      fingerprint: row.review_candidate_fingerprint,
    };
  }

  async confirmReviewCandidate(
    id: string,
    accountId: string,
    fingerprint: string,
    now: Date,
  ): Promise<"confirmed" | "candidate_changed" | "not_pending"> {
    const result = await this.prisma.pendingPaymentApproval.updateMany({
      where: {
        id,
        account_id: accountId,
        status: "pending",
        expires_at: { gt: now },
        review_candidate_fingerprint: fingerprint,
        review_expires_at: { gt: now },
        review_phase: { in: ["submitted", "delivered"] },
      },
      data: { review_phase: "confirmed", review_jws: null, review_sealed_card: null },
    });
    if (result.count > 0) return "confirmed";
    const row = await this.prisma.pendingPaymentApproval.findFirst({
      where: { id, account_id: accountId },
      select: {
        status: true,
        expires_at: true,
        review_candidate_fingerprint: true,
        review_expires_at: true,
        review_phase: true,
      },
    });
    if (
      row !== null &&
      row.status === "pending" &&
      row.expires_at > now &&
      row.review_expires_at !== null &&
      row.review_expires_at > now &&
      row.review_candidate_fingerprint === fingerprint &&
      row.review_phase === "confirmed"
    )
      return "confirmed";
    return row !== null && row.status === "pending" && row.expires_at > now
      ? "candidate_changed"
      : "not_pending";
  }

  async submitCandidate(
    id: string,
    accountId: string,
    candidate: { jws: string; sealedCard: string; fingerprint: string },
    expiresAt: Date,
    now: Date,
  ): Promise<"submitted" | "in_progress" | "not_pending"> {
    const result = await this.prisma.pendingPaymentApproval.updateMany({
      where: {
        id,
        account_id: accountId,
        status: "pending",
        expires_at: { gt: now },
        OR: [{ submission_phase: null }, { submission_expires_at: { lte: now } }],
      },
      data: {
        submission_jws: candidate.jws,
        submission_sealed_card: candidate.sealedCard,
        submission_candidate_fingerprint: candidate.fingerprint,
        submission_phase: "submitted",
        submission_expires_at: expiresAt,
      },
    });
    if (result.count > 0) return "submitted";
    const row = await this.prisma.pendingPaymentApproval.findFirst({
      where: { id, account_id: accountId },
      select: {
        status: true,
        expires_at: true,
        submission_candidate_fingerprint: true,
        submission_expires_at: true,
      },
    });
    if (
      row !== null &&
      row.status === "pending" &&
      row.expires_at > now &&
      row.submission_expires_at !== null &&
      row.submission_expires_at > now
    ) {
      return row.submission_candidate_fingerprint === candidate.fingerprint
        ? "submitted"
        : "in_progress";
    }
    return "not_pending";
  }

  private async readRelayCandidateForAccount(
    id: string,
    accountId: string,
    now: Date,
    markDelivered: boolean,
  ) {
    const row = await this.prisma.pendingPaymentApproval.findFirst({
      where: { id, account_id: accountId, status: "pending", expires_at: { gt: now } },
    });
    if (row === null) return null;
    if (
      row.submission_expires_at !== null &&
      row.submission_expires_at > now &&
      (row.submission_phase === "submitted" || row.submission_phase === "delivered") &&
      row.submission_jws !== null &&
      row.submission_sealed_card !== null &&
      row.submission_candidate_fingerprint !== null
    ) {
      if (markDelivered) {
        await this.prisma.pendingPaymentApproval.updateMany({
          where: {
            id,
            account_id: accountId,
            status: "pending",
            submission_phase: "submitted",
            submission_candidate_fingerprint: row.submission_candidate_fingerprint,
            submission_expires_at: row.submission_expires_at,
          },
          data: { submission_phase: "delivered" },
        });
      }
      return {
        binding: "approval" as const,
        jws: row.submission_jws,
        sealedCard: row.submission_sealed_card,
        fingerprint: row.submission_candidate_fingerprint,
      };
    }
    if (
      row.review_expires_at !== null &&
      row.review_expires_at > now &&
      (row.review_phase === "submitted" || row.review_phase === "delivered") &&
      row.review_jws !== null &&
      row.review_sealed_card !== null &&
      row.review_candidate_fingerprint !== null
    ) {
      if (markDelivered) {
        await this.prisma.pendingPaymentApproval.updateMany({
          where: {
            id,
            account_id: accountId,
            status: "pending",
            review_phase: "submitted",
            review_candidate_fingerprint: row.review_candidate_fingerprint,
            review_expires_at: row.review_expires_at,
          },
          data: { review_phase: "delivered" },
        });
      }
      return {
        binding: "review" as const,
        jws: row.review_jws,
        sealedCard: row.review_sealed_card,
        fingerprint: row.review_candidate_fingerprint,
      };
    }
    return null;
  }

  async getRelayCandidateForAccount(id: string, accountId: string, now: Date) {
    return await this.readRelayCandidateForAccount(id, accountId, now, true);
  }

  async peekRelayCandidateForAccount(id: string, accountId: string, now: Date) {
    return await this.readRelayCandidateForAccount(id, accountId, now, false);
  }

  async confirmCandidateForAccount(
    id: string,
    accountId: string,
    fingerprint: string,
    now: Date,
  ): Promise<"confirmed" | "candidate_changed" | "not_pending"> {
    const result = await this.prisma.pendingPaymentApproval.updateMany({
      where: {
        id,
        account_id: accountId,
        status: "pending",
        expires_at: { gt: now },
        submission_candidate_fingerprint: fingerprint,
        submission_expires_at: { gt: now },
        submission_phase: "delivered",
      },
      data: {
        status: "approved",
        jws: null,
        sealed_card: null,
        review_jws: null,
        review_sealed_card: null,
        submission_jws: null,
        submission_sealed_card: null,
        submission_phase: "confirmed",
      },
    });
    if (result.count > 0) return "confirmed";
    const row = await this.prisma.pendingPaymentApproval.findFirst({
      where: { id, account_id: accountId },
      select: {
        status: true,
        expires_at: true,
        submission_candidate_fingerprint: true,
        submission_expires_at: true,
        submission_phase: true,
      },
    });
    if (
      row !== null &&
      row.status === "approved" &&
      row.submission_phase === "confirmed" &&
      row.submission_candidate_fingerprint === fingerprint &&
      row.submission_expires_at !== null &&
      row.submission_expires_at > now
    ) {
      return "confirmed";
    }
    return row !== null && row.status === "pending" && row.expires_at > now
      ? "candidate_changed"
      : "not_pending";
  }
}
