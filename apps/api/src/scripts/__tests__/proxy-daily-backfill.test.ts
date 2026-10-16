import { describe, expect, it } from "vitest";
import type { ApiPrismaClient } from "../../services/api-prisma-client.js";
import {
  incrementProxyDailyTotal,
  type SuccessfulProxyCall,
} from "../../services/proxy-daily-totals.js";
import { dryRunCount, foldBatch } from "../backfill-proxy-daily.js";

const call: SuccessfulProxyCall = {
  account_id: "acct",
  reference: "vault://ref",
  target_host: "api.example.com",
  requester: "agent",
  grant_id: "grant",
  status: 200,
  bytes: 12,
  at: new Date("2026-10-16T12:00:00.000Z"),
};

describe("proxy daily counters", () => {
  it("uses an atomic conflict update for concurrent writers", async () => {
    let count = 0;
    let bytes = 0;
    const sql: string[] = [];
    const db = {
      $executeRawUnsafe: async (statement: string, ...params: unknown[]) => {
        sql.push(statement);
        await Promise.resolve();
        count += 1;
        bytes += params[7] as number;
        return 1;
      },
    } as unknown as ApiPrismaClient;
    await Promise.all(Array.from({ length: 100 }, () => incrementProxyDailyTotal(db, call)));
    expect(count).toBe(100);
    expect(bytes).toBe(1200);
    expect(sql[0]).toContain(
      "ON CONFLICT (account_id, day, reference, target_host, requester, grant_id)",
    );
    expect(sql[0]).toContain('"VaultProxyDailyTotal".calls + 1');
    expect(sql[0]).toContain('"VaultProxyDailyTotal".total_bytes + EXCLUDED.total_bytes');
  });

  it("folds and deletes each batch in one transaction; a second run is empty", async () => {
    const source = [
      {
        id: "event-1",
        account_id: call.account_id,
        emitted_at: call.at,
        payload: {
          reference: call.reference,
          requester: call.requester,
          target_host: call.target_host,
          grant_id: call.grant_id,
          response_status: 200,
          response_size: 12,
        },
      },
    ];
    let counter = 0;
    const db = {
      $transaction: async (fn: (tx: ApiPrismaClient) => Promise<number>) =>
        fn(db as ApiPrismaClient),
      $queryRawUnsafe: async (sql: string) =>
        sql.includes("count(*)") ? [{ count: BigInt(source.length) }] : [...source],
      $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
        if (sql.includes('INSERT INTO "VaultProxyDailyTotal"')) counter += 1;
        if (sql.includes('DELETE FROM "VaultAuditEvent"')) {
          const ids = params[0] as string[];
          for (const id of ids)
            source.splice(
              source.findIndex((row) => row.id === id),
              1,
            );
        }
        return 1;
      },
    } as unknown as ApiPrismaClient;
    expect(await dryRunCount(db)).toBe(1);
    expect(await foldBatch(db)).toBe(1);
    expect(await foldBatch(db)).toBe(0);
    expect(await dryRunCount(db)).toBe(0);
    expect(counter).toBe(1);
  });

  it("aggregates a full batch into one increment per daily key", async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({
      id: `event-${i}`,
      account_id: "acct",
      emitted_at: new Date(`2026-10-16T${String(i % 24).padStart(2, "0")}:00:00.000Z`),
      payload: {
        reference: "vault://ref",
        target_host: "api.example.com",
        requester: "agent",
        grant_id: "grant",
        response_status: i % 2 ? 201 : 200,
        response_size: i,
      },
    }));
    const increments: unknown[][] = [];
    const deleted: string[][] = [];
    const options: unknown[] = [];
    const db = {
      $transaction: async (fn: (tx: ApiPrismaClient) => Promise<number>, opts: unknown) => {
        options.push(opts);
        return fn(db as ApiPrismaClient);
      },
      $queryRawUnsafe: async (_sql: string, limit: number) => rows.slice(0, limit),
      $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
        if (sql.includes('INSERT INTO "VaultProxyDailyTotal"')) increments.push(params);
        if (sql.includes('DELETE FROM "VaultAuditEvent"')) deleted.push(params[0] as string[]);
        return 1;
      },
    } as unknown as ApiPrismaClient;

    expect(await foldBatch(db, 500)).toBe(500);
    expect(increments).toHaveLength(1);
    expect(increments[0]?.slice(0, 7)).toEqual([
      "acct",
      "2026-10-16",
      "vault://ref",
      "api.example.com",
      "agent",
      "grant",
      500,
    ]);
    expect(JSON.parse(increments[0]?.[7] as string)).toEqual({ "200": 250, "201": 250 });
    expect(increments[0]?.[8]).toBe(124750n);
    expect(increments[0]?.[9]).toEqual(new Date("2026-10-16T00:00:00.000Z"));
    expect(increments[0]?.[10]).toEqual(new Date("2026-10-16T23:00:00.000Z"));
    expect(deleted).toEqual([rows.map((row) => row.id)]);
    expect(options).toEqual([{ maxWait: 30_000, timeout: 60_000 }]);
  });

  it("keeps distinct daily keys separate and adds all status counts on conflict", async () => {
    const rows = [
      {
        id: "a",
        account_id: "acct",
        emitted_at: new Date("2026-10-16T23:59:00Z"),
        payload: { response_status: 200, response_size: 4, reference: "ref" },
      },
      {
        id: "b",
        account_id: "acct",
        emitted_at: new Date("2026-10-16T01:00:00Z"),
        payload: { response_status: 201, response_size: 6, reference: "ref" },
      },
      {
        id: "c",
        account_id: "acct",
        emitted_at: new Date("2026-10-17T00:00:00Z"),
        payload: { response_status: 200, response_size: 8, reference: "ref" },
      },
      {
        id: "d",
        account_id: "acct",
        emitted_at: new Date("2026-10-16T12:00:00Z"),
        payload: { response_status: 200, response_size: 10, reference: "other" },
      },
    ];
    const increments: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      $transaction: async (fn: (tx: ApiPrismaClient) => Promise<number>) =>
        fn(db as ApiPrismaClient),
      $queryRawUnsafe: async () => rows,
      $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
        if (sql.includes('INSERT INTO "VaultProxyDailyTotal"')) increments.push({ sql, params });
        return 1;
      },
    } as unknown as ApiPrismaClient;

    expect(await foldBatch(db)).toBe(4);
    expect(increments).toHaveLength(3);
    const first = increments.find(
      ({ params }) => params[1] === "2026-10-16" && params[2] === "ref",
    );
    expect(first?.params[6]).toBe(2);
    expect(JSON.parse(first?.params[7] as string)).toEqual({ "200": 1, "201": 1 });
    expect(first?.params[8]).toBe(10n);
    expect(first?.params[9]).toEqual(rows[1]?.emitted_at);
    expect(first?.params[10]).toEqual(rows[0]?.emitted_at);
    expect(first?.sql).toContain('"VaultProxyDailyTotal".calls + EXCLUDED.calls');
    expect(first?.sql).toContain("jsonb_each_text(EXCLUDED.status_breakdown)");
    expect(first?.sql).toContain('"VaultProxyDailyTotal".total_bytes + EXCLUDED.total_bytes');
  });
});
