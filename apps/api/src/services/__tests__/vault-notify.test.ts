// NotifyingVaultAuditStore — the Telegram lifecycle-notification choke
// point. Load-bearing: lifecycle events push, ACCESS events never do
// (deliberate anti-spam), and a Telegram failure never surfaces to the
// vault operation that emitted the event.

import { describe, expect, it, vi } from "vitest";
import { InMemoryVaultAuditStore, VAULT_AUDIT_TYPES } from "@trusty-squire/vault";
import { InMemoryAccountStore } from "../in-memory-account-store.js";
import {
  formatVaultEventMessage,
  NotifyingVaultAuditStore,
  recordVaultAuditAfterPersist,
  type TelegramSend,
} from "../vault-notify.js";

const NOW = new Date("2026-07-23T12:00:00.000Z");

async function setup(opts: { linked?: boolean; send?: TelegramSend } = {}) {
  const accounts = new InMemoryAccountStore();
  const account = await accounts.createAccount("notify@example.test", "Notify");
  if (opts.linked !== false) {
    await accounts.setTelegramChatId(account.id, "chat-42");
  }
  const send = vi.fn<Parameters<TelegramSend>, ReturnType<TelegramSend>>(
    opts.send ?? (async () => true),
  );
  const inner = new InMemoryVaultAuditStore();
  const store = new NotifyingVaultAuditStore(inner, accounts, () => NOW, send);
  return { store, inner, send, accountId: account.id };
}

