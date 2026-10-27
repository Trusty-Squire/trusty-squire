// One payment outcome in the ledger: the PaymentAuditEvent row plus its vault
// audit event. Shared by the broker's POST /v1/vault/payments/audit and the
// SDK's POST /v1/pay/approvals/:id/outcome so both write the same rows.

import { VAULT_AUDIT_TYPES } from "@trusty-squire/vault";
import type { ApiDeps } from "./deps.js";
import { notifyVaultAuditAfterCommit, recordVaultAuditAfterPersist } from "./vault-notify.js";

export interface PaymentExecution {
  merchant: string;
  amountCents: number;
  currency: string;
  last4: string;
  status: string;
  mandateId?: string | undefined;
  cardRef?: string | undefined;
  approvalId?: string | undefined;
  item?: string | undefined;
}

export async function recordPaymentExecution(
  deps: Pick<ApiDeps, "paymentAuditStore" | "vaultAuditStore">,
  accountId: string,
  data: PaymentExecution,
  log: { error(bindings: Record<string, unknown>, message?: string): void },
): Promise<string> {
  const eventForId = (id: string) =>
    ({
      account_id: accountId,
      type: VAULT_AUDIT_TYPES.paymentExecuted,
      payload: {
        reference: `pay://${id}`,
        requester: "agent",
        merchant: data.merchant,
        amount_cents: data.amountCents,
        currency: data.currency,
        last4: data.last4,
        payment_status: data.status,
        ...(data.mandateId !== undefined ? { mandate_id: data.mandateId } : {}),
        ...(data.cardRef !== undefined ? { card_ref: data.cardRef } : {}),
        ...(data.approvalId !== undefined ? { approval_id: data.approvalId } : {}),
        ...(data.item !== undefined ? { item: data.item } : {}),
      },
    }) as const;
  if (deps.paymentAuditStore.createWithVaultAudit !== undefined) {
    const id = await deps.paymentAuditStore.createWithVaultAudit(accountId, data, eventForId);
    notifyVaultAuditAfterCommit(deps.vaultAuditStore, eventForId(id));
    return id;
  }
  const id = await deps.paymentAuditStore.create(accountId, data);
  await recordVaultAuditAfterPersist(deps.vaultAuditStore, eventForId(id), log);
  return id;
}
