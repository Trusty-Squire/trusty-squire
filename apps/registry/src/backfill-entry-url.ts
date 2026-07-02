#!/usr/bin/env node
// One-time backfill: strip per-account path segments from pre-1.0.23 skills'
// signup_url.
//
// Skills promoted before the mcp entry-url generalization (1.0.23) baked a
// per-account id into signup_url — a project/org/workspace UUID or an
// org-<slug>-<digits> segment (Deepgram /project/<uuid>, Neon
// /app/org-nameless-base-41435035/…, Perplexity /group/<uuid>/settings, …). That
// leaks one user's id into a shared skill and dead-ends a replay on another
// account. This rewrites such a signup_url to the app ORIGIN, which routes to the
// user's own default resource after login — matching stableSignupEntryUrl's
// origin fallback in the synthesizer.
//
// payload_json only: the served hint reads skill.signup_url from payload_json; the
// signup_url column is a phishing-check diagnostic and the deployed client may
// predate it (mirrors backfill-pii.ts, which also updates payload_json only).
//
// Dry-run by default; pass --apply to write.
//
//   pnpm -F @trusty-squire/registry backfill:entry-url            # dry run
//   pnpm -F @trusty-squire/registry backfill:entry-url --apply    # write

import { createRegistryPrismaClient } from "./registry-prisma-client.js";
import { parseSkill, type Skill } from "@trusty-squire/skill-schema";

// Mirrors hasEphemeralPathSegment in apps/mcp/src/bot/promote-to-skill.ts (the
// synthesizer). Replicated because that lives in the mcp package; keep in sync.
function hasEphemeralPathSegment(path: string): boolean {
  return path.split("/").some((seg) => {
    if (seg.length === 0) return false;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true; // uuid
    if (/^[0-9a-f]{24,}$/i.test(seg)) return true; // long hex blob
    if (/^(?:org|team|ws|proj|project|account|acct|workspace|tenant|grp|group)[-_].*\d{4,}/i.test(seg))
      return true; // account-scope slug + digit id
    return false;
  });
}

// The lazy prisma client is loosely typed; mirror the store's `row as …` pattern.
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
    let clean: string;
    try {
      const u = new URL(skill.signup_url);
      if (!hasEphemeralPathSegment(u.pathname)) continue;
      clean = `${u.origin}/`;
    } catch {
      continue; // relative/malformed signup_url — leave it
    }
    if (clean === skill.signup_url) continue;
    changed += 1;
    hits.push(`${skill.service}: ${skill.signup_url} -> ${clean}`);
    if (apply) {
      await client.skillRecord.update({
        where: { skill_id: row.skill_id },
        data: { payload_json: { ...skill, signup_url: clean } },
      });
    }
  }

  console.log(`[backfill-entry-url] scanned ${scanned}; ${changed} carry a per-account entry_url:`);
  for (const h of hits) console.log(`  - ${h}`);
  console.log(
    apply
      ? `[backfill-entry-url] APPLIED — rewrote ${changed} skill(s) to the app origin.`
      : `[backfill-entry-url] DRY RUN — re-run with --apply to write.`,
  );
  await client.$disconnect();
}

main().catch((err: unknown) => {
  console.error("[backfill-entry-url] failed:", err);
  process.exitCode = 1;
});
