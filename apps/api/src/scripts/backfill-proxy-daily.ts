// One-shot post-deploy backfill. Dry-run by default; --apply folds and removes
// successful historical proxy rows in short transactions. Resume at any time:
// row selection, counter increments, and deletion share one transaction.
import process from "node:process";
import type { ApiPrismaClient } from "../services/api-prisma-client.js";
import { getApiPrismaClient } from "../services/api-prisma-client.js";
import { successfulProxyCall } from "../services/proxy-daily-totals.js";

const transactionOptions = { maxWait: 30_000, timeout: 60_000 };

const eligible = `type = 'vault.proxy_executed'
  AND payload->>'response_status' ~ '^[0-9]+$'
  AND (payload->>'response_status')::int BETWEEN 100 AND 399
  AND NOT (payload ? 'proxy_error')
  AND (NOT (payload ? 'outcome') OR payload->>'outcome' = 'success')
  AND (NOT (payload ? 'rollup_pending') OR emitted_at < now() - interval '10 minutes')`;

export async function dryRunCount(db: ApiPrismaClient): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT count(*) AS count FROM "VaultAuditEvent" WHERE ${eligible}`,
  );
  return Number(rows[0]?.count ?? 0);
}

export async function foldBatch(db: ApiPrismaClient, batchSize = 500): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("batchSize must be a positive integer");
  }
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<
      Array<{
        id: string;
        account_id: string;
        payload: Record<string, unknown>;
        emitted_at: Date;
      }>
    >(
      `SELECT id, account_id, payload, emitted_at FROM "VaultAuditEvent"
         WHERE ${eligible} ORDER BY emitted_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      batchSize,
    );
    const totals = new Map<
      string,
      {
        account_id: string;
        day: string;
        reference: string;
        target_host: string;
        requester: string;
        grant_id: string;
        calls: number;
        status_breakdown: Record<string, number>;
        total_bytes: bigint;
        first_at: Date;
        last_at: Date;
      }
    >();
    for (const row of rows) {
      const call = successfulProxyCall(row.account_id, row.payload, row.emitted_at);
      if (call === null) throw new Error(`eligible proxy row ${row.id} could not be folded`);
      const day = call.at.toISOString().slice(0, 10);
      const key = JSON.stringify([
        call.account_id,
        day,
        call.reference,
        call.target_host,
        call.requester,
        call.grant_id,
      ]);
      let total = totals.get(key);
      if (!total) {
        total = {
          account_id: call.account_id,
          day,
          reference: call.reference,
          target_host: call.target_host,
          requester: call.requester,
          grant_id: call.grant_id,
          calls: 0,
          status_breakdown: {},
          total_bytes: 0n,
          first_at: call.at,
          last_at: call.at,
        };
        totals.set(key, total);
      }
      total.calls += 1;
      total.status_breakdown[call.status] = (total.status_breakdown[call.status] ?? 0) + 1;
      total.total_bytes += BigInt(call.bytes);
      if (call.at < total.first_at) total.first_at = call.at;
      if (call.at > total.last_at) total.last_at = call.at;
    }
    for (const total of totals.values()) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "VaultProxyDailyTotal"
          (account_id, day, reference, target_host, requester, grant_id, calls,
           status_breakdown, total_bytes, first_at, last_at)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8::jsonb, $9::bigint, $10, $11)
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
        total.account_id,
        total.day,
        total.reference,
        total.target_host,
        total.requester,
        total.grant_id,
        total.calls,
        JSON.stringify(total.status_breakdown),
        total.total_bytes,
        total.first_at,
        total.last_at,
      );
    }
    if (rows.length > 0) {
      await tx.$executeRawUnsafe(
        'DELETE FROM "VaultAuditEvent" WHERE id = ANY($1::text[])',
        rows.map((r) => r.id),
      );
    }
    return rows.length;
  }, transactionOptions);
}

export async function main(argv: string[]): Promise<void> {
  const url = process.env.AUTH_DATABASE_URL;
  if (!url) throw new Error("AUTH_DATABASE_URL is required");
  const db = getApiPrismaClient(url);
  const before = await dryRunCount(db);
  console.warn(`[proxy-daily] eligible successful rows: ${before}`);
  if (!argv.includes("--apply")) {
    console.warn("[proxy-daily] dry run; pass --apply after the API schema deploy");
    return;
  }
  let folded = 0;
  for (;;) {
    const n = await foldBatch(db);
    if (n === 0) break;
    folded += n;
    if (folded % 10000 < n) console.warn(`[proxy-daily] folded ${folded}`);
  }
  console.warn(`[proxy-daily] folded ${folded}; eligible remaining ${await dryRunCount(db)}`);
}