// The send is fired void'd — flush the microtask queue before asserting.
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("NotifyingVaultAuditStore", () => {
  it("records the event and pushes a terse message for a lifecycle type", async () => {
    const { store, inner, send, accountId } = await setup();
    await store.record({
      account_id: accountId,
      type: VAULT_AUDIT_TYPES.stored,
      payload: { reference: "vault://x", requester: "agent", service: "openrouter" },
    });
    await flush();
    expect(await inner.list(accountId)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    const [chatId, text] = send.mock.calls[0]!;
    expect(chatId).toBe("chat-42");
    expect(text).toContain("Credential stored");
    expect(text).toContain("openrouter");
  });

  it("never pushes for ACCESS events (retrieved / proxy) — deliberate anti-spam", async () => {
    const { store, send, accountId } = await setup();
    for (const type of [
      VAULT_AUDIT_TYPES.retrieved,
      VAULT_AUDIT_TYPES.proxyExecuted,
      VAULT_AUDIT_TYPES.proxyRejected,
    ]) {
      await store.record({
        account_id: accountId,
        type,
        payload: { reference: "vault://x", requester: "agent" },
      });
    }
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not push when the account has no Telegram linked", async () => {
    const { store, send, accountId } = await setup({ linked: false });
    await store.record({
      account_id: accountId,
      type: VAULT_AUDIT_TYPES.deleted,
      payload: { reference: "vault://x", requester: "user", service: "stripe" },
    });
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("formats credential and card deletions with display metadata and a traceable reference", () => {
    const credentialMsg = formatVaultEventMessage(
      {
        account_id: "a",
        type: VAULT_AUDIT_TYPES.deleted,
        payload: {
          reference: "vault://account/subscription/credential",
          requester: "user",
          service: "openrouter",
          label: "production",
        },
      },
      NOW,
    );
    expect(credentialMsg).toContain("Credential deleted: openrouter (production)");
    expect(credentialMsg).toContain("vault://account/subscription/credential");

    const cardMsg = formatVaultEventMessage(
      {
        account_id: "a",
        type: VAULT_AUDIT_TYPES.cardDeleted,
        payload: {
          reference: "card://card-id",
          requester: "user",
          label: "Personal",
          last4: "4242",
        },
      },
      NOW,
    );
    expect(cardMsg).toContain("Card removed: Personal ··4242");
    expect(cardMsg).toContain("card://card-id");
  });

  it("swallows a send failure — the audit write still succeeds", async () => {
    const { store, inner, accountId } = await setup({
      send: async () => {
        throw new Error("telegram down");
      },
    });
    await expect(
      store.record({
        account_id: accountId,
        type: VAULT_AUDIT_TYPES.rotated,
        payload: { reference: "vault://x", requester: "user", service: "resend" },
      }),
    ).resolves.toBeUndefined();
    await flush();
    expect(await inner.list(accountId)).toHaveLength(1);
  });

  it("formats card and payment messages with last4 only — no secret material", () => {
    const cardMsg = formatVaultEventMessage(
      {
        account_id: "a",
        type: VAULT_AUDIT_TYPES.cardStored,
        payload: { reference: "card://c1", requester: "user", label: "Personal", last4: "4242" },
      },
      NOW,
    );
    expect(cardMsg).toContain("Card added");
    expect(cardMsg).toContain("Personal ··4242");

    const payMsg = formatVaultEventMessage(
      {
        account_id: "a",
        type: VAULT_AUDIT_TYPES.paymentExecuted,
        payload: {
          reference: "pay://p1",
          requester: "agent",
          merchant: "Synthetic Books",
          amount_cents: 1234,
          currency: "USD",
          last4: "4242",
          payment_status: "approved",
        },
      },
      NOW,
    );
    expect(payMsg).toContain("Payment approved");
    expect(payMsg).toContain("Synthetic Books");
    expect(payMsg).toContain("USD 12.34");
    expect(payMsg).toContain("··4242");
    expect(payMsg).toContain("2026-07-23T12:00:00Z");

    const yenPayMsg = formatVaultEventMessage(
      {
        account_id: "a",
        type: VAULT_AUDIT_TYPES.paymentExecuted,
        payload: {
          reference: "pay://p2",
          requester: "agent",
          merchant: "Japan Flower Shop",
          amount_cents: 9845,
          currency: "JPY",
          payment_status: "approved",
        },
      },
      NOW,
    );
    expect(yenPayMsg).toContain("JPY 9845");
    expect(yenPayMsg).not.toContain("JPY 98.45");
  });

  it("formats legacy authenticated-pending payments as manual-check warnings", () => {
    const message = formatVaultEventMessage(
      {
        account_id: "a",
        type: VAULT_AUDIT_TYPES.paymentExecuted,
        payload: {
          reference: "pay://p3",
          requester: "agent",
          merchant: "Synthetic Books",
          amount_cents: 1234,
          currency: "USD",
          payment_status: "payment_3ds_authenticated_pending_order",
        },
      },
      NOW,
    );

    expect(message).toContain("⚠️ Payment pending — manual order check required");
    expect(message).toContain("Synthetic Books — USD 12.34");
    expect(message).not.toContain("💸");
  });

  it("formats place-order attempts without implying an executed payment", () => {
    const message = formatVaultEventMessage(
      {
        account_id: "a",
        type: VAULT_AUDIT_TYPES.paymentExecuted,
        payload: {
          reference: "pay://p4",
          requester: "agent",
          merchant: "Synthetic Books",
          amount_cents: 1234,
          currency: "USD",
          payment_status: "payment_place_order_attempted",
        },
      },
      NOW,
    );

    expect(message).toContain("Place-order attempted");
    expect(message).toContain("Synthetic Books — USD 12.34");
    expect(message).not.toContain("💸");
    expect(message).not.toContain("Payment payment_place_order_attempted");
  });

  it("logs audit failures without rejecting a completed mutation", async () => {
    const logger = { error: vi.fn() };
    await expect(
      recordVaultAuditAfterPersist(
        {
          record: async () => {
            throw new Error("synthetic audit outage");
          },
        } as unknown as InMemoryVaultAuditStore,
        {
          account_id: "a",
          type: VAULT_AUDIT_TYPES.grantMinted,
          payload: { reference: "vault://x", requester: "agent", grant_id: "g_1" },
        },
        logger,
      ),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        marker: "vault-audit-write-failed",
        type: VAULT_AUDIT_TYPES.grantMinted,
        reference: "vault://x",
      }),
      "vault-audit-write-failed",
    );
  });

  it("formats revoked grants with service, label, id, and timestamp", () => {
    const message = formatVaultEventMessage(
      {
        account_id: "a",
        type: VAULT_AUDIT_TYPES.grantRevoked,
        payload: {
          reference: "vault://x",
          requester: "agent",
          service: "openrouter",
          label: "production",
          grant_id: "g_1",
        },
      },
      NOW,
    );
    expect(message).toContain("Egress grant revoked");
    expect(message).toContain("openrouter (production)");
    expect(message).toContain("g_1");
    expect(message).toContain("2026-07-23T12:00:00Z");
  });
});
