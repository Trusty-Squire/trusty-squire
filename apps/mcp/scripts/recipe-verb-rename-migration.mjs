#!/usr/bin/env node
// One-time verb-rename migration for stored operator recipes.
//
// The recipe-key redesign consolidates verbs: reserve→book and
// renew|upgrade|downgrade→subscribe. Stored recipe JSON files under
// ~/.trusty-squire/operator-recipes/*.json filed under a legacy verb need a
// one-time rename so they resolve under the canonical verb going forward.
//
// For each file whose verb ∈ {reserve, renew, upgrade, downgrade} this script:
//   • rewrites the `verb` field to its canonical form
//     (reserve→book; renew|upgrade|downgrade→subscribe);
//   • renames the file to `${canonical}--${domain}[--${action_path}].json`
//     (same `--`-joined, lowercased stem the runtime uses; any existing
//     action_path segment is preserved).
//
// Collision safety (the point — see the recipe-key redesign plan, Q#2):
//   • If the canonical target file already exists, the more-recently-modified
//     (mtime) file is kept at the canonical path and the loser is moved to
//     `<canonical>.superseded-<timestamp>` — **never deleted**.
//   • One log line is emitted per collision: domain, both source verbs, and
//     which one won.
//
// The 2-entry canonical map is inlined here on purpose: this PR stays
// decoupled from the sibling recipe-key-redesign-impl PR, so the two can land
// in either order. It is a one-time throwaway script; do not import the map
// from the recipe-schema package.
//
// Idempotent and safe to re-run: after the first pass no file carries a legacy
// verb, and `.superseded-*` files are not `*.json` so they are never rescanned.
//
// Usage (default dir honors TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR like the runtime):
//   node apps/mcp/scripts/recipe-verb-rename-migration.mjs               # live
//   node apps/mcp/scripts/recipe-verb-rename-migration.mjs --dry-run     # report only
//   TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR=/some/dir node <script>            # target a dir
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ── Inlined 2-entry canonical map (see file header for why it is inline) ──
export const CANONICAL_VERB = Object.freeze({
  reserve: "book",
  renew: "subscribe",
  upgrade: "subscribe",
  downgrade: "subscribe",
});

function canonicalVerb(verb) {
  return Object.hasOwn(CANONICAL_VERB, verb) ? CANONICAL_VERB[verb] : null;
}

function safeFileName(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) return "recipe";
  if (slug.length <= 80) return slug;
  const digest = createHash("sha256").update(slug).digest("hex").slice(0, 16);
  return `${slug.slice(0, 63)}-${digest}`;
}

function skipJsonWhitespace(raw, index) {
  while (index < raw.length && /[ \t\r\n]/.test(raw[index])) index += 1;
  return index;
}

function scanJsonString(raw, start) {
  let index = start + 1;
  while (index < raw.length) {
    if (raw[index] === "\\") {
      index += 2;
      continue;
    }
    if (raw[index] === '"') return index + 1;
    index += 1;
  }
  throw new SyntaxError("Unterminated JSON string");
}

function scanJsonValue(raw, start) {
  if (raw[start] === '"') return scanJsonString(raw, start);
  if (raw[start] !== "{" && raw[start] !== "[") {
    let index = start;
    while (index < raw.length && !/[,\]} \t\r\n]/.test(raw[index])) index += 1;
    return index;
  }

  const closers = [];
  let index = start;
  while (index < raw.length) {
    const token = raw[index];
    if (token === '"') {
      index = scanJsonString(raw, index);
      continue;
    }
    if (token === "{") closers.push("}");
    else if (token === "[") closers.push("]");
    else if (token === "}" || token === "]") {
      if (closers.pop() !== token) throw new SyntaxError("Mismatched JSON delimiter");
      if (closers.length === 0) return index + 1;
    }
    index += 1;
  }
  throw new SyntaxError("Unterminated JSON value");
}

function rewriteTopLevelVerb(raw, canonical) {
  let index = skipJsonWhitespace(raw, 0);
  if (raw[index] !== "{") throw new SyntaxError("Recipe JSON must be an object");
  index += 1;
  let verbValue = null;

  for (;;) {
    index = skipJsonWhitespace(raw, index);
    if (raw[index] === "}") break;
    const keyStart = index;
    const keyEnd = scanJsonString(raw, keyStart);
    const key = JSON.parse(raw.slice(keyStart, keyEnd));
    index = skipJsonWhitespace(raw, keyEnd);
    if (raw[index] !== ":") throw new SyntaxError("Invalid JSON object property");
    index = skipJsonWhitespace(raw, index + 1);
    const valueStart = index;
    const valueEnd = scanJsonValue(raw, valueStart);
    if (key === "verb") verbValue = { start: valueStart, end: valueEnd };
    index = skipJsonWhitespace(raw, valueEnd);
    if (raw[index] === ",") {
      index += 1;
      continue;
    }
    if (raw[index] === "}") break;
    throw new SyntaxError("Invalid JSON object separator");
  }

  if (!verbValue) throw new SyntaxError("Recipe JSON has no top-level verb");
  return `${raw.slice(0, verbValue.start)}${JSON.stringify(canonical)}${raw.slice(verbValue.end)}`;
}

