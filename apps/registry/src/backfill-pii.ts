#!/usr/bin/env node
// One-time backfill: re-scrub identity PII from pre-scrub skills' fill steps.
//
// Skills synthesized before the mcp ${IDENTITY} scrub may carry a real name /
// company baked into a fill's `value_template`. It is NOT surfaced by the hint
// renderer (which never renders fill values), but it is PII at rest in a shared
// store. This rewrites any such value to ${IDENTITY}, classified from the
// retained `label_hint` via the same shared helper the synthesizer uses.
//
// Dry-run by default; pass --apply to write. docs/DESIGN-operator-hints.md edge 1.
//
//   pnpm -F @trusty-squire/registry backfill:pii            # dry run
//   pnpm -F @trusty-squire/registry backfill:pii --apply    # write

import { createRegistryPrismaClient } from "./registry-prisma-client.js";
import { parseSkill, isIdentityFieldLabel, type Skill } from "@trusty-squire/skill-schema";

// The lazy-loaded prisma client (createRegistryPrismaClient) is intentionally
// loosely typed to avoid a generated-client dependency at typecheck; mirror the
// store's `row as …` pattern for the two fields we read.
interface SkillRow {
  skill_id: string;
  payload_json: unknown;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const client = createRegistryPrismaClient();
  const rows = (await client.skillRecord.findMany({
    where: { deleted_at: null },
  })) as SkillRow[];

  let scanned = 0;
  let changed = 0;
  const hits: string[] = [];

  for (const row of rows) {
    scanned += 1;
    let skill: Skill;
    try {
      skill = parseSkill(row.payload_json);
    } catch {
      continue; // unparseable against the current schema — skip, don't touch it
    }
    let rowChanged = false;
    const steps = skill.steps.map((s) => {
      if (
        s.kind === "fill" &&
        typeof s.value_template === "string" &&
        !s.value_template.startsWith("${") && // already a param → leave it
        typeof s.label_hint === "string" &&
        isIdentityFieldLabel(s.label_hint)
      ) {
        rowChanged = true;
        return { ...s, value_template: "${IDENTITY}" };
      }
      return s;
    });
    if (rowChanged) {
      changed += 1;
      hits.push(`${skill.service} (${row.skill_id})`);
      if (apply) {
        await client.skillRecord.update({
          where: { skill_id: row.skill_id },
          data: { payload_json: { ...skill, steps } },
        });
      }
    }
  }

  console.log(`[backfill-pii] scanned ${scanned} skills; ${changed} carry identity PII in a fill value:`);
  for (const h of hits) console.log(`  - ${h}`);
  console.log(
    apply
      ? `[backfill-pii] APPLIED — rewrote ${changed} skill(s) to \${IDENTITY}.`
      : `[backfill-pii] DRY RUN — re-run with --apply to write.`,
  );
  await client.$disconnect();
}

main().catch((err: unknown) => {
  console.error("[backfill-pii] failed:", err);
  process.exitCode = 1;
});
