import { VAULT_AUDIT_TYPES, type VaultAuditStore } from "@trusty-squire/vault";

/** Idempotent across status reads and the retention sweep. */
export async function recordPaymentApprovalExpiry(
  audit: VaultAuditStore,
  approval: {
    id: string;
    accountId: string;
    merchant: string;
    amountCents: number;
    currency: string;
  },
): Promise<void> {
  await audit.record({
    idempotency_key: `payment_approval_expired:${approval.id}`,
    account_id: approval.accountId,
    type: VAULT_AUDIT_TYPES.paymentApprovalExpired,
    payload: {
      reference: `pay://${approval.id}`,
      requester: "agent",
      purpose: "payment.approval.expire",
      approval_id: approval.id,
      merchant: approval.merchant,
      amount_cents: approval.amountCents,
      currency: approval.currency,
      payment_status: "approval_expired",
    },
  });
}
