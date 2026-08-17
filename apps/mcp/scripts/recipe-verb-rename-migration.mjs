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
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    if (err.code === "ENOENT") {
      emit(`⚠ recipe dir not found (${dir}); nothing to migrate.`);
      return summary;
    }
    throw err;
  }

  // Monotonic per-run counter keeps `.superseded-<ts>` names unique when two
  // different legacy verbs collide onto the same canonical target in one run.
  let collisionSeq = 0;
  const stamp = () => {
    const base = timestampBase ?? Date.now().toString();
    return collisionSeq++ === 0 ? base : `${base}-${collisionSeq}`;
  };

  for (const file of files.sort()) {
    const sourcePath = path.join(dir, file);

    let raw;
    let recipe;
    try {
      raw = await fs.readFile(sourcePath, "utf8");
      recipe = JSON.parse(raw);
    } catch {
      // Unparseable / non-recipe JSON: leave untouched.
      continue;
    }

    const verb = recipe && recipe.verb;
    const canonical = CANONICAL_VERB[verb];
    if (!canonical) continue; // not a legacy verb — untouched

    // Build the canonical filename from the existing `--`-joined stem: swap the
    // leading verb segment for the canonical one, preserving domain and any
    // action_path segments verbatim (already lowercased/sanitized by the runtime).
    const sourceStem = file.slice(0, -".json".length);
    const stem = sourceStem.startsWith(`${verb}--`)
      ? `${canonical}${sourceStem.slice(verb.length)}`
      : `${canonical}--${sourceStem.replace(/^-+|-+$/g, "")}`;
    const targetPath = path.join(dir, `${stem}.json`);

    const domain = recipe.domain ?? null;
    const targetExists = await fs.access(targetPath).then(
      () => true,
      () => false,
    );

    // No collision — rewrite the verb in place and rename to the canonical path.
    if (!targetExists) {
      if (!dryRun) {
        const rewritten = raw.replace(/"verb"\s*:\s*"[^"]*"/, `"verb": "${canonical}"`);
        await fs.rename(sourcePath, targetPath);
        // Rename first so a failure never leaves the verb field canonical but
        // the file unreachable; rewrite after the move is in place.
        if (rewritten !== raw) await fs.writeFile(targetPath, rewritten, "utf8");
      }
      summary.renamed.push({ from: file, to: `${stem}.json`, verb, canonical, domain });
      emit(`→ ${file} → ${stem}.json (verb ${verb} → ${canonical})`);
      continue;
    }

    // Collision: keep the more-recently-modified file at the canonical path,
    // move the loser to `<canonical>.superseded-<ts>` — never delete.
    const [srcStat, tgtStat] = await Promise.all([
      fs.stat(sourcePath),
      fs.stat(targetPath),
    ]);
    const sourceNewer = srcStat.mtimeMs >= tgtStat.mtimeMs;
    const targetVerb = await recipeVerbAt(targetPath);
    const winnerVerb = sourceNewer ? verb : targetVerb;
    const loserPath = `${targetPath}.superseded-${stamp()}`;

    if (!dryRun) {
      if (sourceNewer) {
        // Source (legacy) wins: rewrite verb, move onto canonical path (overwriting
        // the older canonical file), demote the older file to superseded.
        const rewritten = raw.replace(
          /"verb"\s*:\s*"[^"]*"/,
          `"verb": "${canonical}"`,
        );
        await fs.rename(targetPath, loserPath);
        await fs.rename(sourcePath, targetPath);
        if (rewritten !== raw) await fs.writeFile(targetPath, rewritten, "utf8");
      } else {
        // Existing canonical file wins: keep it in place, preserve the loser as-is.
        await fs.rename(sourcePath, loserPath);
      }
    }

    summary.superseded.push({
      from: file,
      canonicalFile: `${stem}.json`,
      superseded: path.basename(loserPath),
      domain,
      winnerVerb,
    });
    emit(
      `collision ${domain ?? "unknown"}: ${verb} vs ${targetVerb} on ${stem}.json — keeping ` +
        `${winnerVerb} (newer), preserved ${sourceNewer ? path.basename(targetPath) : file} as ` +
        `${path.basename(loserPath)}`,
    );
  }

  return summary;
}

// Read the canonical target's verb for a collision "who won" log, without
// letting a read failure abort the whole migration.
async function recipeVerbAt(targetPath) {
  try {
    return JSON.parse(await fs.readFile(targetPath, "utf8")).verb ?? "?";
  } catch {
    return "?";
  }
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
