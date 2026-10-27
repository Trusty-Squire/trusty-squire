// One normalized description of a pending risky action, shared by every
// approval kind (payment, credential fetch, credential mutation, card
// mutation). A host app draws its in-conversation approval card from this
// object alone, and the decision webhook carries the same object.
//
// It is DISPLAY data. Nothing here may carry a secret value, card data, a
// signed mandate, a sealed card, a nonce, or an account binding: the app that
// draws the card is exactly the party the vault keeps out. The builders below
// copy named display fields one by one and never spread a record, so a column
// added to a store later cannot leak through this object by accident.

import type { ApiDeps } from "./deps.js";
import { approvalPageUrl } from "./approval-ceremony.js";
import { approvalAmountLabel } from "./money.js";
import type { CredentialFetchApprovalRecord } from "./credential-fetch-approval-store.js";
import type { CredentialMutationApprovalRecord } from "./credential-mutation-approval-store.js";
import type { CardMutationApprovalRecord } from "./card-mutation-approval-store.js";
import type { PendingPaymentApprovalRecord } from "./in-memory-payment-approval-store.js";

export type ApprovalKind =
  | "payment"
  | "credential_fetch"
  | "credential_mutation"
  | "card_mutation";

export type ApprovalAction = "pay" | "reveal" | "edit" | "delete" | "edit_card";

// "approved" is never "done": a payment moves on through processing to
// completed or failed. Mutations apply in the same step that accepts the
// signature, so they go straight from pending to completed.
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "processing"
  | "completed"
  | "failed"
  | "denied"
  | "expired";

const TERMINAL: ReadonlySet<ApprovalStatus> = new Set([
  "completed",
  "failed",
  "denied",
  "expired",
]);

export function isTerminalApprovalStatus(status: ApprovalStatus): boolean {
  return TERMINAL.has(status);
}

export interface ApprovalDetail {
  label: string;
  value: string;
}

export interface ApprovalCard {
  id: string;
  kind: ApprovalKind;
  action: ApprovalAction;
  title: string;
  details: ApprovalDetail[];
  status: ApprovalStatus;
  requested_by: string;
  reason: string | null;
  created_at: string;
  expires_at: string;
  approve_url: string;
}

/** The payment card shown on the approval: label and last four digits only. */
export interface PaymentCardDisplay {
  label: string;
  brand: string | null;
  last4: string | null;
}

/** What the payment ledger says about the checkout the approval released. */
export type PaymentOutcome = "completed" | "failed" | null;

/** Ledger statuses that settle a released payment: the merchant confirmed or refused it. */
export const PAYMENT_OUTCOME_STATUSES: ReadonlySet<string> = new Set([
  "merchant_order_confirmed",
  "merchant_order_failed",
]);

function cardName(card: PaymentCardDisplay): string {
  return card.last4 !== null ? `${card.label} ··${card.last4}` : card.label;
}

