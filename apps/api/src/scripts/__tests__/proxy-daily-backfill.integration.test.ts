import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiPrismaClient } from "../../services/api-prisma-client.js";
import { successfulProxyCall } from "../../services/proxy-daily-totals.js";
import { dryRunDays, foldDay } from "../backfill-proxy-daily.js";

const databaseUrl = process.env.PROXY_DAILY_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("proxy daily backfill against PostgreSQL", () => {
  const schema = `proxy_daily_${process.pid}_${Date.now()}`;
  const scopedUrl = new URL(databaseUrl ?? "postgresql://skipped.invalid/postgres");
  scopedUrl.searchParams.set("schema", schema);
  type Client = ApiPrismaClient & { $disconnect(): Promise<void> };
  let admin: Client;
  let db: Client;

  beforeAll(async () => {
    // Vitest evaluates skipped suite definitions, so resolve the generated
    // client only when this database-backed suite actually runs.
    const require = createRequire(import.meta.url);
    const { PrismaClient } = require("../../../node_modules/.prisma/api-client/index.js") as {
      PrismaClient: new (options: { datasourceUrl: string }) => Client;
    };
    admin = new PrismaClient({ datasourceUrl: databaseUrl! });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    db = new PrismaClient({ datasourceUrl: scopedUrl.toString() });
    await db.$executeRawUnsafe(`
      CREATE TABLE "VaultAuditEvent" (
        id varchar(26) PRIMARY KEY, account_id varchar(26) NOT NULL,
        type text NOT NULL, payload jsonb NOT NULL, emitted_at timestamp(3) NOT NULL
      )`);
    await db.$executeRawUnsafe('CREATE INDEX ON "VaultAuditEvent" (type, emitted_at)');
    await db.$executeRawUnsafe(`
      CREATE TABLE "VaultProxyDailyTotal" (
        account_id varchar(26) NOT NULL, day date NOT NULL,
        reference text NOT NULL, target_host text NOT NULL,
        requester text NOT NULL, grant_id text NOT NULL,
        calls integer NOT NULL, status_breakdown jsonb NOT NULL,
        total_bytes bigint NOT NULL, first_at timestamp(3) NOT NULL,
        last_at timestamp(3) NOT NULL,
        PRIMARY KEY (account_id, day, reference, target_host, requester, grant_id)
      )`);
  });

  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  it("matches a per-row fold, rolls back a mid-day failure, and reruns idempotently", async () => {
    const day = "2026-01-15";
    const source = [
      {
        id: "one",
        account: "acct",
        at: "2026-01-15T23:00:00Z",
        payload: {
          response_status: 200,
          response_size: 12,
          reference: "ref",
          target_host: "api.example.com",
          requester: "agent",
          grant_id: "grant",
        },
      },
      {
        id: "two",
        account: "acct",
        at: "2026-01-15T01:00:00Z",
        payload: {
          response_status: 201,
          response_size: 3.8,
          reference: "ref",
          target_host: "api.example.com",
          requester: "agent",
          grant_id: "grant",
        },
      },
      {
        id: "three",
        account: "acct",
        at: "2026-01-15T12:00:00Z",
        payload: { response_status: 200, response_size: -5, reference: "other" },
      },
      {
        id: "old-pending",
        account: "acct",
        at: "2026-01-15T13:00:00Z",
        payload: {
          response_status: 204,
          response_size: 2,
          reference: "other",
          rollup_pending: true,
        },
      },
      {
        id: "bad-status",
        account: "acct",
        at: "2026-01-15T12:00:00Z",
        payload: { response_status: 400 },
      },
      {
        id: "proxy-error",
        account: "acct",
        at: "2026-01-15T12:00:00Z",
        payload: { response_status: 200, proxy_error: "failed" },
      },
      {
        id: "bad-outcome",
        account: "acct",
        at: "2026-01-15T12:00:00Z",
        payload: { response_status: 200, outcome: "failure" },
      },
      {
        id: "today",
        account: "acct",
        at: new Date().toISOString(),
        payload: { response_status: 200, response_size: 99 },
      },
    ];
    for (const row of source) {
      await db.$executeRawUnsafe(
        `INSERT INTO "VaultAuditEvent" (id, account_id, type, payload, emitted_at)
         VALUES ($1, $2, 'vault.proxy_executed', $3::jsonb, $4::timestamp)`,
        row.id,
        row.account,
        JSON.stringify(row.payload),
        row.at.replace("Z", ""),
      );
    }
    // Existing totals exercise the ON CONFLICT path and its status merge.
    await db.$executeRawUnsafe(`
      INSERT INTO "VaultProxyDailyTotal"
        (account_id, day, reference, target_host, requester, grant_id, calls,
         status_breakdown, total_bytes, first_at, last_at)
      VALUES ('acct', '2026-01-15', 'ref', 'api.example.com', 'agent', 'grant',
              1, '{"200":1}', 7, '2026-01-15T00:00:00Z', '2026-01-15T00:00:00Z')`);

    expect(await dryRunDays(db, new Date().toISOString().slice(0, 10))).toEqual([
      { day, count: 4 },
    ]);

    await db.$executeRawUnsafe(`
      CREATE FUNCTION reject_backfill_delete() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'synthetic crash after aggregate insert'; END
      $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER reject_backfill_delete BEFORE DELETE ON "VaultAuditEvent"
      FOR EACH ROW EXECUTE FUNCTION reject_backfill_delete()`);
    await expect(foldDay(db, day)).rejects.toThrow("synthetic crash");
    expect(
      await db.$queryRawUnsafe<Array<{ count: bigint }>>(
        'SELECT count(*) AS count FROM "VaultAuditEvent"',
      ),
    ).toEqual([{ count: 8n }]);
    expect(
      await db.$queryRawUnsafe<Array<{ count: bigint }>>(
        'SELECT count(*) AS count FROM "VaultProxyDailyTotal"',
      ),
    ).toEqual([{ count: 1n }]);
    await db.$executeRawUnsafe('DROP TRIGGER reject_backfill_delete ON "VaultAuditEvent"');
    await db.$executeRawUnsafe("DROP FUNCTION reject_backfill_delete()");

    expect(await foldDay(db, day)).toBe(4);
    expect(await foldDay(db, day)).toBe(0);
    const totals = await db.$queryRawUnsafe<
      Array<{
        reference: string;
        calls: number;
        status_breakdown: Record<string, number>;
        total_bytes: bigint;
        first_at: Date;
        last_at: Date;
      }>
    >(`SELECT reference, calls, status_breakdown, total_bytes, first_at, last_at
         FROM "VaultProxyDailyTotal" ORDER BY reference`);

    // Independent per-row oracle, including the previously stored live count.
    const expected = new Map<
      string,
      {
        calls: number;
        bytes: bigint;
        statuses: Record<string, number>;
        first: Date;
        last: Date;
      }
    >();
    expected.set("ref", {
      calls: 1,
      bytes: 7n,
      statuses: { "200": 1 },
      first: new Date("2026-01-15T00:00:00Z"),
      last: new Date("2026-01-15T00:00:00Z"),
    });
    for (const row of source.slice(0, 4)) {
      const call = successfulProxyCall(row.account, row.payload, new Date(row.at))!;
      const total = expected.get(call.reference) ?? {
        calls: 0,
        bytes: 0n,
        statuses: {},
        first: call.at,
        last: call.at,
      };
      total.calls++;
      total.bytes += BigInt(call.bytes);
      total.statuses[String(call.status)] = (total.statuses[String(call.status)] ?? 0) + 1;
      if (call.at < total.first) total.first = call.at;
      if (call.at > total.last) total.last = call.at;
      expected.set(call.reference, total);
    }
    expect(totals).toEqual(
      [...expected]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([reference, total]) => ({
          reference,
          calls: total.calls,
          status_breakdown: total.statuses,
          total_bytes: total.bytes,
          first_at: total.first,
          last_at: total.last,
        })),
    );
    expect(
      await db.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM "VaultAuditEvent" ORDER BY id',
      ),
    ).toEqual([
      { id: "bad-outcome" },
      { id: "bad-status" },
      { id: "proxy-error" },
      { id: "today" },
    ]);
  });
});
