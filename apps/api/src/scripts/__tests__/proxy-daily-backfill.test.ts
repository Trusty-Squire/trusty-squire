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
});
