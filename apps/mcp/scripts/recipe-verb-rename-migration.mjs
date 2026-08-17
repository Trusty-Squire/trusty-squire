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
      verb: recipe?.verb ?? "?",
      domain: recipe?.domain ?? null,
      mtimeMs: stat.mtimeMs,
    });
  }

  const groups = new Map();
  for (const snapshot of snapshots.values()) {
    const canonical = CANONICAL_VERB[snapshot.verb];
    if (!canonical) continue;

    const sourceStem = snapshot.file.slice(0, -".json".length);
    const stem = sourceStem.startsWith(`${snapshot.verb}--`)
      ? `${canonical}${sourceStem.slice(snapshot.verb.length)}`
      : `${canonical}--${sourceStem.replace(/^-+|-+$/g, "")}`;
    const targetFile = `${stem}.json`;
    const group = groups.get(targetFile) ?? { targetFile, canonical, sources: [] };
    group.sources.push(snapshot);
    groups.set(targetFile, group);
  }

  const reservedNames = new Set(files);
  let collisionSeq = 0;
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

  for (const group of [...groups.values()].sort((a, b) =>
    a.targetFile.localeCompare(b.targetFile),
  )) {
    const targetPath = path.join(dir, group.targetFile);
    const existingTarget = snapshots.get(group.targetFile);
    const contenders = [...group.sources];
    if (existingTarget && !contenders.some((entry) => entry.path === existingTarget.path)) {
      contenders.push(existingTarget);
    }
    contenders.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));

    const winner = contenders[0];
    const losers = contenders.slice(1);
    const domain = group.sources[0].domain;

    for (const loser of losers) {
      const loserPath = await preserveAsSuperseded(loser.path, targetPath);
      summary.superseded.push({
        from: loser.file,
        canonicalFile: group.targetFile,
        superseded: path.basename(loserPath),
        domain,
        winnerVerb: winner.verb,
      });
      emit(
        `collision ${domain ?? "unknown"}: ${loser.verb} vs ${winner.verb} on ${group.targetFile} — ` +
          `keeping ${winner.verb} (newer), preserved ${loser.file} as ${path.basename(loserPath)}`,
      );
    }

    if (winner.path !== targetPath) {
      if (!dryRun) {
        const rewritten = winner.raw.replace(
          /"verb"\s*:\s*"[^"]*"/,
          `"verb": "${group.canonical}"`,
        );
        await fs.rename(winner.path, targetPath);
        if (rewritten !== winner.raw) await fs.writeFile(targetPath, rewritten, "utf8");
      }

      if (!existingTarget) {
        summary.renamed.push({
          from: winner.file,
          to: group.targetFile,
          verb: winner.verb,
          canonical: group.canonical,
          domain,
        });
        emit(
          `→ ${winner.file} → ${group.targetFile} (verb ${winner.verb} → ${group.canonical})`,
        );
      }
    }
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
