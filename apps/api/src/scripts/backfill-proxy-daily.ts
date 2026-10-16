// One-shot post-deploy backfill. Dry-run by default. Each completed UTC day is
// folded and removed atomically; today's live traffic is left to the API.
import process from "node:process";
import type { ApiPrismaClient } from "../services/api-prisma-client.js";
import { getApiPrismaClient } from "../services/api-prisma-client.js";

const transactionOptions = {
  maxWait: 30_000,
  timeout: 1_800_000,
  isolationLevel: "RepeatableRead" as const,
};

// Keep this predicate in both the summary and both statements of the fold.
const eligible = `type = 'vault.proxy_executed'
  AND payload->>'response_status' ~ '^[0-9]+$'
  AND (payload->>'response_status')::int BETWEEN 100 AND 399
  AND NOT (payload ? 'proxy_error')
  AND (NOT (payload ? 'outcome') OR payload->>'outcome' = 'success')
  AND (NOT (payload ? 'rollup_pending') OR emitted_at < now() - interval '10 minutes')`;

export interface DaySummary {
  day: string;
  count: number;
}

export async function dryRunDays(db: ApiPrismaClient, today: string): Promise<DaySummary[]> {
  const rows = await db.$queryRawUnsafe<Array<{ day: Date; count: bigint }>>(
    `SELECT emitted_at::date AS day, count(*) AS count
       FROM "VaultAuditEvent"
      WHERE ${eligible} AND emitted_at < $1::date
      GROUP BY emitted_at::date ORDER BY day`,
    today,
  );
  return rows.map((row) => ({ day: row.day.toISOString().slice(0, 10), count: Number(row.count) }));
}

// REPEATABLE READ makes the INSERT and DELETE see the same source snapshot.
// A concurrent change to an old source row aborts the transaction rather than
// deleting a row that the INSERT did not count.
export async function foldDay(db: ApiPrismaClient, day: string): Promise<number> {
  const parsedDay = Date.parse(`${day}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    Number.isNaN(parsedDay) ||
    new Date(parsedDay).toISOString().slice(0, 10) !== day
  ) {
    throw new Error("day must be a UTC YYYY-MM-DD date");
  }
  if (day >= new Date().toISOString().slice(0, 10)) {
    throw new Error("only completed UTC days may be folded");
  }
  const range = `emitted_at >= $1::date AND emitted_at < ($1::date + interval '1 day')`;
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `WITH normalized AS (
         SELECT account_id, emitted_at,
           CASE WHEN jsonb_typeof(payload->'reference') = 'string'
                     AND payload->>'reference' <> '' THEN payload->>'reference' ELSE '(unknown)' END AS reference,
           CASE WHEN jsonb_typeof(payload->'target_host') = 'string'
                     AND payload->>'target_host' <> '' THEN payload->>'target_host' ELSE '(unknown)' END AS target_host,
           CASE WHEN jsonb_typeof(payload->'requester') = 'string'
                     AND payload->>'requester' <> '' THEN payload->>'requester' ELSE '(unknown)' END AS requester,
           CASE WHEN jsonb_typeof(payload->'grant_id') = 'string' THEN payload->>'grant_id' ELSE '' END AS grant_id,
           (payload->>'response_status')::int AS status,
           CASE WHEN jsonb_typeof(payload->'response_size') = 'number'
                THEN GREATEST(0, trunc((payload->>'response_size')::numeric))::bigint
                ELSE 0::bigint END AS bytes
         FROM "VaultAuditEvent"
         WHERE ${range} AND ${eligible}
       ), by_status AS (
         SELECT account_id, reference, target_host, requester, grant_id, status,
                count(*)::int AS calls, sum(bytes)::bigint AS total_bytes,
                min(emitted_at) AS first_at, max(emitted_at) AS last_at
         FROM normalized
         GROUP BY account_id, reference, target_host, requester, grant_id, status
       )
       INSERT INTO "VaultProxyDailyTotal"
         (account_id, day, reference, target_host, requester, grant_id, calls,
          status_breakdown, total_bytes, first_at, last_at)
       SELECT account_id, $1::date, reference, target_host, requester, grant_id,
              sum(calls)::int, jsonb_object_agg(status::text, calls),
              sum(total_bytes)::bigint, min(first_at), max(last_at)
       FROM by_status
       GROUP BY account_id, reference, target_host, requester, grant_id
       ON CONFLICT (account_id, day, reference, target_host, requester, grant_id)
       DO UPDATE SET
         calls = "VaultProxyDailyTotal".calls + EXCLUDED.calls,
         status_breakdown = "VaultProxyDailyTotal".status_breakdown || (
           SELECT jsonb_object_agg(key, to_jsonb(
             COALESCE(("VaultProxyDailyTotal".status_breakdown ->> key)::int, 0) + value::int
           )) FROM jsonb_each_text(EXCLUDED.status_breakdown)
         ),
         total_bytes = "VaultProxyDailyTotal".total_bytes + EXCLUDED.total_bytes,
         first_at = LEAST("VaultProxyDailyTotal".first_at, EXCLUDED.first_at),
         last_at = GREATEST("VaultProxyDailyTotal".last_at, EXCLUDED.last_at)`,
      day,
    );
    return tx.$executeRawUnsafe(
      `DELETE FROM "VaultAuditEvent" WHERE ${range} AND ${eligible}`,
      day,
    );
  }, transactionOptions);
}

export async function main(argv: string[]): Promise<void> {
  const url = process.env.AUTH_DATABASE_URL;
  if (!url) throw new Error("AUTH_DATABASE_URL is required");
  const db = getApiPrismaClient(url);
  const today = new Date().toISOString().slice(0, 10);
  const days = await dryRunDays(db, today);
  for (const { day, count } of days) console.warn(`[proxy-daily] ${day}: ${count} eligible rows`);
  console.warn(
    `[proxy-daily] ${days.reduce((sum, row) => sum + row.count, 0)} eligible rows before ${today} UTC`,
  );
  if (!argv.includes("--apply")) {
    console.warn("[proxy-daily] dry run; pass --apply after the API schema deploy");
    return;
  }
  let folded = 0;
  for (const { day } of days) {
    const count = await foldDay(db, day);
    folded += count;
    console.warn(`[proxy-daily] folded ${day}: ${count}`);
  }
  console.warn(
    `[proxy-daily] folded ${folded}; eligible completed days remaining ${(
      await dryRunDays(db, today)
    ).reduce((sum, row) => sum + row.count, 0)}`,
  );
}
