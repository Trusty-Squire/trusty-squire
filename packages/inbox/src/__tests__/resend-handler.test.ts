import { describe, expect, it } from "vitest";
import {
  InMemoryAliasStore,
  InMemoryEmailStore,
  ResendHandler,
  type EmailAliasRecord,
} from "../index.js";

const NOW = new Date("2026-06-26T00:00:00.000Z");

function aliasRecord(alias: string): EmailAliasRecord {
  return {
    alias,
    account_id: "acct_1",
    run_id: "run_1",
    service: "arize",
    issued_to: null,
    active: true,
    inbound_count: 0,
    created_at: NOW,
    expires_at: new Date(NOW.getTime() + 60_000),
  };
}

describe("ResendHandler", () => {
  it("extracts verification links and codes from HTML-only inbound mail", async () => {
    const aliasStore = new InMemoryAliasStore();
    const emailStore = new InMemoryEmailStore();
    const alias = "abc.arize.run-1@trustysquire.com";
    await aliasStore.insert(aliasRecord(alias));

    const handler = new ResendHandler({
      aliasStore,
      emailStore,
      now: () => NOW,
    });

    const outcome = await handler.ingest({
      message_id: "<html-only@example.com>",
      from: "noreply@arize.com",
      to: [alias],
      subject: "Complete your account signup",
      html:
        '<p>Use code <strong>482915</strong></p>' +
        '<a href="https://app.arize.com/auth/verify?token=abc123">Complete signup</a>',
    });

    expect(outcome.kind).toBe("stored");
    const emails = await emailStore.findByAlias(alias);
    expect(emails).toHaveLength(1);
    expect(emails[0]?.body_text).toBeNull();
    expect(emails[0]?.body_html).toContain("Complete signup");
    expect(emails[0]?.parsed_links).toEqual([
      "https://app.arize.com/auth/verify?token=abc123",
    ]);
    expect(emails[0]?.parsed_codes).toContain("482915");
  });

  it("fetches received-email content when the webhook payload is metadata-only", async () => {
    const aliasStore = new InMemoryAliasStore();
    const emailStore = new InMemoryEmailStore();
    const alias = "abc.paddle.run-1@trustysquire.com";
    await aliasStore.insert(aliasRecord(alias));

    const handler = new ResendHandler({
      aliasStore,
      emailStore,
      now: () => NOW,
      fetchEmailContent: async (emailId) => {
        expect(emailId).toBe("rx_123");
        return {
          text: null,
          html: '<a href="https://login.paddle.com/verify?token=tok_123">Verify email</a>',
          received_at: "2026-06-26T00:00:10.000Z",
        };
      },
    });

    const outcome = await handler.ingest({
      email_id: "rx_123",
      message_id: "<metadata-only@example.com>",
      from: "help@paddle.com",
      to: [alias],
      subject: "Verify your email address",
    });

    expect(outcome.kind).toBe("stored");
    const emails = await emailStore.findByAlias(alias);
    expect(emails[0]?.parsed_links).toEqual([
      "https://login.paddle.com/verify?token=tok_123",
    ]);
    expect(emails[0]?.received_at.toISOString()).toBe("2026-06-26T00:00:10.000Z");
  });
});
