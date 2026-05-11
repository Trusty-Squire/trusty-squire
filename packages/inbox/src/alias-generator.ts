// Alias generator — produces the per-run inbox address.
//
// Format: `${userHandle}.${service}.run-${runIdShort}@mail.trustysquire.ai`
//
// userHandle is the first 8 hex chars of sha256(account_id) — a stable
// non-secret derivative that doesn't directly leak the account ID into
// inbound mail logs at receiving providers. service is sluggified
// (lowercased, non-alnum → "-"). runIdShort is the first 12 chars of
// the ULID — the realistic collision window with the per-account
// dedupe is comfortably wide.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

const DEFAULT_DOMAIN = "mail.trustysquire.ai";
const RUN_ID_SHORT_LEN = 12;
const ACCOUNT_HANDLE_LEN = 8;

export interface AliasGeneratorOptions {
  domain?: string;
}

export function generateAlias(
  accountId: string,
  service: string,
  runId: string,
  options: AliasGeneratorOptions = {},
): string {
  const handle = accountHandle(accountId);
  const slug = serviceSlug(service);
  const runShort = runId.slice(0, RUN_ID_SHORT_LEN).toLowerCase();
  const domain = options.domain ?? DEFAULT_DOMAIN;
  return `${handle}.${slug}.run-${runShort}@${domain}`;
}

export function accountHandle(accountId: string): string {
  return createHash("sha256").update(Buffer.from(accountId, "utf8")).digest("hex").slice(0, ACCOUNT_HANDLE_LEN);
}

export function serviceSlug(service: string): string {
  return service.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
