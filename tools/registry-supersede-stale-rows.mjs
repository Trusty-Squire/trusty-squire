// One-time registry cleanup: collapse stale `demoted` / `pending-review`
// rows to `superseded` for any service that already has a healthy `active`
// row. This is the data-side counterpart to the supersede-on-promote code
// fix (PR: collapse stale demoted/pending rows when a skill goes active) —
// the code fix prevents recurrence, this clears the rows that accumulated
// before it shipped (baseten ×4 demoted, railway ×3, ipinfo ×3 pending, …).
//
// SAFE BY DEFAULT: dry-run unless APPLY=1. Never touches `active`,
// `quarantined`, `superseded`, or soft-deleted rows. Reversible (the rows
// keep their payloads; `superseded_at` is set).
//
// Run ON the registry machine (REGISTRY_DATABASE_URL is on Fly's internal
// network):
//   flyctl ssh sftp shell  → put this file to /tmp, or scp equivalent
//   flyctl ssh console -a trusty-squire-registry \
//     -C "node /tmp/registry-supersede-stale-rows.mjs"        # dry-run
//   flyctl ssh console -a trusty-squire-registry \
//     -C "sh -c 'APPLY=1 node /tmp/registry-supersede-stale-rows.mjs'"

import { createRegistryPrismaClient } from "/app/apps/registry/dist/registry-prisma-client.js";

const STALE = ["demoted", "pending-review"];
const apply = process.env.APPLY === "1";

const client = createRegistryPrismaClient();
await client.$connect();
try {
  // Services that currently have a live active recipe.
  const actives = await client.skillRecord.findMany({
    where: { status: "active", deleted_at: null },
  });
  const activeServices = new Set(actives.map((r) => r.service));

  // Stale rows for those services only.
  const stale = await client.skillRecord.findMany({
    where: { status: { in: STALE }, deleted_at: null },
  });
  const targets = stale.filter((r) => activeServices.has(r.service));

  const byService = {};
  for (const r of targets) (byService[r.service] ??= []).push(r);

  console.log(
    `${apply ? "APPLY" : "DRY-RUN"} — services with an active row: ${activeServices.size}; ` +
      `stale rows to supersede: ${targets.length}`,
  );
  for (const [svc, rows] of Object.entries(byService).sort()) {
    console.log(`\n${svc} (${rows.length}):`);
    for (const r of rows) {
      console.log(`  ${r.skill_id} ${r.status} created=${r.created_at.toISOString().slice(0, 10)}`);
    }
  }

  if (!apply) {
    console.log("\n(dry-run; set APPLY=1 to write)");
  } else if (targets.length > 0) {
    const now = new Date();
    let total = 0;
    for (const svc of Object.keys(byService)) {
      const res = await client.skillRecord.updateMany({
        where: { service: svc, status: { in: STALE }, deleted_at: null },
        data: { status: "superseded", superseded_at: now },
      });
      total += res.count;
    }
    console.log(`\nsuperseded ${total} row(s).`);
  }
} finally {
  await client.$disconnect();
}
