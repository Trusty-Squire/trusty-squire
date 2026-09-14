// The one writer of `fetch_credential`'s non-decrypt outcomes.
//
// "Every fetch outcome is audited" is a claim the ledger has to be able to
// back: a reveal that was approved, refused, left to lapse, or attempted by
// somebody other than the owner must each leave exactly one purpose=`reveal`
// row. Routing them all through one function is what keeps that true as
// settlement points multiply — today the route and the retention cron, both of
// which can be the party that finally closes a lapsed approval.
//
// The signature is the leak fence: it accepts an approval record and an outcome
// from a closed set, and there is no parameter through which a decrypted value
// could reach a payload. Outcomes reached AFTER a decrypt (`success`,
// `field_set_changed`, `missing_credential`) are written by the vault itself,
// where the decrypt happens.

import {
  VAULT_AUDIT_TYPES,
  VAULT_REVEAL_PURPOSE,
  type VaultAuditStore,
} from "@trusty-squire/vault";

/** Terminal fetch outcomes settled OUTSIDE the vault's decrypt path. */
export type CredentialFetchTerminalOutcome =
  | "approved"
  | "denied"
  | "expired"
  | "approver_rejected"
  | "internal_error";

/** The audit-relevant face of an approval — deliberately no value-bearing field. */
export interface CredentialFetchAuditSubject {
  id: string;
  accountId: string;
  credentialReference: string;
  credentialService: string | null;
  credentialLabel: string;
  requesterKind: "web" | "agent";
}

export async function recordCredentialFetchOutcome(
  auditStore: VaultAuditStore,
  subject: CredentialFetchAuditSubject,
  outcome: CredentialFetchTerminalOutcome,
  // The account whose passkey settled it, when a human did. Recorded against
  // the OWNER's ledger, which is what makes a cross-account attempt visible to
  // the person whose secret it was.
  approverAccountId?: string,
): Promise<void> {
  await auditStore.record({
    account_id: subject.accountId,
    type: VAULT_AUDIT_TYPES.retrieved,
    payload: {
      reference: subject.credentialReference,
      requester: subject.requesterKind === "web" ? "user" : "agent",
      purpose: VAULT_REVEAL_PURPOSE,
      outcome,
      approval_id: subject.id,
      label: subject.credentialLabel,
      ...(subject.credentialService !== null ? { service: subject.credentialService } : {}),
      ...(approverAccountId !== undefined ? { approver_account_id: approverAccountId } : {}),
    },
  });
}
