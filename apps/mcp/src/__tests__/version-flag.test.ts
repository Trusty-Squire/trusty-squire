// Tests that --version, -v, -V, and "version" all print the version
// string and exit 0, without running any setup or install flow.

import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";

const pkgRoot = fileURLToPath(new URL("../../", import.meta.url));
const distBin = path.join(pkgRoot, "dist", "bin.js");

beforeAll(() => {
  // Build so the test spawns a fresh compiled dist/bin.js.
  execFileSync("pnpm", ["build"], { cwd: pkgRoot, stdio: "inherit" });
  if (!existsSync(distBin)) throw new Error("build did not produce dist/bin.js");
}, 120_000);

// Skip in the release-pipeline CI to avoid inode exhaustion (same as
// bin-smoke.test.ts).
describe.skipIf(process.env.MCP_SKIP_PACK_SMOKE === "1")("version flags", () => {
  const versionFlags = ["--version", "-v", "-V", "version"];

  versionFlags.forEach((flag) => {
    it(`\`mcp ${flag}\` prints version and exits 0`, () => {
      const result = execFileSync(process.execPath, [distBin, flag], {
        encoding: "utf8",
      });
      expect(result).toBe(`${VERSION}\n`);
    });
  });

  it("version output is parseable as semver", () => {
    const result = execFileSync(process.execPath, [distBin, "--version"], {
      encoding: "utf8",
    }).trim();
    // Semver pattern: X.Y.Z with optional pre-release/build metadata
    expect(result).toMatch(/^\d+\.\d+\.\d+/);
  });
});
