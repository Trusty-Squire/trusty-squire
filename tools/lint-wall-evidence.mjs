// lint-wall-evidence — CI gate so a "wall" can't be asserted without evidence.
//
// Enforces: every service marked `status: needs-manual` (an unservable/wall
// label) must EITHER carry a `last_probed: <YYYY-MM-DD>` field (dated affordance-
// probe evidence) OR be in the grandfather snapshot (pre-existing debt). A NEW
// unservable label with neither FAILS the build. That makes a false wall (e.g.
// "fly.io is github-only") un-mergeable on an unverified say-so — the control
// runs in CI, independent of anyone remembering to check.
//
//   node tools/lint-wall-evidence.mjs            # check (exit 1 on violation)
//   node tools/lint-wall-evidence.mjs --snapshot # (re)write the grandfather file
//
// Dependency-free: parses by entry-block, so it works for both the inline
// `- { slug: x, ..., status: needs-manual }` and block `- slug: x\n ...` shapes.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const FILES = ["tools/discovery-candidates.yaml", "tools/housekeeper-services.yaml"];
const GRANDFATHER = "tools/wall-grandfather.txt";
const STALE_DAYS = 60; // a last_probed older than this is debt (warn), not fresh

// Split a YAML list file into entry blocks (each top-level `- ...` item).
function entries(text) {
  return text
    .split(/\n(?=- )/)
    .map((b) => b.trim())
    .filter((b) => b.startsWith("- "));
}
function slugOf(block) {
  return (/slug:\s*([a-z0-9-]+)/.exec(block) || [])[1] ?? null;
}
function isUnservable(block) {
  return /status:\s*(needs-manual|unservable)/.test(block);
}
function lastProbed(block) {
  const m = /last_probed:\s*(\d{4}-\d{2}-\d{2})/.exec(block);
  return m ? m[1] : null;
}

function collectUnservable() {
  const out = []; // {slug, file, last_probed}
  for (const f of FILES) {
    if (!existsSync(f)) continue;
    for (const b of entries(readFileSync(f, "utf8"))) {
      if (!isUnservable(b)) continue;
      const slug = slugOf(b);
      if (slug) out.push({ slug, file: f, last_probed: lastProbed(b) });
    }
  }
  return out;
}

const unservable = collectUnservable();

if (process.argv.includes("--snapshot")) {
  const slugs = [...new Set(unservable.map((e) => e.slug))].sort();
  writeFileSync(
    GRANDFATHER,
    `# Pre-existing unservable/wall labels grandfathered ${new Date().toISOString().slice(0, 10)}.\n` +
      `# These predate the affordance-probe requirement — re-probe each and add a\n` +
      `# 'last_probed: <date>' field to its entry to clear it from this list.\n` +
      `# A NEW needs-manual label NOT here and without last_probed fails CI.\n` +
      slugs.join("\n") + "\n",
  );
  console.error(`[lint-wall] wrote ${slugs.length} grandfathered slugs → ${GRANDFATHER}`);
  process.exit(0);
}

const grandfather = existsSync(GRANDFATHER)
  ? new Set(readFileSync(GRANDFATHER, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")))
  : new Set();

const today = new Date();
const violations = [];
const debt = [];
for (const e of unservable) {
  if (e.last_probed) {
    const ageDays = (today - new Date(e.last_probed)) / 86_400_000;
    if (ageDays > STALE_DAYS) debt.push(`${e.slug}: last_probed ${e.last_probed} is stale (>${STALE_DAYS}d) — re-probe`);
    continue; // has dated evidence → ok
  }
  if (grandfather.has(e.slug)) {
    debt.push(`${e.slug}: grandfathered (no probe evidence yet) — re-probe to clear`);
    continue;
  }
  violations.push(`${e.slug} (${e.file}): marked needs-manual with NO last_probed and NOT grandfathered — run tools/affordance-probe.mjs ${e.slug} and add last_probed:<date>`);
}

if (debt.length) {
  console.error(`[lint-wall] ${debt.length} grandfathered/stale wall labels (debt, not blocking):`);
  for (const d of debt.slice(0, 8)) console.error(`  - ${d}`);
  if (debt.length > 8) console.error(`  … +${debt.length - 8} more`);
}
if (violations.length) {
  console.error(`\n[lint-wall] ❌ ${violations.length} NEW unservable label(s) without probe evidence:`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error(`\nA wall claim must carry dated affordance-probe evidence. Probe it, or this is not a wall.`);
  process.exit(1);
}
console.error(`[lint-wall] ✅ all ${unservable.length} unservable labels are evidenced or grandfathered`);
