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

  const readSnapshot = async (file) => {
    const filePath = path.join(dir, file);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return null;
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

    return {
      file,
      path: filePath,
      raw,
      verb: recipe?.verb ?? "?",
      domain: recipe?.domain ?? null,
      actionPath: recipe?.action_path ?? null,
      mtimeMs: stat.mtimeMs,
      mode: stat.mode,
    };
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
    const snapshot = await readSnapshot(file);
    if (snapshot) snapshots.set(file, snapshot);
  }

  const groups = new Map();
  for (const snapshot of snapshots.values()) {
    const canonical = CANONICAL_VERB[snapshot.verb];
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

  const stageRewritten = async (snapshot, canonical) => {
    const stageDir = await fs.mkdtemp(path.join(dir, ".recipe-verb-migration-"));
    const stagePath = path.join(stageDir, "recipe");
    const rewritten = snapshot.raw.replace(
      /"verb"\s*:\s*"[^"]*"/,
      `"verb": "${canonical}"`,
    );
    try {
      await fs.writeFile(stagePath, rewritten, {
        encoding: "utf8",
        flag: "wx",
        mode: snapshot.mode,
      });
      const handle = await fs.open(stagePath, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { path: stagePath, dir: stageDir };
    } catch (err) {
      await fs.rm(stageDir, { recursive: true, force: true });
      throw err;
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
    contenders.sort(compareContenders);

    const winner = contenders[0];
    const losers = contenders.slice(1);
    const domain = group.sources[0].domain;
    const stages = [];
    let stagedWinner = null;

    if (!dryRun && CANONICAL_VERB[winner.verb] === group.canonical) {
      stagedWinner = await stageRewritten(winner, group.canonical);
      stages.push(stagedWinner);
    }

    try {
      for (const loser of losers) {
        const loserPath = await preserveAsSuperseded(loser.path, targetPath);
        recordCollision({
          loser,
          winner,
          loserPath,
          domain,
          targetFile: group.targetFile,
        });
      }

      let finalWinner = winner;
      let dynamicCollision = false;

      if (winner.path !== targetPath && !dryRun) {
        for (;;) {
          try {
            await fs.link(stagedWinner.path, targetPath);
            await fs.unlink(winner.path);
            break;
          } catch (err) {
            if (err.code !== "EEXIST") throw err;

            const currentTarget = await readSnapshot(group.targetFile);
            if (!currentTarget) continue;
            dynamicCollision = true;

            if (compareContenders(winner, currentTarget) <= 0) {
              let loserPath;
              try {
                loserPath = await preserveAsSuperseded(currentTarget.path, targetPath);
              } catch (preserveError) {
                if (preserveError.code === "ENOENT") continue;
                throw preserveError;
              }
              recordCollision({
                loser: currentTarget,
                winner,
                loserPath,
                domain,
                targetFile: group.targetFile,
              });
              continue;
            }

            const loserPath = await preserveAsSuperseded(winner.path, targetPath);
            recordCollision({
              loser: winner,
              winner: currentTarget,
              loserPath,
              domain,
              targetFile: group.targetFile,
            });
            finalWinner = currentTarget;
            break;
          }
        }
      } else if (winner.path === targetPath && stagedWinner) {
        await fs.rename(stagedWinner.path, targetPath);
      }

      const finalCanonical = CANONICAL_VERB[finalWinner.verb];
      if (!dryRun && finalWinner !== winner && finalCanonical === group.canonical) {
        const finalStage = await stageRewritten(finalWinner, group.canonical);
        stages.push(finalStage);
        await fs.rename(finalStage.path, targetPath);
      }

      if (finalCanonical === group.canonical) {
        if (
          finalWinner.path === targetPath ||
          (!existingTarget && !dynamicCollision)
        ) {
          summary.renamed.push({
            from: finalWinner.file,
            to: group.targetFile,
            verb: finalWinner.verb,
            canonical: group.canonical,
            domain,
          });
          emit(
            `→ ${finalWinner.file} → ${group.targetFile} ` +
              `(verb ${finalWinner.verb} → ${group.canonical})`,
          );
        }
      }
    } finally {
      await Promise.all(stages.map((stage) => fs.rm(stage.dir, { recursive: true, force: true })));
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
