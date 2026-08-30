import { ulid } from "ulid";
import type { InMemoryE2ECredentialStore } from "./in-memory-e2e-credential-store.js";

export interface PendingPaymentApprovalInput {
  merchant: string;
  checkoutOrigin: string;
  amountCents: number;
  currency: string;
  nonce: string;
  cardRef: string | null;
  operatorPubkey: string;
  item: string;
  reason: string;
  agent: string;
  expiresAt: Date;
}

export interface PendingPaymentApprovalRecord extends PendingPaymentApprovalInput {
  id: string;
  accountId: string;
  status: "pending" | "approved" | "denied" | "expired";
  jws: string | null;
  sealedCard: string | null;
  reviewJws: string | null;
  reviewSealedCard: string | null;
  reviewCandidateFingerprint: string | null;
  reviewPhase: "submitted" | "delivered" | "confirmed" | null;
  reviewExpiresAt: Date | null;
  submissionJws: string | null;
  submissionSealedCard: string | null;
  submissionCandidateFingerprint: string | null;
  submissionPhase: "submitted" | "delivered" | "confirmed" | null;
  submissionExpiresAt: Date | null;
  createdAt: Date;
}

export type ReviewRelayState =
  | { phase: "submitted" | "delivered"; jws: string; sealedCard: string; fingerprint: string }
  | { phase: "confirmed"; fingerprint: string }
  | null;

export type PaymentRelayCandidate = {
  binding: "review" | "approval";
  jws: string;
  sealedCard: string;
  fingerprint: string;
};

export type BindCardForAccountResult = "card_not_found" | "not_bindable" | "ok";

export interface PendingPaymentApprovalStore {
  create(accountId: string, input: PendingPaymentApprovalInput): Promise<string>;
  getById(id: string): Promise<PendingPaymentApprovalRecord | null>;
  getByIdForAccount(id: string, accountId: string): Promise<PendingPaymentApprovalRecord | null>;
  deny(id: string, now: Date): Promise<"denied" | "not_pending">;
  bindCardForAccount(
    id: string,
    accountId: string,
    cardRef: string,
    now: Date,
  ): Promise<BindCardForAccountResult>;
  submitReviewCandidate(
    id: string,
    accountId: string,
    candidate: { jws: string; sealedCard: string; fingerprint: string },
    expiresAt: Date,
    now: Date,
  ): Promise<"submitted" | "in_progress" | "not_pending">;
  getReviewRelayForAccount(id: string, accountId: string, now: Date): Promise<ReviewRelayState>;
  confirmReviewCandidate(
    id: string,
    accountId: string,
    fingerprint: string,
    now: Date,
  ): Promise<"confirmed" | "candidate_changed" | "not_pending">;
  submitCandidate(
    id: string,
    accountId: string,
    candidate: { jws: string; sealedCard: string; fingerprint: string },
    expiresAt: Date,
    now: Date,
  ): Promise<"submitted" | "in_progress" | "not_pending">;
  getRelayCandidateForAccount(
    id: string,
    accountId: string,
    now: Date,
  ): Promise<PaymentRelayCandidate | null>;
  peekRelayCandidateForAccount(
    id: string,
    accountId: string,
    now: Date,
  ): Promise<PaymentRelayCandidate | null>;
  confirmCandidateForAccount(
    id: string,
    accountId: string,
    fingerprint: string,
    now: Date,
  ): Promise<"confirmed" | "candidate_changed" | "not_pending">;
}

export class InMemoryPendingPaymentApprovalStore implements PendingPaymentApprovalStore {
  private readonly records = new Map<string, PendingPaymentApprovalRecord>();
  private readonly now: () => Date;

