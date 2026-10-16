// Atomic PostgreSQL upsert shared by live writes and the one-shot backfill.
// The conflict update locks only the matching daily key, so both API machines
// can count concurrently without a read/modify/write race.
import type { ApiPrismaClient } from "./api-prisma-client.js";

export interface SuccessfulProxyCall {
  account_id: string;
  reference: string;
  target_host: string;
  requester: string;
  grant_id: string;
  status: number;
  bytes: number;
  at: Date;
}

export function successfulProxyCall(
  accountId: string,
  payload: Record<string, unknown>,
  at: Date,
): SuccessfulProxyCall | null {
  const status = payload.response_status;
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 100 ||
    status >= 400 ||
    typeof payload.proxy_error === "string" ||
    (payload.outcome !== undefined && payload.outcome !== "success")
  )
    return null;
  return {
    account_id: accountId,
    reference:
      typeof payload.reference === "string" && payload.reference ? payload.reference : "(unknown)",
    target_host:
      typeof payload.target_host === "string" && payload.target_host
        ? payload.target_host
        : "(unknown)",
    requester:
      typeof payload.requester === "string" && payload.requester ? payload.requester : "(unknown)",
    grant_id: typeof payload.grant_id === "string" ? payload.grant_id : "",
    status,
    bytes:
      typeof payload.response_size === "number" && Number.isFinite(payload.response_size)
        ? Math.max(0, Math.trunc(payload.response_size))
        : 0,
    at,
  };
}

export async function incrementProxyDailyTotal(
  db: ApiPrismaClient,
  call: SuccessfulProxyCall,
): Promise<void> {
  await db.$executeRawUnsafe(
    `
    INSERT INTO "VaultProxyDailyTotal"
      (account_id, day, reference, target_host, requester, grant_id, calls,
       status_breakdown, total_bytes, first_at, last_at)
    VALUES ($1, $2::date, $3, $4, $5, $6, 1,
            jsonb_build_object($7::text, 1), $8::bigint, $9, $9)
    ON CONFLICT (account_id, day, reference, target_host, requester, grant_id)
    DO UPDATE SET
      calls = "VaultProxyDailyTotal".calls + 1,
      status_breakdown = jsonb_set(
        "VaultProxyDailyTotal".status_breakdown,
        ARRAY[$7::text],
        to_jsonb(COALESCE(("VaultProxyDailyTotal".status_breakdown ->> $7::text)::int, 0) + 1),
        true),
      total_bytes = "VaultProxyDailyTotal".total_bytes + EXCLUDED.total_bytes,
      first_at = LEAST("VaultProxyDailyTotal".first_at, EXCLUDED.first_at),
      last_at = GREATEST("VaultProxyDailyTotal".last_at, EXCLUDED.last_at)
  `,
    call.account_id,
    call.at.toISOString().slice(0, 10),
    call.reference,
    call.target_host,
    call.requester,
    call.grant_id,
    String(call.status),
    call.bytes,
    call.at,
  );
}
