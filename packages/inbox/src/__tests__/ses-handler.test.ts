// SES handler tests — mock the S3 fetcher so no AWS dependency.
//
// Verifies: alias lookup → ReceivedEmail row, RFC 822 Message-ID
// dedupe (SES retries), no-alias-match outcome, encrypted-rejection.

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  InMemoryAliasStore,
  InMemoryEmailStore,
  SesHandler,
  type RawEmailFetcher,
  type SesInboundNotification,
} from "../index.js";

const NOW = new Date("2026-05-10T08:00:00.000Z");
const ALIAS = "abc12345.resend.run-01h@mail.trustysquire.ai";

function emailBytes(messageId: string, opts: { encrypted?: boolean } = {}): Buffer {
  if (opts.encrypted === true) {
    return Buffer.from(
      `From: secure@example.com\r\n` +
        `To: ${ALIAS}\r\n` +
        `Subject: Encrypted\r\n` +
        `Message-ID: <${messageId}>\r\n` +
        `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"\r\n\r\n` +
        `cipher-bytes\r\n`,
    );
  }
  return Buffer.from(
    `From: noreply@resend.com\r\n` +
      `To: ${ALIAS}\r\n` +
      `Subject: Verify\r\n` +
      `Message-ID: <${messageId}>\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
      `Code: 482915\r\nClick https://resend.com/verify?token=tok_xyz\r\n`,
  );
}

class StaticFetcher implements RawEmailFetcher {
  constructor(private readonly bytesByKey: Map<string, Buffer>) {}
  async fetch(_bucket: string, key: string): Promise<Buffer> {
    const b = this.bytesByKey.get(key);
    if (b === undefined) throw new Error(`mock fetcher has no bytes for key ${key}`);
    return b;
  }
}

interface Setup {
  handler: SesHandler;
  aliasStore: InMemoryAliasStore;
  emailStore: InMemoryEmailStore;
  fetcher: StaticFetcher;
}

async function setup(opts: { registerAlias?: boolean } = {}): Promise<Setup> {
  const aliasStore = new InMemoryAliasStore();
  const emailStore = new InMemoryEmailStore();
  if (opts.registerAlias !== false) {
    await aliasStore.insert({
      alias: ALIAS,
      account_id: "01HACCOUNTAAAAAAAAAAAAAAAA",
      run_id: "01HRUNAAAAAAAAAAAAAAAAAAAA",
      service: "resend",
      issued_to: null,
      active: true,
      inbound_count: 0,
      created_at: NOW,
      expires_at: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    });
  }
  const fetcher = new StaticFetcher(new Map());
  const handler = new SesHandler({ aliasStore, emailStore, fetcher, now: () => NOW });
  return { handler, aliasStore, emailStore, fetcher };
}

function notification(key: string, recipients?: string[]): SesInboundNotification {
  return {
    bucket: "test-bucket",
    key,
    ...(recipients !== undefined ? { recipients } : {}),
  };
}

describe("SesHandler.ingest", () => {
  it("stores a fresh email, links the run, bumps inbound_count", async () => {
    const { handler, aliasStore, emailStore, fetcher } = await setup();
    fetcher["bytesByKey"].set("incoming/m1", emailBytes("m1@resend.com"));

    const outcome = await handler.ingest(notification("incoming/m1", [ALIAS]));
    expect(outcome.kind).toBe("stored");
    if (outcome.kind !== "stored") return;
    expect(outcome.email.associated_run_id).toBe("01HRUNAAAAAAAAAAAAAAAAAAAA");
    expect(outcome.email.parsed_codes).toContain("482915");
    expect(outcome.email.s3_raw_uri).toBe("s3://test-bucket/incoming/m1");

    const aliasRec = await aliasStore.find(ALIAS);
    expect(aliasRec?.inbound_count).toBe(1);
    expect(await emailStore.findByAlias(ALIAS)).toHaveLength(1);
  });

  it("dedupes by Message-ID — SES retry returns 'duplicate'", async () => {
    const { handler, aliasStore, fetcher } = await setup();
    fetcher["bytesByKey"].set("incoming/m1", emailBytes("dup@resend.com"));
    fetcher["bytesByKey"].set("incoming/m1-retry", emailBytes("dup@resend.com"));

    const first = await handler.ingest(notification("incoming/m1", [ALIAS]));
    expect(first.kind).toBe("stored");
    const retry = await handler.ingest(notification("incoming/m1-retry", [ALIAS]));
    expect(retry.kind).toBe("duplicate");
    if (retry.kind !== "duplicate") return;
    expect(retry.message_id).toContain("dup@resend.com");

    // inbound_count must NOT be bumped on duplicates.
    const aliasRec = await aliasStore.find(ALIAS);
    expect(aliasRec?.inbound_count).toBe(1);
  });

  it("no_alias_match when the recipients don't resolve", async () => {
    const { handler, fetcher } = await setup({ registerAlias: false });
    fetcher["bytesByKey"].set("incoming/orphan", emailBytes("orphan@resend.com"));

    const outcome = await handler.ingest(notification("incoming/orphan", [ALIAS]));
    expect(outcome.kind).toBe("no_alias_match");
  });

  it("encrypted email is rejected with outcome 'encrypted_rejected'", async () => {
    const { handler, fetcher } = await setup();
    fetcher["bytesByKey"].set(
      "incoming/pgp",
      emailBytes("pgp@example.com", { encrypted: true }),
    );

    const outcome = await handler.ingest(notification("incoming/pgp", [ALIAS]));
    expect(outcome.kind).toBe("encrypted_rejected");
  });

  it("falls back to parsed To: when notification.recipients is omitted", async () => {
    const { handler, fetcher } = await setup();
    fetcher["bytesByKey"].set("incoming/no-recip", emailBytes("nr@resend.com"));

    const outcome = await handler.ingest(notification("incoming/no-recip"));
    expect(outcome.kind).toBe("stored");
  });
});
