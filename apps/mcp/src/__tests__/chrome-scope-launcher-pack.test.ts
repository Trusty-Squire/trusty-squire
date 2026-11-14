import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = fileURLToPath(new URL("../../", import.meta.url));
const restoreScript = path.join(pkgRoot, "scripts", "restore-packed-launcher-mode.mjs");
const skipPack = process.env.MCP_SKIP_PACK_SMOKE === "1";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "ts-launcher-pack-"));
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function packWith(command: "npm" | "pnpm", dest: string): string {
  mkdirSync(dest, { recursive: true });
  execFileSync(command, ["pack", "--pack-destination", dest], { cwd: pkgRoot });
  const tgz = readdirSync(dest).find((name) => name.endsWith(".tgz"));
  if (tgz === undefined) throw new Error(`${command} pack produced no tarball`);
  return path.join(dest, tgz);
}

function launcherListing(tgz: string): string {
  const listing = execFileSync("tar", ["-tvzf", tgz], { encoding: "utf8" });
  const line = listing
    .split("\n")
    .find((entry) => entry.includes("package/assets/chrome-scope-launcher"));
  if (line === undefined) throw new Error("tarball is missing chrome-scope-launcher");
  return line;
}

describe.skipIf(skipPack)("packed chrome-scope-launcher", () => {
  it("npm pack stores the launcher executable", () => {
    const tgz = packWith("npm", path.join(tmpDir, "npm-pack"));
    expect(launcherListing(tgz)).toMatch(/^-rwx/);
  }, 60_000);

  it("restores the exec bit after pnpm pack", () => {
    const tgz = packWith("pnpm", path.join(tmpDir, "pnpm-pack"));
    execFileSync(process.execPath, [restoreScript, tgz]);
    expect(launcherListing(tgz)).toMatch(/^-rwx/);
  }, 60_000);
});
