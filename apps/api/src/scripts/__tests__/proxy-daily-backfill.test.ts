import { describe, expect, it } from "vitest";
import type { ApiPrismaClient } from "../../services/api-prisma-client.js";
import {
  incrementProxyDailyTotal,
  type SuccessfulProxyCall,
} from "../../services/proxy-daily-totals.js";
import { dryRunDays, foldDay } from "../backfill-proxy-daily.js";

const call: SuccessfulProxyCall = {
  account_id: "acct",
  reference: "vault://ref",
  target_host: "api.example.com",
  requester: "agent",
  grant_id: "grant",
  status: 200,
  bytes: 12,
  at: new Date("2026-01-16T12:00:00.000Z"),
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
  });

  it("summarizes completed UTC days oldest first", async () => {
    const db = {
      $queryRawUnsafe: async (sql: string, today: string) => {
        expect(today).toBe("2026-01-17");
        expect(sql).toContain("emitted_at < $1::date");
        expect(sql).toContain("GROUP BY emitted_at::date ORDER BY day");
        return [
          { day: new Date("2026-01-15T00:00:00Z"), count: 2n },
          { day: new Date("2026-01-16T00:00:00Z"), count: 3n },
        ];
      },
    } as unknown as ApiPrismaClient;
    expect(await dryRunDays(db, "2026-01-17")).toEqual([
      { day: "2026-01-15", count: 2 },
      { day: "2026-01-16", count: 3 },
    ]);
  });

  it("uses one indexed day range for set-based insert and delete in a repeatable-read transaction", async () => {
    const statements: string[] = [];
    const parameters: unknown[][] = [];
    const options: unknown[] = [];
    const db = {
      $transaction: async (fn: (tx: ApiPrismaClient) => Promise<number>, opts: unknown) => {
        options.push(opts);
        return fn(db as ApiPrismaClient);
      },
      $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
        statements.push(sql);
        parameters.push(params);
        return sql.startsWith("DELETE") ? 3 : 1;
      },
    } as unknown as ApiPrismaClient;

    expect(await foldDay(db, "2026-01-16")).toBe(3);
    expect(statements).toHaveLength(2);
    for (const sql of statements) {
      expect(sql).toContain(
        "emitted_at >= $1::date AND emitted_at < ($1::date + interval '1 day')",
      );
      expect(sql).toContain("type = 'vault.proxy_executed'");
      expect(sql).toContain("(payload->>'response_status')::int BETWEEN 100 AND 399");
      expect(sql).toContain("NOT (payload ? 'proxy_error')");
      expect(sql).toContain("payload->>'outcome' = 'success'");
      expect(sql).toContain("emitted_at < now() - interval '10 minutes'");
    }
    expect(statements[0]).toContain('INSERT INTO "VaultProxyDailyTotal"');
    expect(statements[0]).toContain("jsonb_object_agg(status::text, calls)");
    expect(statements[0]).toContain('"VaultProxyDailyTotal".calls + EXCLUDED.calls');
    expect(statements[0]).toContain('"VaultProxyDailyTotal".total_bytes + EXCLUDED.total_bytes');
    expect(statements[1]).toContain('DELETE FROM "VaultAuditEvent"');
    expect(parameters).toEqual([["2026-01-16"], ["2026-01-16"]]);
    expect(options).toEqual([
      { maxWait: 30_000, timeout: 1_800_000, isolationLevel: "RepeatableRead" },
    ]);
  });

  it("refuses to fold the current UTC day", async () => {
    const db = {} as ApiPrismaClient;
    await expect(foldDay(db, new Date().toISOString().slice(0, 10))).rejects.toThrow(
      "only completed UTC days",
    );
  });
});
