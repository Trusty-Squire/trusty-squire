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
const tagline = "Trusty Squire signs up / in to websites for you so you don’t have to.";

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
  it("puts the wedge, trust boundary, and verified Clerk prompt after the tagline", async () => {
    const readme = await fs.readFile(canonicalReadme, "utf8");
    const lines = readme
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const taglineAt = lines.findIndex((line) => line.includes(tagline));

    expect(taglineAt).toBeGreaterThanOrEqual(0);
    expect(lines[taglineAt + 1]).toContain("stall at the signup wall or bot detection");
    expect(lines[taglineAt + 2]).toMatch(/^Trusty Squire is an MCP server/);
    expect(lines[taglineAt + 2]).toContain("encrypted, write-only vault");
    expect(lines.slice(taglineAt + 3, taglineAt + 7)).toEqual([
      "## One prompt",
      "```text",
      "Use Trusty Squire to create a Clerk account for this app, save the generated secret key, allow api.clerk.com for server-side requests, and wire it in without putting the raw key in chat, code, or .env.",
      "```",
    ]);
    expect(readme).not.toContain("Sign in to Sentry");
    expect(readme).not.toContain("Resend");
    expect(readme).not.toContain("/provider/path");
  });
});