function credentialName(service: string | null, label: string): string {
  return service !== null ? `${service} / ${label}` : label;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function listText(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

export function paymentApprovalStatus(
  record: PendingPaymentApprovalRecord,
  outcome: PaymentOutcome,
  now: Date,
): ApprovalStatus {
  if (record.status === "denied") return "denied";
  // The broker or app confirmed the released card: the checkout is under way
  // until the ledger records the merchant's confirmation or failure.
  if (record.status === "approved") return outcome ?? "processing";
  const signed = record.submissionPhase !== null;
  if (record.status === "expired" || record.expiresAt <= now) {
    // A signed approval whose checkout never confirmed in time did not pay.
    return signed ? "failed" : "expired";
  }
  if (record.submissionPhase === "delivered" || record.submissionPhase === "confirmed") {
    return "processing";
  }
  return signed ? "approved" : "pending";
}

export function paymentApprovalCard(
  record: PendingPaymentApprovalRecord,
  card: PaymentCardDisplay | null,
  outcome: PaymentOutcome,
  now: Date,
): ApprovalCard {
  const amount = approvalAmountLabel(record.amountCents, record.currency, record.item);
  const details: ApprovalDetail[] = [
    { label: "Amount", value: amount },
    { label: "Merchant", value: hostOf(record.checkoutOrigin) },
    {
      label: "Card",
      value:
        card !== null
          ? cardName(card)
          : record.cardRef === null
            ? "Entered at checkout"
            : "Saved card",
    },
    { label: "Item", value: record.item },
    { label: "Requested by", value: record.agent },
  ];
  return {
    id: record.id,
    kind: "payment",
    action: "pay",
    title: `Pay ${amount} to ${record.merchant}`,
    details,
    status: paymentApprovalStatus(record, outcome, now),
    requested_by: record.agent,
    reason: record.reason.length > 0 ? record.reason : null,
    created_at: record.createdAt.toISOString(),
    expires_at: record.expiresAt.toISOString(),
    approve_url: approvalPageUrl("pay", record.id),
  };
}

export function credentialFetchApprovalStatus(
  record: CredentialFetchApprovalRecord,
  now: Date,
): ApprovalStatus {
  switch (record.status) {
    case "consumed":
      return "completed";
    case "denied":
      return "denied";
    case "failed":
      return record.failureCode === "expired" ? "expired" : "failed";
    case "approved":
      return record.expiresAt <= now ? "expired" : "approved";
    case "pending":
      return record.expiresAt <= now ? "expired" : "pending";
  }
}

export function credentialFetchApprovalCard(
  record: CredentialFetchApprovalRecord,
  now: Date,
): ApprovalCard {
  const name = credentialName(record.credentialService, record.credentialLabel);
  return {
    id: record.id,
    kind: "credential_fetch",
    action: "reveal",
    title: `Reveal key: ${name}`,
    details: [
      { label: "Key", value: name },
      { label: "Fields", value: record.field ?? listText(record.fieldNames) },
      { label: "Effect", value: "The raw value goes to the requesting agent once." },
      { label: "Requested by", value: record.agent },
    ],
    status: credentialFetchApprovalStatus(record, now),
    requested_by: record.agent,
    reason: record.reason,
    created_at: record.createdAt.toISOString(),
    expires_at: record.expiresAt.toISOString(),
    approve_url: approvalPageUrl("fetch", record.id),
  };
}

function mutationStatus(
  status: "pending" | "approved" | "failed" | "denied",
  failureCode: string | null,
  expiresAt: Date,
  now: Date,
): ApprovalStatus {
  if (status === "approved") return "completed";
  if (status === "denied") return "denied";
  if (status === "failed") return failureCode === "expired" ? "expired" : "failed";
  return expiresAt <= now ? "expired" : "pending";
}

export function credentialMutationApprovalCard(
  record: CredentialMutationApprovalRecord,
  now: Date,
): ApprovalCard {
  const name = credentialName(record.credentialService, record.credentialLabel);
  const details: ApprovalDetail[] = [{ label: "Key", value: name }];
  const after = record.after;
  if (record.operation === "delete") {
    details.push({ label: "Effect", value: "The key is deleted from the vault." });
  } else if (after !== null) {
    const before = record.before;
    if (after.label !== before.label) {
      details.push({ label: "Name", value: `${before.label} → ${after.label}` });
    }
    if (listText(after.allowed_hosts) !== listText(before.allowed_hosts)) {
      details.push({
        label: "Allowed hosts",
        value: `${listText(before.allowed_hosts)} → ${listText(after.allowed_hosts)}`,
      });
    }
    if (listText(after.login_hosts) !== listText(before.login_hosts)) {
      details.push({
        label: "Login hosts",
        value: `${listText(before.login_hosts)} → ${listText(after.login_hosts)}`,
      });
    }
  }
  details.push({ label: "Requested by", value: record.agent });
  return {
    id: record.id,
    kind: "credential_mutation",
    action: record.operation,
    title: `${record.operation === "delete" ? "Delete" : "Edit"} key: ${name}`,
    details,
    status: mutationStatus(record.status, record.failureCode, record.expiresAt, now),
    requested_by: record.agent,
    reason: null,
    created_at: record.createdAt.toISOString(),
    expires_at: record.expiresAt.toISOString(),
    approve_url: approvalPageUrl("mutate", record.id),
  };
}

export function cardMutationApprovalCard(
  record: CardMutationApprovalRecord,
  now: Date,
): ApprovalCard {
  const name = cardName(record.before);
  return {
    id: record.id,
    kind: "card_mutation",
    action: "edit_card",
    title: `Edit card: ${name}`,
    details: [
      { label: "Card", value: name },
      { label: "Effect", value: "You edit the card details on the Squire page." },
      { label: "Requested by", value: record.agent },
    ],
    status: mutationStatus(record.status, record.failureCode, record.expiresAt, now),
    requested_by: record.agent,
    reason: null,
    created_at: record.createdAt.toISOString(),
    expires_at: record.expiresAt.toISOString(),
    approve_url: approvalPageUrl("mutate-card", record.id),
  };
}

type CardDeps = Pick<
  ApiDeps,
  | "pendingPaymentApprovalStore"
  | "credentialFetchApprovalStore"
  | "credentialMutationApprovalStore"
  | "cardMutationApprovalStore"
  | "e2eCredentialStore"
  | "paymentAuditStore"
>;

async function paymentCardDisplay(
  deps: CardDeps,
  record: PendingPaymentApprovalRecord,
): Promise<PaymentCardDisplay | null> {
  if (record.cardRef === null) return null;
  try {
    const card = await deps.e2eCredentialStore.getByIdForAccount(record.cardRef, record.accountId);
    return card === null ? null : { label: card.label, brand: card.brand, last4: card.last4 };
  } catch {
    // Display metadata is best-effort; the card still renders as "Saved card".
    return null;
  }
}

async function paymentOutcome(
  deps: CardDeps,
  record: PendingPaymentApprovalRecord,
): Promise<PaymentOutcome> {
  if (record.status !== "approved") return null;
  const audit = await deps.paymentAuditStore.findLatestForApproval(record.accountId, record.id);
  if (audit?.status === "merchant_order_confirmed") return "completed";
  return audit?.status === "merchant_order_failed" ? "failed" : null;
}

/**
 * The approval card for `id` in `accountId`, whichever kind it is. Ids are
 * ULIDs minted per store, so at most one store holds a given id. `kind`
 * narrows the lookup to one store when the caller already knows it.
 */
export async function readApprovalCard(
  deps: CardDeps,
  accountId: string,
  id: string,
  now: Date,
  kind?: ApprovalKind,
): Promise<ApprovalCard | null> {
  if (kind === undefined || kind === "payment") {
    const record = await deps.pendingPaymentApprovalStore.getByIdForAccount(id, accountId);
    if (record !== null) {
      const [card, outcome] = await Promise.all([
        paymentCardDisplay(deps, record),
        paymentOutcome(deps, record),
      ]);
      return paymentApprovalCard(record, card, outcome, now);
    }
  }
  if (kind === undefined || kind === "credential_fetch") {
    const record = await deps.credentialFetchApprovalStore.getByIdForAccount(id, accountId);
    if (record !== null) return credentialFetchApprovalCard(record, now);
  }
  if (kind === undefined || kind === "credential_mutation") {
    const record = await deps.credentialMutationApprovalStore.getByIdForAccount(id, accountId);
    if (record !== null) return credentialMutationApprovalCard(record, now);
  }
  if (kind === undefined || kind === "card_mutation") {
    const record = await deps.cardMutationApprovalStore.getByIdForAccount(id, accountId);
    if (record !== null) return cardMutationApprovalCard(record, now);
  }
  return null;
}
