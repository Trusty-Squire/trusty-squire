// One-time backlog-dedup migration for vault credentials.
//
// Vault v2 made store() an upsert keyed on (account_id, lower(service),
// label): re-storing a service overwrites the existing row. But that
// dedup is application-code only (CredentialVault.store ->
// findActiveByServiceLabel) — it is NOT a DB constraint and never
// retroactively merged rows created before v2. Accounts that accumulated
// multiple active rows for the same service+label before v2 still carry
// duplicates. This migration collapses that backlog.
//
// For each account, ACTIVE rows (deleted_at IS NULL) are grouped by the
// dedup key (account_id, lower(metadata.service), label). Each group with
// more than one row keeps the NEWEST by created_at (matching
// findActiveByServiceLabel's "newest first" ordering) and soft-deletes the
// rest, recording a `vault.credential_collapsed` audit event per removal.
// Rows whose metadata has no usable string `service` are left alone — we
// can't key them safely. Nothing is ever hard-deleted.
//
// DEFAULTS TO A DRY RUN: prints every duplicate group and changes nothing.
// Pass `--apply` to perform the soft-deletes + audit writes.
//
// Runs as compiled JS from the built output:
//   node apps/api/dist/scripts/dedup-credentials.js            # dry run
//   node apps/api/dist/scripts/dedup-credentials.js --apply    # mutate
// AUTH_DATABASE_URL must point at the API auth DB.

import process from "node:process";
import type { CredentialRecord } from "@trusty-squire/vault";
import { VAULT_AUDIT_TYPES } from "@trusty-squire/vault";
import { getApiPrismaClient } from "../services/api-prisma-client.js";
import { PrismaCredentialStore } from "../services/prisma-credential-store.js";
import { PrismaVaultAuditStore } from "../services/prisma-vault-audit-store.js";

// ── Pure decision logic (no DB I/O — unit-tested in isolation) ──────────

// A minimal view of a credential row — only the fields the dedup decision
// reads. Keeping it narrow lets the pure planner be tested without
// constructing full CredentialRecord buffers.
export interface DedupCandidate {
  reference: string;
  account_id: string;
  label: string;
  created_at: Date;
  metadata: Record<string, unknown>;
}

export interface DedupGroup {
  account_id: string;
  // Canonical service name as keyed (lowercased). The display string from
  // the kept row is carried separately for readable output.
  service: string;
  service_display: string;
  label: string;
  // Surviving (newest) reference — never touched.
  kept: string;
  // References that would be / were soft-deleted, newest-first after kept.
  collapsed: string[];
}

// Reads metadata.service as a non-empty string, or null when absent /
// non-string. Mirrors findActiveByServiceLabel: a row with no usable
// service is unkeyable and must be left alone.
function readService(metadata: Record<string, unknown>): string | null {
  const svc = metadata.service;
  return typeof svc === "string" && svc.length > 0 ? svc : null;
}

