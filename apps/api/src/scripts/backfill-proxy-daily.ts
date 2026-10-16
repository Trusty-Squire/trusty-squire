// One-shot post-deploy backfill. Dry-run by default; --apply folds and removes
// successful historical proxy rows in short transactions. Resume at any time:
// row selection, counter increments, and deletion share one transaction.
import process from "node:process";
import type { ApiPrismaClient } from "../services/api-prisma-client.js";
import { getApiPrismaClient } from "../services/api-prisma-client.js";
import { incrementProxyDailyTotal, successfulProxyCall } from "../services/proxy-daily-totals.js";

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
    for (const row of rows) {
      const call = successfulProxyCall(row.account_id, row.payload, row.emitted_at);
      if (call === null) throw new Error(`eligible proxy row ${row.id} could not be folded`);
      await incrementProxyDailyTotal(tx, call);
    }
    if (rows.length > 0) {
      await tx.$executeRawUnsafe(
        'DELETE FROM "VaultAuditEvent" WHERE id = ANY($1::text[])',
        rows.map((r) => r.id),
      );
    }
    return rows.length;
  });
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
