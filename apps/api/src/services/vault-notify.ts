// Telegram notifications for vault LIFECYCLE events, implemented as a
// VaultAuditStore decorator. Every audit write — from the vault package
// (credential store/rotate/delete) and from the card/payment/grant routes —
// flows through record(), so notification coverage cannot drift from the
// audit trail: if an event is auditable, it is notifiable from this one
// choke point.
//
// Deliberately NOTIFIED (rare, user-significant):
//   credential stored / rotated / deleted / restored,
//   card stored / deleted, payment executed, grant minted / revoked.
// Deliberately EXCLUDED (per-event pushes would be spam):
//   ACCESS events — vault.credential_retrieved, vault.proxy_executed,
//   vault.proxy_rejected. A future access DIGEST (batched summary behind a
//   per-account opt-in, default OFF) is the right shape for those; a
//   per-access push is not, so do not add these types to NOTIFY_TYPES.
//   Also excluded as pure metadata churn: renamed, field_added, collapsed.
//
// Sends are fire-and-forget: a Telegram outage must never fail or delay
// the vault operation that emitted the event.

import type {
  VaultAuditEventInput,
  VaultAuditListOptions,
  VaultAuditPayload,
  VaultAuditRecord,
  VaultAuditStore,
  VaultAuditType,
} from "@trusty-squire/vault";
import { VAULT_AUDIT_TYPES } from "@trusty-squire/vault";
import type { AccountStore } from "./in-memory-account-store.js";
import { formatCurrencyAmount } from "./money.js";
import { sendTelegramMessage } from "./telegram.js";

const NOTIFY_TYPES: ReadonlySet<VaultAuditType> = new Set([
  VAULT_AUDIT_TYPES.stored,
  VAULT_AUDIT_TYPES.rotated,
  VAULT_AUDIT_TYPES.deleted,
  VAULT_AUDIT_TYPES.restored,
  VAULT_AUDIT_TYPES.cardStored,
  VAULT_AUDIT_TYPES.cardDeleted,
  VAULT_AUDIT_TYPES.paymentExecuted,
  VAULT_AUDIT_TYPES.grantMinted,
  VAULT_AUDIT_TYPES.grantRevoked,
]);

// Terse, secret-free message per event. Service/label + action + timestamp;
// last4 only for cards. Never a key value, PAN, or CVV — the payload can't
// carry one by construction, and this formatter only reads display fields.
export function formatVaultEventMessage(event: VaultAuditEventInput, at: Date): string {
  const p = event.payload;
  const ts = at.toISOString().replace(/\.\d{3}Z$/, "Z");
  const subject = credentialSubject(p);
  switch (event.type) {
    case VAULT_AUDIT_TYPES.stored:
      return `🔑 Credential stored: ${subject} · ${ts}`;
    case VAULT_AUDIT_TYPES.rotated:
      return `♻️ Credential rotated: ${subject} · ${ts}`;
    case VAULT_AUDIT_TYPES.deleted:
      return p.purpose === "user:revoke_all"
        ? `🛑 Credential revoked (kill-switch): ${subject} · ${ts}`
        : `🗑 Credential deleted: ${credentialDeletionSubject(p)} · ${p.reference} · ${ts}`;
    case VAULT_AUDIT_TYPES.restored:
      return `↩️ Credential restored: ${subject} · ${ts}`;
    case VAULT_AUDIT_TYPES.cardStored:
      return `💳 Card added: ${cardSubject(p)} · ${ts}`;
    case VAULT_AUDIT_TYPES.cardDeleted:
      return `💳 Card removed: ${cardSubject(p)} · ${p.reference} · ${ts}`;
    case VAULT_AUDIT_TYPES.paymentExecuted: {
      const paymentDetail = `${p.merchant ?? "unknown merchant"}${
        p.amount_cents !== undefined && p.currency !== undefined
          ? ` — ${formatCurrencyAmount(p.amount_cents, p.currency)}`
          : ""
      }${p.last4 !== undefined ? ` ··${p.last4}` : ""} · ${ts}`;
      return `💸 Payment ${p.payment_status ?? "executed"}: ${paymentDetail}`;
    }
    case VAULT_AUDIT_TYPES.grantMinted:
      return `🔗 Egress grant minted: ${subject} · ${ts}`;
    case VAULT_AUDIT_TYPES.grantRevoked:
      return `⛔ Egress grant revoked: ${subject}${
        p.grant_id !== undefined ? ` (${p.grant_id})` : ""
      } · ${ts}`;
    default:
      return `Vault event ${event.type}: ${subject} · ${ts}`;
  }
}

function credentialSubject(p: VaultAuditPayload): string {
  const service = p.service ?? p.reference;
  return p.label !== undefined && p.label !== "default" ? `${service} (${p.label})` : service;
}

function credentialDeletionSubject(p: VaultAuditPayload): string {
  if (p.service === undefined) return "credential";
  return p.label !== undefined && p.label !== "default" ? `${p.service} (${p.label})` : p.service;
}

function cardSubject(p: VaultAuditPayload): string {
  const name = p.label ?? "card";
  return p.last4 !== undefined ? `${name} ··${p.last4}` : name;
}

export type TelegramSend = (chatId: string, text: string) => Promise<boolean>;

export async function recordVaultAuditAfterPersist(
  store: VaultAuditStore,
  event: VaultAuditEventInput,
  logger: {
    error(bindings: Record<string, unknown>, message?: string): void;
  },
): Promise<void> {
  try {
    await store.record(event);
  } catch (err) {
    try {
      logger.error(
        {
          marker: "vault-audit-write-failed",
          type: event.type,
          reference: event.payload.reference,
          err,
        },
        "vault-audit-write-failed",
      );
    } catch {}
  }
}

export function notifyVaultAuditAfterCommit(
  store: VaultAuditStore,
  event: VaultAuditEventInput,
): void {
  if (store instanceof NotifyingVaultAuditStore) {
    store.notifyRecorded(event);
  }
}

export class NotifyingVaultAuditStore implements VaultAuditStore {
  private readonly send: TelegramSend;

  constructor(
    private readonly inner: VaultAuditStore,
    private readonly accounts: AccountStore,
    private readonly now: () => Date = () => new Date(),
    send: TelegramSend = sendTelegramMessage,
  ) {
    this.send = send;
  }

  async record(event: VaultAuditEventInput): Promise<void> {
    await this.inner.record(event);
    this.notifyRecorded(event);
  }

  notifyRecorded(event: VaultAuditEventInput): void {
    if (!NOTIFY_TYPES.has(event.type)) return;
    void this.notify(event).catch(() => {});
  }

  private async notify(event: VaultAuditEventInput): Promise<void> {
    const account = await this.accounts.findAccountById(event.account_id);
    if (account?.telegram_chat_id == null) return;
    await this.send(account.telegram_chat_id, formatVaultEventMessage(event, this.now()));
  }

  countRecentRetrievals(accountId: string, since: Date): Promise<number> {
    return this.inner.countRecentRetrievals(accountId, since);
  }

  list(accountId: string, opts?: VaultAuditListOptions): Promise<VaultAuditRecord[]> {
    return this.inner.list(accountId, opts);
  }

  exportAll(accountId: string): Promise<VaultAuditRecord[]> {
    return this.inner.exportAll(accountId);
  }

  purgeAccount(accountId: string): Promise<number> {
    return this.inner.purgeAccount(accountId);
  }
}