  constructor(
    private readonly e2eCredentialStore: InMemoryE2ECredentialStore,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  async create(accountId: string, input: PendingPaymentApprovalInput): Promise<string> {
    const record: PendingPaymentApprovalRecord = {
      id: ulid(),
      accountId,
      ...input,
      status: "pending",
      jws: null,
      sealedCard: null,
      reviewJws: null,
      reviewSealedCard: null,
      reviewCandidateFingerprint: null,
      reviewPhase: null,
      reviewExpiresAt: null,
      submissionJws: null,
      submissionSealedCard: null,
      submissionCandidateFingerprint: null,
      submissionPhase: null,
      submissionExpiresAt: null,
      createdAt: this.now(),
    };
    this.records.set(record.id, record);
    return record.id;
  }

  async getByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<PendingPaymentApprovalRecord | null> {
    const record = this.records.get(id);
    return record === undefined || record.accountId !== accountId ? null : { ...record };
  }

  async getById(id: string): Promise<PendingPaymentApprovalRecord | null> {
    const record = this.records.get(id);
    return record === undefined ? null : { ...record };
  }

  async deny(id: string, now: Date): Promise<"denied" | "not_pending"> {
    const record = this.records.get(id);
    if (record === undefined || record.status !== "pending" || record.expiresAt <= now) {
      return "not_pending";
    }
    record.status = "denied";
    record.jws = null;
    record.sealedCard = null;
    record.reviewJws = null;
    record.reviewSealedCard = null;
    record.submissionJws = null;
    record.submissionSealedCard = null;
    return "denied";
  }

  async bindCardForAccount(
    id: string,
    accountId: string,
    cardRef: string,
    now: Date,
  ): Promise<BindCardForAccountResult> {
    // The synchronous check and bind are atomic within one event-loop turn.
    if (!this.e2eCredentialStore.hasForAccount(cardRef, accountId)) {
      return "card_not_found";
    }
    const record = this.records.get(id);
    if (
      record === undefined ||
      record.accountId !== accountId ||
      record.status !== "pending" ||
      record.cardRef !== null ||
      record.expiresAt <= now
    ) {
      return "not_bindable";
    }
    record.cardRef = cardRef;
    return "ok";
  }

  async submitReviewCandidate(
    id: string,
    accountId: string,
    candidate: { jws: string; sealedCard: string; fingerprint: string },
    expiresAt: Date,
    now: Date,
  ): Promise<"submitted" | "in_progress" | "not_pending"> {
    const record = this.records.get(id);
    if (
      record === undefined ||
      record.accountId !== accountId ||
      record.status !== "pending" ||
      record.expiresAt <= now
    )
      return "not_pending";
    if (
      record.reviewPhase !== null &&
      record.reviewExpiresAt !== null &&
      record.reviewExpiresAt > now
    )
      return "in_progress";
    record.reviewJws = candidate.jws;
    record.reviewSealedCard = candidate.sealedCard;
    record.reviewCandidateFingerprint = candidate.fingerprint;
    record.reviewPhase = "submitted";
    record.reviewExpiresAt = expiresAt;
    return "submitted";
  }

  async getReviewRelayForAccount(
    id: string,
    accountId: string,
    now: Date,
  ): Promise<ReviewRelayState> {
    const record = this.records.get(id);
    if (
      record === undefined ||
      record.accountId !== accountId ||
      record.reviewExpiresAt === null ||
      record.reviewExpiresAt <= now
    )
      return null;
    if (record.reviewPhase === "confirmed" && record.reviewCandidateFingerprint !== null)
      return { phase: "confirmed", fingerprint: record.reviewCandidateFingerprint };
    if (
      (record.reviewPhase === "submitted" || record.reviewPhase === "delivered") &&
      record.reviewJws !== null &&
      record.reviewSealedCard !== null &&
      record.reviewCandidateFingerprint !== null
    ) {
      record.reviewPhase = "delivered";
      return {
        phase: "delivered",
        jws: record.reviewJws,
        sealedCard: record.reviewSealedCard,
        fingerprint: record.reviewCandidateFingerprint,
      };
    }
    return null;
  }

  async confirmReviewCandidate(
    id: string,
    accountId: string,
    fingerprint: string,
    now: Date,
  ): Promise<"confirmed" | "candidate_changed" | "not_pending"> {
    const record = this.records.get(id);
    if (
      record === undefined ||
      record.accountId !== accountId ||
      record.status !== "pending" ||
      record.expiresAt <= now
    )
      return "not_pending";
    if (
      record.reviewExpiresAt === null ||
      record.reviewExpiresAt <= now ||
      record.reviewCandidateFingerprint !== fingerprint
    )
      return "candidate_changed";
    if (record.reviewPhase === "confirmed") return "confirmed";
    if (record.reviewPhase !== "submitted" && record.reviewPhase !== "delivered")
      return "candidate_changed";
    record.reviewPhase = "confirmed";
    // Delete the only durable copy of the sealed candidate immediately after use.
    record.reviewJws = null;
    record.reviewSealedCard = null;
    return "confirmed";
  }

  async submitCandidate(
    id: string,
    accountId: string,
    candidate: { jws: string; sealedCard: string; fingerprint: string },
    expiresAt: Date,
    now: Date,
  ): Promise<"submitted" | "in_progress" | "not_pending"> {
    const record = this.records.get(id);
    if (
      record === undefined ||
      record.accountId !== accountId ||
      record.status !== "pending" ||
      record.expiresAt <= now
    )
      return "not_pending";
    if (record.submissionExpiresAt !== null && record.submissionExpiresAt > now) {
      return record.submissionCandidateFingerprint === candidate.fingerprint
        ? "submitted"
        : "in_progress";
    }
    record.submissionJws = candidate.jws;
    record.submissionSealedCard = candidate.sealedCard;
    record.submissionCandidateFingerprint = candidate.fingerprint;
    record.submissionPhase = "submitted";
    record.submissionExpiresAt = expiresAt;
    return "submitted";
  }

  private relayCandidateForAccount(
    id: string,
    accountId: string,
    now: Date,
    markDelivered: boolean,
  ): PaymentRelayCandidate | null {
    const record = this.records.get(id);
    if (
      record === undefined ||
      record.accountId !== accountId ||
      record.status !== "pending" ||
      record.expiresAt <= now
    )
      return null;
    if (
      record.submissionExpiresAt !== null &&
      record.submissionExpiresAt > now &&
      (record.submissionPhase === "submitted" || record.submissionPhase === "delivered") &&
      record.submissionJws !== null &&
      record.submissionSealedCard !== null &&
      record.submissionCandidateFingerprint !== null
    ) {
      if (markDelivered) record.submissionPhase = "delivered";
      return {
        binding: "approval",
        jws: record.submissionJws,
        sealedCard: record.submissionSealedCard,
        fingerprint: record.submissionCandidateFingerprint,
      };
    }
    if (
      record.reviewExpiresAt !== null &&
      record.reviewExpiresAt > now &&
      (record.reviewPhase === "submitted" || record.reviewPhase === "delivered") &&
      record.reviewJws !== null &&
      record.reviewSealedCard !== null &&
      record.reviewCandidateFingerprint !== null
    ) {
      if (markDelivered) record.reviewPhase = "delivered";
      return {
        binding: "review",
        jws: record.reviewJws,
        sealedCard: record.reviewSealedCard,
        fingerprint: record.reviewCandidateFingerprint,
      };
    }
    return null;
  }

  async getRelayCandidateForAccount(
    id: string,
    accountId: string,
    now: Date,
  ): Promise<PaymentRelayCandidate | null> {
    return this.relayCandidateForAccount(id, accountId, now, true);
  }

  async peekRelayCandidateForAccount(
    id: string,
    accountId: string,
    now: Date,
  ): Promise<PaymentRelayCandidate | null> {
    return this.relayCandidateForAccount(id, accountId, now, false);
  }

  async confirmCandidateForAccount(
    id: string,
    accountId: string,
    fingerprint: string,
    now: Date,
  ): Promise<"confirmed" | "candidate_changed" | "not_pending"> {
    const record = this.records.get(id);
    if (record === undefined || record.accountId !== accountId) return "not_pending";
    if (
      record.status === "approved" &&
      record.submissionPhase === "confirmed" &&
      record.submissionCandidateFingerprint === fingerprint &&
      record.submissionExpiresAt !== null &&
      record.submissionExpiresAt > now
    ) {
      return "confirmed";
    }
    if (record.status !== "pending" || record.expiresAt <= now) return "not_pending";
    if (
      record.submissionPhase !== "delivered" ||
      record.submissionCandidateFingerprint !== fingerprint ||
      record.submissionExpiresAt === null ||
      record.submissionExpiresAt <= now
    ) {
      return "candidate_changed";
    }
    record.status = "approved";
    record.jws = null;
    record.sealedCard = null;
    record.reviewJws = null;
    record.reviewSealedCard = null;
    record.submissionJws = null;
    record.submissionSealedCard = null;
    record.submissionPhase = "confirmed";
    return "confirmed";
  }
}
