// The approval card: everything a host app needs to draw a pending risky
// action in its own conversation UI, with no further call. Display data only —
// it never carries a secret value or card data.

export type ApprovalKind = "payment" | "credential_fetch" | "credential_mutation" | "card_mutation";

export type ApprovalAction = "pay" | "reveal" | "edit" | "delete" | "edit_card";

/**
 * - `pending`: waiting for the user.
 * - `approved`: the user signed with their passkey; the action has not run yet.
 * - `processing`: a payment's card went to the Squire broker or your app; checkout is under way.
 * - `completed`: the action ran (key edited or deleted, card edited, key revealed, order confirmed).
 * - `failed`: the action could not run after approval; nothing more will happen.
 * - `denied`: the user said no. Nothing changed.
 * - `expired`: nobody answered in time. Nothing changed.
 *
 * `approved` is never "done". Wait for `completed` before telling the user it happened.
 */
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "processing"
  | "completed"
  | "failed"
  | "denied"
  | "expired";

export interface ApprovalDetail {
  label: string;
  value: string;
}

export interface Approval {
  id: string;
  kind: ApprovalKind;
  action: ApprovalAction;
  /** One line, e.g. "Pay USD 38.00 to whitejade.xyz". */
  title: string;
  /** Label/value rows to show under the title, in order. */
  details: ApprovalDetail[];
  status: ApprovalStatus;
  requestedBy: string;
  reason: string | null;
  createdAt: string;
  expiresAt: string;
  /** The Squire page where the user signs. Open it with `approvals.open()`. */
  approveUrl: string;
}

/** The API's JSON for an approval card. */
export interface ApprovalWire {
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

const TERMINAL: ReadonlySet<ApprovalStatus> = new Set(["completed", "failed", "denied", "expired"]);

/** True once the approval can no longer change. */
export function isFinalStatus(status: ApprovalStatus): boolean {
  return TERMINAL.has(status);
}

export function approvalFromWire(wire: ApprovalWire): Approval {
  return {
    id: wire.id,
    kind: wire.kind,
    action: wire.action,
    title: wire.title,
    details: wire.details.map((detail) => ({ label: detail.label, value: detail.value })),
    status: wire.status,
    requestedBy: wire.requested_by,
    reason: wire.reason,
    createdAt: wire.created_at,
    expiresAt: wire.expires_at,
    approveUrl: wire.approve_url,
  };
}
