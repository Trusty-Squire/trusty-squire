// Regression: cpSync used to follow .bin/* symlinks and fail with
// ENOENT when the symlink target didn't exist (common in npx caches
// where postinstall scripts haven't run). We now pass verbatimSymlinks
// so the symlink is copied as-is.
//
// Repro shape: a node_modules tree containing a .bin/<x> symlink that
// points at a path that doesn't exist on disk. Default cpSync throws;
// our wrapper must succeed.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyNpxNodeModules } from "../cli.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "ts-copy-npx-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("copyNpxNodeModules", () => {
  it("copies a tree with a broken .bin symlink (the npx bug)", () => {
    // Build the broken source tree:
    //   src/
    //     node_modules/
    //       .bin/yaml         → ../yaml/bin/yaml.js  (target missing)
    //       yaml/package.json (real file, but no bin/ dir)
    const srcRoot = join(workDir, "src", "node_modules");
    mkdirSync(join(srcRoot, ".bin"), { recursive: true });
    mkdirSync(join(srcRoot, "yaml"), { recursive: true });
    writeFileSync(
      join(srcRoot, "yaml", "package.json"),
      JSON.stringify({ name: "yaml", version: "1.0.0" }),
    );
    // Symlink target intentionally does NOT exist — this is the npx
    // cache state that breaks default cpSync.
    symlinkSync("../yaml/bin/yaml.js", join(srcRoot, ".bin", "yaml"));

    // Sanity: default cpSync DOES throw on this — confirms our setup
    // really reproduces the bug.
    const sanityDest = join(workDir, "sanity-dest");
    expect(() =>
      cpSync(srcRoot, sanityDest, { recursive: true, force: true }),
    ).toThrow(/ENOENT/);

    // The fix: our wrapper succeeds despite the broken symlink.
    const dest = join(workDir, "dest");
    expect(() => copyNpxNodeModules(srcRoot, dest)).not.toThrow();

    // Symlink should be preserved as a symlink (not resolved).
    const copiedSymlink = join(dest, ".bin", "yaml");
    expect(existsSync(copiedSymlink) || lstatSync(copiedSymlink).isSymbolicLink()).toBe(true);
    expect(lstatSync(copiedSymlink).isSymbolicLink()).toBe(true);

    // Real files were copied.
    expect(existsSync(join(dest, "yaml", "package.json"))).toBe(true);
  });

  it("copies a normal tree (no symlinks) without regression", () => {
    const src = join(workDir, "src");
    mkdirSync(join(src, "pkg"), { recursive: true });
    writeFileSync(join(src, "pkg", "index.js"), "module.exports = 1;");

    const dest = join(workDir, "dest");
    expect(() => copyNpxNodeModules(src, dest)).not.toThrow();
    expect(existsSync(join(dest, "pkg", "index.js"))).toBe(true);
  });

  it("force-overwrites an existing destination", () => {
    const src = join(workDir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "a.txt"), "new");

    const dest = join(workDir, "dest");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "a.txt"), "old");

    expect(() => copyNpxNodeModules(src, dest)).not.toThrow();
    // Confirms force: true is honored.
  });
});
