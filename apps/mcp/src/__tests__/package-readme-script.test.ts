import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const script = path.join(packageRoot, "scripts", "package-readme.mjs");
const canonicalReadme = path.join(repoRoot, "README.md");
const tagline = "Empower agents with auth and payments.";

let tmpDir: string;
let source: string;
let target: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ts-package-readme-"));
  source = path.join(tmpDir, "source.md");
  target = path.join(tmpDir, "target.md");
  await fs.writeFile(source, "canonical README\n");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function run(command: string) {
  return spawnSync(process.execPath, [script, command], {
    env: {
      ...process.env,
      MCP_PACKAGE_README_SOURCE: source,
      MCP_PACKAGE_README_TARGET: target,
    },
    encoding: "utf8",
  });
}

describe("package README lifecycle", () => {
  it("keeps the package-local README generated and untracked", async () => {
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "apps/mcp/README.md"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const packageGitignore = await fs.readFile(path.join(packageRoot, ".gitignore"), "utf8");

    expect(tracked.status).not.toBe(0);
    expect(packageGitignore.split("\n")).toContain("/README.md");
  });

  it("stages the canonical README byte-for-byte", async () => {
    const result = run("stage");

    expect(result.status).toBe(0);
    expect(await fs.readFile(target)).toEqual(await fs.readFile(source));
  });

  it("accepts an identical README left behind by an interrupted pack", async () => {
    await fs.copyFile(source, target);

    expect(run("stage").status).toBe(0);
    expect(await fs.readFile(target, "utf8")).toBe("canonical README\n");
  });

  it("refuses to overwrite a differing package README", async () => {
    await fs.writeFile(target, "authored package README\n");

    const result = run("stage");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to overwrite");
    expect(await fs.readFile(target, "utf8")).toBe("authored package README\n");
  });

  it("treats an already-clean target as success", () => {
    expect(run("clean").status).toBe(0);
  });

  it("removes an identical staged README", async () => {
    await fs.copyFile(source, target);

    expect(run("clean").status).toBe(0);
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to remove a differing package README", async () => {
    await fs.writeFile(target, "authored package README\n");

    const result = run("clean");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to remove");
    expect(await fs.readFile(target, "utf8")).toBe("authored package README\n");
  });

  it("rejects unknown commands with usage guidance", () => {
    const result = run("wat");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: node scripts/package-readme.mjs <stage|clean>");
  });
});

describe("canonical README discovery order", () => {
  it("puts use cases and install directions after the tagline", async () => {
    const readme = await fs.readFile(canonicalReadme, "utf8");
    expect(readme).toContain(tagline);
    expect(readme.match(/^## .+$/gm)).toEqual(["## What you can do", "## Install"]);
    expect(readme).toContain("**Get an API key.**");
    expect(readme).toContain("**Buy things.**");
    expect(readme).toContain("npx @trusty-squire/mcp connect\n");
    expect(readme).toContain("npx @trusty-squire/mcp connect --target=codex\n");
  });
});