/** Where the runtime keeps recipes — mirrors operatorRecipeDir(). */
export function operatorRecipeDir() {
  const fromEnv = process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return path.join(os.homedir(), ".trusty-squire", "operator-recipes");
}

/**
 * Migrate legacy-verb recipe files inside `dir`.
 *
 * @param {object} opts
 * @param {string} [opts.dir]             directory to scan; defaults to operatorRecipeDir()
 * @param {boolean} [opts.dryRun]         report what would happen without writing
 * @param {string} [opts.timestampBase]   injectable timestamp for `.superseded-<ts>`
 *                                        names (test seam; defaults to Date.now())
 * @param {(line: string) => void} [opts.log]  log sink; defaults to console.log
 * @returns {Promise<{renamed: Array<object>, superseded: Array<object>, log: string[]}>}
 */
export async function migrateRecipeVerbs({
  dir = operatorRecipeDir(),
  dryRun = false,
  timestampBase,
  log = (line) => console.log(line),
} = {}) {
  const summary = { renamed: [], superseded: [], log: [] };
  const emit = (line) => {
    summary.log.push(line);
    log(line);
  };

  let files;
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") {
      emit(`⚠ recipe dir not found (${dir}); nothing to migrate.`);
      return summary;
    }
    throw err;
  }

  const snapshots = new Map();
  for (const file of files.filter((entry) => entry.endsWith(".json")).sort()) {
    const filePath = path.join(dir, file);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }

    let raw = null;
    let recipe = null;
    try {
      raw = await fs.readFile(filePath, "utf8");
      recipe = JSON.parse(raw);
    } catch {
      // Keep the snapshot so an unreadable canonical target still collides,
      // but do not consider it a legacy migration source.
    }

    snapshots.set(file, {
      file,
      path: filePath,
      raw,
      recipe,
      verb: recipe?.verb ?? "?",
      domain: recipe?.domain ?? null,
      actionPath: recipe?.action_path ?? null,
      mtimeMs: stat.mtimeMs,
    });
  }

  const groups = new Map();
  for (const snapshot of snapshots.values()) {
    const canonical = canonicalVerb(snapshot.verb);
    if (!canonical) continue;
    const sourceStem = snapshot.file.slice(0, -".json".length);
    const fallbackStem = sourceStem.startsWith(`${snapshot.verb}--`)
      ? `${canonical}${sourceStem.slice(snapshot.verb.length)}`
      : `${canonical}--${sourceStem.replace(/^-+|-+$/g, "")}`;
    const targetStem = snapshot.domain
      ? [canonical, snapshot.domain, snapshot.actionPath].filter(Boolean).join("--")
      : fallbackStem;
    const targetFile = `${safeFileName(targetStem)}.json`;
    const group = groups.get(targetFile) ?? { targetFile, canonical, sources: [] };
    group.sources.push(snapshot);
    groups.set(targetFile, group);
  }

  const reservedNames = new Set(files);
  let collisionSeq = 0;
  let holdingSeq = 0;
  let stagingSeq = 0;
  const timestamp = timestampBase ?? Date.now().toString();
  const nextSupersededPath = (targetPath) => {
    let candidate;
    do {
      const suffix = collisionSeq++ === 0 ? timestamp : `${timestamp}-${collisionSeq}`;
      candidate = `${targetPath}.superseded-${suffix}`;
    } while (reservedNames.has(path.basename(candidate)));
    reservedNames.add(path.basename(candidate));
    return candidate;
  };

  const nextHoldingPath = (sourcePath) => {
    const sourceStem = sourcePath.endsWith(".json") ? sourcePath.slice(0, -5) : sourcePath;
    let candidate;
    do {
      candidate = `${sourceStem}.migration-${timestamp}-${++holdingSeq}.json`;
    } while (reservedNames.has(path.basename(candidate)));
    reservedNames.add(path.basename(candidate));
    return candidate;
  };

  const stageRewrite = async (targetPath, rewritten) => {
    for (;;) {
      const stagingPath = `${targetPath}.migration-write-${timestamp}-${++stagingSeq}`;
      if (reservedNames.has(path.basename(stagingPath))) continue;
      reservedNames.add(path.basename(stagingPath));
      try {
        await fs.writeFile(stagingPath, rewritten, { encoding: "utf8", flag: "wx" });
        return stagingPath;
      } catch (err) {
        if (err.code === "EEXIST") continue;
        await fs.unlink(stagingPath).catch(() => {});
        throw err;
      }
    }
  };

  const publishRewrite = async (plan) => {
    let sourcePath = plan.currentPath;
    if (sourcePath === plan.targetPath) {
      const holdingPath = nextHoldingPath(sourcePath);
      await fs.link(sourcePath, holdingPath);
      await fs.unlink(sourcePath);
      sourcePath = holdingPath;
    }

    const rewritten = rewriteTopLevelVerb(plan.winner.raw, plan.canonical);
    const stagingPath = await stageRewrite(plan.targetPath, rewritten);
    try {
      await fs.link(stagingPath, plan.targetPath);
    } catch (err) {
      await fs.unlink(stagingPath).catch(() => {});
      throw err;
    }
    await fs.unlink(stagingPath);
    await fs.unlink(sourcePath);
  };

  const preserveAsSuperseded = async (sourcePath, targetPath) => {
    for (;;) {
      const loserPath = nextSupersededPath(targetPath);
      if (dryRun) return loserPath;
      try {
        await fs.link(sourcePath, loserPath);
        await fs.unlink(sourcePath);
        return loserPath;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }
    }
  };

  const compareContenders = (a, b) =>
    b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file);

  const recordCollision = ({ loser, winner, loserPath, domain, targetFile }) => {
    summary.superseded.push({
      from: loser.file,
      canonicalFile: targetFile,
      superseded: path.basename(loserPath),
      domain,
      winnerVerb: winner.verb,
    });
    emit(
      `collision ${domain ?? "unknown"}: ${loser.verb} vs ${winner.verb} on ${targetFile} — ` +
        `keeping ${winner.verb} (newer), preserved ${loser.file} as ${path.basename(loserPath)}`,
    );
  };

  const sourcePaths = new Set(
    [...groups.values()].flatMap((group) => group.sources.map((source) => source.path)),
  );
  const plans = [];
  for (const group of [...groups.values()].sort((a, b) =>
    a.targetFile.localeCompare(b.targetFile),
  )) {
    const targetPath = path.join(dir, group.targetFile);
    const contenders = [...group.sources];
    const existingTarget = snapshots.get(group.targetFile);
    if (
      existingTarget &&
      !sourcePaths.has(existingTarget.path) &&
      !contenders.some((entry) => entry.path === existingTarget.path)
    ) {
      contenders.push(existingTarget);
    }
    contenders.sort(compareContenders);
    plans.push({
      ...group,
      targetPath,
      winner: contenders[0],
      losers: contenders.slice(1),
      domain: group.sources[0].domain,
    });
  }

  const pending = plans
    .filter((plan) => canonicalVerb(plan.winner.verb) === plan.canonical)
    .map((plan) => ({ ...plan, currentPath: plan.winner.path }));
  const cycleHolds = [];
  const migrationOrder = [];
  while (pending.length > 0) {
    const index = pending.findIndex(
      (plan) =>
        !pending.some(
          (other) => other !== plan && other.currentPath === plan.targetPath,
        ),
    );
    if (index === -1) {
      const plan = pending[0];
      const holdingPath = nextHoldingPath(plan.winner.path);
      cycleHolds.push({ sourcePath: plan.currentPath, holdingPath });
      plan.currentPath = holdingPath;
      continue;
    }
    migrationOrder.push(pending.splice(index, 1)[0]);
  }

  if (!dryRun) {
    for (const hold of cycleHolds) {
      await fs.link(hold.sourcePath, hold.holdingPath);
      await fs.unlink(hold.sourcePath);
    }
  }

  for (const plan of plans) {
    for (const loser of plan.losers) {
      const loserPath = await preserveAsSuperseded(loser.path, plan.targetPath);
      recordCollision({
        loser,
        winner: plan.winner,
        loserPath,
        domain: plan.domain,
        targetFile: plan.targetFile,
      });
    }
  }

  for (const plan of migrationOrder) {
    if (!dryRun) {
      await publishRewrite(plan);
    }

    summary.renamed.push({
      from: plan.winner.file,
      to: plan.targetFile,
      verb: plan.winner.verb,
      canonical: plan.canonical,
      domain: plan.domain,
    });
    emit(
      `→ ${plan.winner.file} → ${plan.targetFile} ` +
        `(verb ${plan.winner.verb} → ${plan.canonical})`,
    );
  }

  return summary;
}

// ── CLI ────────────────────────────────────────────────────────────────
function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run") || args.includes("--dry");
  const dir = operatorRecipeDir();
  console.log(dryRun ? `[dry-run] scanning ${dir}` : `scanning ${dir}`);
  const summary = await migrateRecipeVerbs({ dir, dryRun });
  const total = summary.renamed.length + summary.superseded.length;
  console.log(
    `${dryRun ? "[dry-run] would migrate" : "migrated"} ${total} file(s) ` +
      `(${summary.renamed.length} renamed, ${summary.superseded.length} collisions superseded)`,
  );
}

if (isMain()) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
