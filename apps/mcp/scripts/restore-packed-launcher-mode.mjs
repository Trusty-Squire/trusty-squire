#!/usr/bin/env node

import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const LAUNCHER = "package/assets/chrome-scope-launcher";
const tarball = process.argv[2];
if (typeof tarball !== "string" || tarball.length === 0) {
  console.error("usage: node scripts/restore-packed-launcher-mode.mjs <tarball.tgz>");
  process.exit(2);
}

const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
if (!listing.split("\n").includes(LAUNCHER)) {
  console.error(`${tarball} is missing ${LAUNCHER}`);
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "ts-restore-launcher-"));
try {
  execFileSync("tar", ["-xzf", tarball, "-C", dir]);
  chmodSync(join(dir, LAUNCHER), 0o755);
  execFileSync("tar", ["-czf", tarball, "-C", dir, "package"]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