// Groups one account's active candidates by (lower(service), label) and
// returns only the groups with duplicates. For each, the newest row by
// created_at survives; the rest are marked for collapse. Rows without a
// usable metadata.service are dropped from consideration entirely.
//
// Pure: same input -> same output, no I/O, no clock. The caller supplies
// the rows already filtered to deleted_at IS NULL.
export function planAccountDedup(candidates: DedupCandidate[]): DedupGroup[] {
  const buckets = new Map<string, DedupCandidate[]>();
  for (const c of candidates) {
    const svc = readService(c.metadata);
    if (svc === null) continue; // unkeyable — leave alone
    // Tab separator can't appear in a lowercased service or a label
    // without colliding, but service+label are distinct fields anyway;
    // the account is fixed per call so it isn't part of the key.
    const key = `${svc.toLowerCase()}\t${c.label}`;
    const existing = buckets.get(key);
    if (existing === undefined) buckets.set(key, [c]);
    else existing.push(c);
  }

  const groups: DedupGroup[] = [];
  for (const rows of buckets.values()) {
    if (rows.length < 2) continue; // no duplicates
    // Newest first — matches findActiveByServiceLabel's ordering, so the
    // survivor is exactly the row the app would have returned.
    const sorted = [...rows].sort(
      (a, b) => b.created_at.getTime() - a.created_at.getTime(),
    );
    const [kept, ...rest] = sorted;
    // kept is defined: length >= 2 guarantees at least one element.
    if (kept === undefined) continue;
    const service = readService(kept.metadata);
    if (service === null) continue; // unreachable — kept was keyed
    groups.push({
      account_id: kept.account_id,
      service: service.toLowerCase(),
      service_display: service,
      label: kept.label,
      kept: kept.reference,
      collapsed: rest.map((r) => r.reference),
    });
  }
  // Stable, readable ordering for the report.
  groups.sort((a, b) => {
    if (a.account_id !== b.account_id) return a.account_id < b.account_id ? -1 : 1;
    if (a.service !== b.service) return a.service < b.service ? -1 : 1;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
  return groups;
}

function toCandidate(r: CredentialRecord): DedupCandidate {
  return {
    reference: r.reference,
    account_id: r.account_id,
    label: r.label,
    created_at: r.created_at,
    metadata: r.metadata,
  };
}

// ── Reporting ───────────────────────────────────────────────────────────

interface Totals {
  groupsAffected: number;
  rowsCollapsed: number;
}

function printReport(groups: DedupGroup[], apply: boolean): Totals {
  const mode = apply ? "APPLY" : "DRY-RUN";
  let rowsCollapsed = 0;
  // One greppable line per collapsed reference plus a group header, so a
  // human can eyeball every decision before applying.
  for (const g of groups) {
    console.warn(
      `[dedup][group] account=${g.account_id} service=${g.service_display} ` +
        `label=${g.label} kept=${g.kept} collapse_count=${g.collapsed.length}`,
    );
    for (const ref of g.collapsed) {
      rowsCollapsed += 1;
      const verb = apply ? "collapse" : "would-collapse";
      console.warn(
        `[dedup][${verb}] account=${g.account_id} service=${g.service_display} ` +
          `label=${g.label} ref=${ref} into=${g.kept}`,
      );
    }
  }
  console.warn(
    `[dedup][summary] mode=${mode} groups_affected=${groups.length} ` +
      `rows_collapsed=${rowsCollapsed}`,
  );
  return { groupsAffected: groups.length, rowsCollapsed };
}

// ── DB I/O ──────────────────────────────────────────────────────────────

interface RunResult extends Totals {
  accountsScanned: number;
}

// Loads every account, plans the dedup per account, prints the report, and
// (only when apply=true) soft-deletes the collapsed rows + records audit
// events. The now() clock is injectable so a future test could pin it.
export async function runDedup(
  store: PrismaCredentialStore,
  audit: PrismaVaultAuditStore,
  apply: boolean,
  now: () => Date = () => new Date(),
): Promise<RunResult> {
  const accountIds = await store.listAllAccountIds();
  const allGroups: DedupGroup[] = [];
  for (const accountId of accountIds) {
    const records = await store.listByAccount(accountId);
    const groups = planAccountDedup(records.map(toCandidate));
    allGroups.push(...groups);
  }

  const totals = printReport(allGroups, apply);

  if (apply) {
    const deletedAt = now();
    for (const g of allGroups) {
      for (const ref of g.collapsed) {
        await store.softDelete(ref, deletedAt);
        await audit.record({
          account_id: g.account_id,
          type: VAULT_AUDIT_TYPES.collapsed,
          payload: {
            reference: ref,
            collapsed_into: g.kept,
            requester: "system",
            service: g.service_display,
            label: g.label,
          },
        });
      }
    }
    console.warn(
      `[dedup][applied] soft_deleted=${totals.rowsCollapsed} ` +
        `audit_events=${totals.rowsCollapsed}`,
    );
  } else {
    console.warn(
      "[dedup][dry-run] no changes written. Re-run with --apply to collapse.",
    );
  }

  return { ...totals, accountsScanned: accountIds.length };
}

// Boots a Prisma client against AUTH_DATABASE_URL and runs the dedup. This
// is a pure module — no top-level execution — so tests can import the
// helpers above without opening a DB connection. The unconditional
// entrypoint lives in dedup-credentials.bin.ts (this repo's bin.ts pattern:
// the entry file runs at top level, modules carry no "am I main?" guard).
export async function main(argv: string[]): Promise<void> {
  const apply = argv.includes("--apply");
  const databaseUrl = process.env.AUTH_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    console.error("[dedup] AUTH_DATABASE_URL is not set; refusing to run.");
    process.exit(2);
  }
  const prisma = getApiPrismaClient(databaseUrl);
  const store = new PrismaCredentialStore(prisma);
  const audit = new PrismaVaultAuditStore(prisma);
  const result = await runDedup(store, audit, apply);
  console.warn(
    `[dedup] done. accounts_scanned=${result.accountsScanned} ` +
      `groups_affected=${result.groupsAffected} rows_collapsed=${result.rowsCollapsed}`,
  );
}
