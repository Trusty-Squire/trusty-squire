// better-sqlite3 ships without a native binary (its published "files" list
// omits build/). The install script (prebuild-install || node-gyp rebuild)
// must run. npm's npx cache reuses an already-extracted version without
// re-running that script, so a tree installed with scripts skipped — or
// left incomplete — keeps failing after ignore-scripts is turned back off
// and after @trusty-squire/mcp itself is updated. Detect that load failure
// and rebuild for the running Node ABI before dying.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type BetterSqlite3 = typeof import("better-sqlite3");

export interface SqliteNativeHeal {
  ok: boolean;
  detail: string;
}

const require = createRequire(import.meta.url);

let loaded: BetterSqlite3 | undefined;

export function isSqliteNativeBindingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("Could not locate the bindings file") ||
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("was compiled against a different Node.js") ||
    /better_sqlite3\.node/.test(message)
  );
}

export function sqliteBindingRebuildCommand(pkgDir: string): string {
  return `npm rebuild better-sqlite3 --prefix ${dirname(dirname(pkgDir))}`;
}

export function sqliteBindingFailureMessage(
  err: unknown,
  heal: SqliteNativeHeal,
  pkgDir: string,
): string {
  const cause = err instanceof Error ? err.message : String(err);
  const rebuildLog =
    heal.detail.trim().length > 0 ? `\n\nRebuild output:\n${heal.detail.trim()}` : "";
  return (
    `better-sqlite3 native binding failed for Node ${process.version} ` +
    `(NODE_MODULE_VERSION ${process.versions.modules}) in ${pkgDir}. ` +
    `The published package has no prebuilt .node; npx will not rebuild an ` +
    `already-extracted version. Run: ${sqliteBindingRebuildCommand(pkgDir)}` +
    rebuildLog +
    `\n\n${cause}`
  );
}

/**
 * Try `load`, and if the failure is a missing/stale native binding, heal once
 * and retry. Used by the production loader and the regression test.
 */
export function loadNativeModuleWithHeal<T>(opts: {
  load: () => T;
  isHealable: (err: unknown) => boolean;
  heal: () => SqliteNativeHeal;
  retry: () => T;
  fail: (err: unknown, heal: SqliteNativeHeal) => Error;
}): T {
  try {
    return opts.load();
  } catch (err) {
    if (!opts.isHealable(err)) throw err;
    const heal = opts.heal();
    if (!heal.ok) throw opts.fail(err, heal);
    try {
      return opts.retry();
    } catch (err2) {
      throw opts.fail(err2, heal);
    }
  }
}

function formatSpawn(result: ReturnType<typeof spawnSync>): string {
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const extra =
    result.error !== undefined
      ? result.error.message
      : result.status === 0
        ? ""
        : `exit ${String(result.status)}`;
  return [stdout, stderr, extra].filter((part) => part.length > 0).join("\n");
}

function spawnNodeTool(
  args: string[],
  cwd: string,
  timeoutMs: number,
): ReturnType<typeof spawnSync> {
  const env = { ...process.env };
  delete env.npm_config_ignore_scripts;
  delete env.NPM_CONFIG_IGNORE_SCRIPTS;
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env,
  });
}

export function betterSqlite3PkgDir(): string {
  return dirname(require.resolve("better-sqlite3/package.json"));
}

export function rebuildBetterSqlite3Native(pkgDir: string): SqliteNativeHeal {
  let prebuildBin: string | undefined;
  try {
    prebuildBin = createRequire(join(pkgDir, "package.json")).resolve(
      "prebuild-install/bin.js",
    );
  } catch {
    prebuildBin = undefined;
  }
  const attempts: string[] = [];
  if (prebuildBin !== undefined) {
    const prebuild = spawnNodeTool([prebuildBin], pkgDir, 120_000);
    attempts.push(`prebuild-install:\n${formatSpawn(prebuild)}`);
    if (prebuild.status === 0 && prebuild.error === undefined) {
      return { ok: true, detail: attempts.join("\n") };
    }
  } else {
    attempts.push("prebuild-install is not installed next to better-sqlite3");
  }

  const prefix = dirname(dirname(pkgDir));
  const npmCli = process.env.npm_execpath;
  const npmResult =
    typeof npmCli === "string" && npmCli.length > 0
      ? spawnNodeTool([npmCli, "rebuild", "better-sqlite3", "--prefix", prefix], prefix, 180_000)
      : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", [
          "rebuild",
          "better-sqlite3",
          "--prefix",
          prefix,
        ], {
          cwd: prefix,
          encoding: "utf8",
          timeout: 180_000,
          env: (() => {
            const env = { ...process.env };
            delete env.npm_config_ignore_scripts;
            delete env.NPM_CONFIG_IGNORE_SCRIPTS;
            return env;
          })(),
        });
  attempts.push(`npm rebuild:\n${formatSpawn(npmResult)}`);
  if (npmResult.status === 0 && npmResult.error === undefined) {
    return { ok: true, detail: attempts.join("\n") };
  }
  return { ok: false, detail: attempts.join("\n") };
}

function probe(Database: BetterSqlite3): void {
  const db = new Database(":memory:");
  db.close();
}

function dropBetterSqlite3RequireCache(): void {
  const cache = require.cache;
  if (cache === undefined) return;
  for (const key of Object.keys(cache)) {
    if (key.includes("better-sqlite3") || key.includes("better_sqlite3")) {
      delete cache[key];
    }
  }
}

function requireBetterSqlite3(): BetterSqlite3 {
  const Database: BetterSqlite3 = require("better-sqlite3");
  probe(Database);
  return Database;
}

function noteRebuild(): void {
  process.stderr.write(
    `[trusty-squire] better-sqlite3 native binding missing or built for another Node; ` +
      `rebuilding for ${process.version} (NODE_MODULE_VERSION ${process.versions.modules})…\n`,
  );
}

export function loadBetterSqlite3(): BetterSqlite3 {
  if (loaded !== undefined) return loaded;
  const pkgDir = (): string => {
    try {
      return betterSqlite3PkgDir();
    } catch {
      return "(better-sqlite3 not resolved)";
    }
  };
  loaded = loadNativeModuleWithHeal({
    load: requireBetterSqlite3,
    isHealable: isSqliteNativeBindingError,
    heal: () => {
      noteRebuild();
      return rebuildBetterSqlite3Native(betterSqlite3PkgDir());
    },
    retry: () => {
      dropBetterSqlite3RequireCache();
      return requireBetterSqlite3();
    },
    fail: (err, heal) => new Error(sqliteBindingFailureMessage(err, heal, pkgDir())),
  });
  return loaded;
}

/** Make sure a copied node_modules tree has the native addon before a broker starts. */
export function ensureBetterSqlite3NativeBinding(
  nodeModulesDir: string,
  rebuild: (pkgDir: string) => SqliteNativeHeal = rebuildBetterSqlite3Native,
): void {
  const pkgDir = join(nodeModulesDir, "better-sqlite3");
  if (!existsSync(join(pkgDir, "package.json"))) return;
  if (existsSync(join(pkgDir, "build", "Release", "better_sqlite3.node"))) return;
  noteRebuild();
  const heal = rebuild(pkgDir);
  if (heal.ok && existsSync(join(pkgDir, "build", "Release", "better_sqlite3.node"))) return;
  throw new Error(
    sqliteBindingFailureMessage(
      new Error("Could not locate the bindings file"),
      heal,
      pkgDir,
    ),
  );
}
