// Smoke tests that exercise the package the way it is actually launched
// — spawned as a process through a bin symlink — not the way the other
// unit tests import it.
//
// This is the layer every shipping bug in 0.1.0–0.1.3 slipped through:
//   - npx couldn't resolve a bin (multiple bins, none matching the name)
//   - cli.ts's entrypoint guard skipped main() under a bin shim
//   - server.ts had the identical guard bug
// Each was invisible to in-process tests, which import functions
// directly and never spawn the artifact. These tests spawn it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = fileURLToPath(new URL("../../", import.meta.url));
const distBin = path.join(pkgRoot, "dist", "bin.js");

let tmpDir: string;

beforeAll(async () => {
  // Build so the suite is self-contained — it spawns the compiled
  // dist/bin.js, and must reflect current source (the release flow
  // builds first too, so this is just belt-and-suspenders).
  execFileSync("pnpm", ["build"], { cwd: pkgRoot, stdio: "inherit" });
  if (!existsSync(distBin)) throw new Error("build did not produce dist/bin.js");
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ts-mcp-smoke-"));
}, 120_000);

afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("package manifest", () => {
  it("declares exactly one bin, `mcp` -> dist/bin.js", async () => {
    // npx auto-resolves `npx @trusty-squire/mcp <cmd>` only when the
    // package has a single bin (or one named for the unscoped package).
    // Multiple bins, none matching, was the original install bug.
    const pkg = JSON.parse(
      await fs.readFile(path.join(pkgRoot, "package.json"), "utf8"),
    ) as { bin: Record<string, string> };
    expect(pkg.bin).toEqual({ mcp: "./dist/bin.js" });
  });
});

describe("packed tarball", () => {
  it("ships dist/bin.js with a node shebang", async () => {
    const packDir = path.join(tmpDir, "pack");
    await fs.mkdir(packDir, { recursive: true });
    execFileSync("pnpm", ["pack", "--pack-destination", packDir], { cwd: pkgRoot });
    const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
    expect(tgz, "pnpm pack produced a .tgz").toBeDefined();
    const tgzPath = path.join(packDir, tgz!);

    const listing = execFileSync("tar", ["-tzf", tgzPath], { encoding: "utf8" });
    expect(listing).toContain("package/dist/bin.js");

    const binContent = execFileSync("tar", ["-xzOf", tgzPath, "package/dist/bin.js"], {
      encoding: "utf8",
    });
    expect(binContent.startsWith("#!/usr/bin/env node")).toBe(true);
  }, 60_000);
});

describe("launched through a bin symlink", () => {
  // npm/npx install bins as symlinks in node_modules/.bin, so the
  // process sees argv[1] = the symlink path, not the real file. The
  // entrypoint-guard bugs failed exactly on that mismatch; this is the
  // condition that reproduces them.
  async function linkTo(name: string): Promise<string> {
    const link = path.join(tmpDir, name);
    await fs.symlink(distBin, link);
    return link;
  }

  it("`mcp server` completes the MCP initialize handshake", async () => {
    const link = await linkTo("mcp-server-link.js");
    const { response, stderr } = await mcpHandshake(link);
    expect(response.result?.serverInfo?.name).toBe("trusty-squire");
    // The startup breadcrumb (a silent no-op was the worst part of the
    // guard bug — this line makes "did it start?" answerable).
    expect(stderr).toMatch(/\[trusty-squire\] server v\d/);
  }, 30_000);

  it("`mcp install` reaches the setup flow", async () => {
    const link = await linkTo("mcp-install-link.js");
    // Bogus api-base + sandbox HOME: it fails at the API call, but only
    // after the entrypoint fired and dispatched into install.
    const out = runSubcommand(link, [
      "install",
      "--target=claude-code",
      "--api-base=http://127.0.0.1:1",
    ]);
    expect(out).toContain("Setting up Trusty Squire");
  }, 30_000);
});

interface InitResponse {
  result?: { serverInfo?: { name?: string } };
}

// Spawn `node <scriptPath> server`, send an MCP initialize, resolve with
// the parsed first stdout line and the collected stderr.
function mcpHandshake(scriptPath: string): Promise<{ response: InitResponse; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, "server"], {
      env: { ...process.env, HOME: tmpDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`handshake timed out (stdout=${stdout} stderr=${stderr})`));
    }, 20_000);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      const nl = stdout.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        try {
          resolve({ response: JSON.parse(stdout.slice(0, nl)) as InitResponse, stderr });
        } catch (e) {
          reject(e as Error);
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    const init = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "1" },
      },
    });
    child.stdin.write(`${init}\n`);
    // Leave stdin open — closing it (EOF) shuts the stdio transport down
    // before it can reply.
  });
}

function runSubcommand(scriptPath: string, args: string[]): string {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    env: { ...process.env, HOME: tmpDir },
    encoding: "utf8",
    timeout: 25_000,
  });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}
