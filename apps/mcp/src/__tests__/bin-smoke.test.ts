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
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VERSION } from "../version.js";

const pkgRoot = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = path.resolve(pkgRoot, "../..");
const distBin = path.join(pkgRoot, "dist", "bin.js");
const canonicalReadme = path.join(repoRoot, "README.md");
const packageReadme = path.join(pkgRoot, "README.md");
const descriptionTagline =
  "Trusty Squire gives coding agents the ability to provision, ship, and pay — without your keys or card ever leaving the vault.";
const readmeTagline = "Empower agents with auth and payments.";

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
  it("has one owner for test-time dist builds", async () => {
    // Vitest runs files in parallel. A second test file compiling into the
    // same dist/ tree can truncate a module while this file is launching the
    // binary. Keep all compiled-artifact checks under this single build.
    const buildCall = 'execFileSync("pnpm", ' + '["build"]';
    const testFiles = (await fs.readdir(path.join(pkgRoot, "src"), { recursive: true })).filter(
      (file) => file.endsWith(".test.ts"),
    );
    const buildOwners: string[] = [];

    for (const relative of testFiles) {
      const source = await fs.readFile(path.join(pkgRoot, "src", relative), "utf8");
      if (source.includes(buildCall)) buildOwners.push(relative.replaceAll(path.sep, "/"));
    }

    expect(buildOwners).toEqual(["__tests__/bin-smoke.test.ts"]);
  });

  it("declares the executable and plain-language discovery metadata", async () => {
    // npx auto-resolves `npx @trusty-squire/mcp <cmd>` only when the
    // package has a single bin (or one named for the unscoped package).
    // Multiple bins, none matching, was the original install bug.
    const pkg = JSON.parse(await fs.readFile(path.join(pkgRoot, "package.json"), "utf8")) as {
      bin: Record<string, string>;
      description: string;
      homepage: string;
      keywords: string[];
    };
    expect(pkg.bin).toEqual({ mcp: "./dist/bin.js" });
    expect(pkg.description).toBe(descriptionTagline);
    expect(pkg.homepage).toBe("https://trustysquire.ai");
    expect(pkg.keywords).toEqual(
      expect.arrayContaining([
        "mcp",
        "coding-agent",
        "browser-automation",
        "website-signup",
        "website-login",
      ]),
    );

    const rootPkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      description: string;
    };
    const registry = JSON.parse(await fs.readFile(path.join(pkgRoot, "server.json"), "utf8")) as {
      description: string;
    };
    expect(rootPkg.description).toBe(descriptionTagline);
    expect(registry.description).toBe(descriptionTagline);
  });
});

describe("version flags", () => {
  const versionFlags = ["--version", "-v", "-V", "version"];

  versionFlags.forEach((flag) => {
    it(`\`mcp ${flag}\` prints version and exits 0`, () => {
      const result = execFileSync(process.execPath, [distBin, flag], {
        encoding: "utf8",
      });
      expect(result).toBe(`${VERSION}\n`);
    });
  });

  it("prints a semantic version", () => {
    const result = execFileSync(process.execPath, [distBin, "--version"], {
      encoding: "utf8",
    }).trim();
    expect(result).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// `pnpm pack` in CI release runners has exhausted inodes (Issue: pnpm
// writes workspace .pnpm/lock.yaml during pack resolution, and the runner's
// inode limit is hit). The release workflow does its own ground-truth
// verification by downloading the published tarball and grepping inside.
// This in-process pack test stays on for local + ci.yml, where it catches
// real packaging regressions, but is opt-out for the release pipeline.
const skipPack = process.env.MCP_SKIP_PACK_SMOKE === "1";

describe.skipIf(skipPack)("packed tarball", () => {
  it("ships the executable and the canonical README", async () => {
    const packDir = path.join(tmpDir, "pack");
    await fs.mkdir(packDir, { recursive: true });
    execFileSync("pnpm", ["pack", "--pack-destination", packDir], { cwd: pkgRoot });
    expect(existsSync(packageReadme), "postpack removed the generated README").toBe(false);

    const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
    expect(tgz, "pnpm pack produced a .tgz").toBeDefined();
    const tgzPath = path.join(packDir, tgz!);

    const listing = execFileSync("tar", ["-tzf", tgzPath], { encoding: "utf8" });
    expect(listing).toContain("package/dist/bin.js");
    expect(listing).toContain("package/README.md");

    const binContent = execFileSync("tar", ["-xzOf", tgzPath, "package/dist/bin.js"], {
      encoding: "utf8",
    });
    expect(binContent.startsWith("#!/usr/bin/env node")).toBe(true);

    const packedReadme = execFileSync("tar", ["-xzOf", tgzPath, "package/README.md"]);
    const rootReadme = await fs.readFile(canonicalReadme);
    expect(
      packedReadme.equals(rootReadme),
      "packed README matches the root README byte-for-byte",
    ).toBe(true);
    expect(packedReadme.toString("utf8")).toContain(readmeTagline);
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

  it("exits when the MCP client closes stdin", async () => {
    const link = await linkTo("mcp-server-eof-link.js");
    const child = await startMcpServer(link);
    const exited = waitForExit(child);

    child.stdin!.end();

    await expect(exited).resolves.toEqual({ code: 0, signal: null });
  }, 30_000);

  it("gracefully exits on SIGTERM", async () => {
    const link = await linkTo("mcp-server-sigterm-link.js");
    const child = await startMcpServer(link);
    const exited = waitForExit(child);

    child.kill("SIGTERM");

    // A null signal proves our handler performed cleanup and exited, rather
    // than Node terminating the process directly on SIGTERM.
    await expect(exited).resolves.toEqual({ code: 0, signal: null });
  }, 30_000);

  it("self-exits after the idle window when a host abandons it without closing stdio or signaling it", async () => {
    // Reproduces the live-box leak: a host reconnects to a fresh server
    // without ever closing the old child's stdin or sending it a signal, so
    // neither transport.onclose nor the EOF/SIGTERM listeners above ever
    // fire. Nothing here closes stdin or sends a signal — the idle backstop
    // must exit on its own once TRUSTY_SQUIRE_SERVER_IDLE_TIMEOUT_MS elapses
    // with zero active provision sessions.
    const link = await linkTo("mcp-server-idle-link.js");
    const child = spawn(process.execPath, [link, "server"], {
      env: {
        ...process.env,
        HOME: tmpDir,
        XDG_CONFIG_HOME: path.join(tmpDir, "server-idle-config"),
        TRUSTY_SQUIRE_SESSION_FILE: "1",
        TRUSTY_SQUIRE_SERVER_IDLE_TIMEOUT_MS: "200",
        TRUSTY_SQUIRE_SERVER_IDLE_CHECK_INTERVAL_MS: "50",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    await mcpRequest(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "idle-smoke", version: "1" },
      },
    });

    const exited = waitForExit(child);
    // No stdin.end(), no kill() — only the idle timer may end this process.
    await expect(exited).resolves.toEqual({ code: 0, signal: null });
  }, 30_000);

  it("stdio survives every malformed action shape captured in the operator incident", async () => {
    const link = await linkTo("mcp-server-malformed-actions.js");
    const home = path.join(tmpDir, "malformed-actions-home");
    await fs.mkdir(path.join(home, ".config", "trusty-squire"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".config", "trusty-squire", "session.json"),
      JSON.stringify({
        api_base_url: "http://127.0.0.1:1",
        agent_session_token: "test-session-token",
        saved_at: new Date().toISOString(),
      }),
    );

    const replies = await mcpConversation(link, home, [
      // Exact audit shapes: set_value rather than select, type_secret without
      // its sealed slot, and the mutually-exclusive card selectors together.
      {
        name: "operate_act",
        arguments: { session_id: "s1", kind: "set_value", target: "この商品のみ注文", text: "2" },
      },
      {
        name: "operate_act",
        arguments: { session_id: "s1", kind: "type_secret", target: "pv-card-number" },
      },
      {
        name: "operate_pay",
        arguments: {
          item: "Rakuten cart",
          reason: "checkout",
          card_ref: "card_a",
          card_label: "Personal",
        },
      },
      { name: "operate_act", arguments: { session_id: "s1", kind: "click" } },
      // A real post-error request proves the child remains reachable, and its
      // recovery guidance must teach retry-once rather than process killing.
      { name: "operate_observe", arguments: { session_id: "lost-after-restart" } },
      { method: "tools/list", params: {} },
    ]);

    for (const reply of replies.slice(0, 4)) {
      expect(reply.result?.isError).toBe(true);
      const error = JSON.parse(reply.result?.content?.[0]?.text ?? "{}") as {
        error?: { code?: string };
      };
      expect(error.error?.code).toBe("invalid_arguments");
    }
    const unavailable = JSON.parse(replies[4]?.result?.content?.[0]?.text ?? "{}") as {
      error?: { code?: string; message?: string; retry?: { max_attempts?: number } };
    };
    expect(unavailable.error?.code).toBe("server_unavailable");
    expect(unavailable.error?.retry?.max_attempts).toBe(1);
    expect(unavailable.error?.message).toMatch(/retry once/i);
    expect(unavailable.error?.message).toMatch(/never kill or restart/i);
    expect(replies[5]?.result?.tools?.length).toBeGreaterThan(0);
  }, 30_000);

  it("`mcp connect` reaches the setup flow", async () => {
    const link = await linkTo("mcp-connect-link.js");
    // Bogus api-base + sandbox HOME: it fails at the API call, but only
    // after the entrypoint fired and dispatched into connect.
    const out = runSubcommand(link, [
      "connect",
      "--target=claude-code",
      "--api-base=http://127.0.0.1:1",
    ]);
    // rc.6 voice pass — heading is "Trusty Squire" with a separate
    // dim subline "Setting up this machine."
    expect(out).toContain("Setting up this machine");
  }, 30_000);

  it("the server process survives an escaped async error (unhandledRejection backstop)", async () => {
    // Operator crash hardening: an async rejection that escapes a tool
    // handler's try/catch (the uploadFile filechooser race) used to kill the
    // whole server — the host agent saw "MCP server unreachable" and gave up.
    // Prove the guards in the BUILT artifact keep the process alive through
    // both escape classes and that it can still do work afterwards.
    const distServer = path.join(pkgRoot, "dist", "server.js");
    const probe = `
      import { installServerProcessGuards } from ${JSON.stringify(distServer)};
      installServerProcessGuards();
      Promise.reject(new Error("escaped-rejection"));
      setTimeout(() => { throw new Error("escaped-exception"); }, 30);
      setTimeout(() => { console.log("STILL-ALIVE"); process.exit(0); }, 120);
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
      timeout: 25_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("STILL-ALIVE");
    expect(r.stderr).toContain("unhandled rejection (server kept alive): Error: escaped-rejection");
    expect(r.stderr).toContain("uncaught exception (server kept alive): Error: escaped-exception");
  }, 30_000);

  it("`mcp install` is removed", async () => {
    const link = await linkTo("mcp-install-removed-link.js");
    const out = runSubcommand(link, [
      "install",
      "--target=claude-code",
      "--api-base=http://127.0.0.1:1",
    ]);
    expect(out).toMatch(/`install` has been removed/);
  }, 30_000);
});

describe("owner-death process reaping", () => {
  it.skipIf(process.platform !== "linux")(
    "leaves no live process-group members after the owning process is SIGKILLed",
    async () => {
      const caseDir = path.join(tmpDir, "owner-reaper");
      const profileDir = path.join(caseDir, "operator-profile", "user-data");
      const reaperDir = path.join(caseDir, "reapers");
      const groupFile = path.join(caseDir, "group.json");
      const helperGroupFile = path.join(caseDir, "helper-group.json");
      const readyFile = path.join(caseDir, "ready.json");
      const fixture = path.join(caseDir, "owner.mjs");
      const processMarker = "v1:1:owner-reaper-smoke";
      await fs.mkdir(profileDir, { recursive: true });
      const ownerReaperUrl = pathToFileURL(
        path.join(pkgRoot, "dist", "bot", "owner-process-reaper.js"),
      ).href;
      const profileUrl = pathToFileURL(path.join(pkgRoot, "dist", "bot", "profile.js")).href;
      await fs.writeFile(
        fixture,
        `import { spawn } from "node:child_process";\n` +
          `import { writeFileSync } from "node:fs";\n` +
          `import { spawnOwnerTrackedHelper, startOwnerProcessReaper, trackOwnerProcess } from ${JSON.stringify(ownerReaperUrl)};\n` +
          `import { profileProcessIdentity } from ${JSON.stringify(profileUrl)};\n` +
          `const profileDir = ${JSON.stringify(profileDir)};\n` +
          `const groupFile = ${JSON.stringify(groupFile)};\n` +
          `const helperGroupFile = ${JSON.stringify(helperGroupFile)};\n` +
          `const readyFile = ${JSON.stringify(readyFile)};\n` +
          `startOwnerProcessReaper({ rootDir: ${JSON.stringify(reaperDir)} });\n` +
          `const memberCode = ${JSON.stringify(
            `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const helper = spawn("sleep", ["300"], { stdio: "ignore" }); writeFileSync(${JSON.stringify(groupFile)}, JSON.stringify([process.pid, helper.pid])); setInterval(() => {}, 1000);`,
          )};\n` +
          `const leader = spawn(process.execPath, ["-e", memberCode, "--", "--user-data-dir=" + profileDir], { detached: true, stdio: "ignore", env: { ...process.env, TRUSTY_SQUIRE_OPERATOR_BROWSER_MARKER: ${JSON.stringify(processMarker)} } });\n` +
          `leader.unref();\n` +
          `let identity = null;\n` +
          `for (let i = 0; i < 100 && identity === null; i += 1) { identity = profileProcessIdentity(leader.pid, profileDir); if (identity === null) await new Promise((r) => setTimeout(r, 10)); }\n` +
          `if (identity === null) process.exit(3);\n` +
          `identity.process_marker = ${JSON.stringify(processMarker)};\n` +
          `trackOwnerProcess(identity);\n` +
          `const helperCode = ${JSON.stringify(
            `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn("sleep", ["300"], { stdio: "ignore" }); writeFileSync(${JSON.stringify(helperGroupFile)}, JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000);`,
          )};\n` +
          `const sessionHelper = spawnOwnerTrackedHelper(process.execPath, ["-e", helperCode], { stdio: "ignore" });\n` +
          `sessionHelper.unref();\n` +
          `writeFileSync(readyFile, JSON.stringify({ owner: process.pid, leader: leader.pid, helperLeader: sessionHelper.pid }));\n` +
          `setInterval(() => {}, 1000);\n`,
      );

      const owner = spawn(process.execPath, [fixture], {
        env: {
          ...process.env,
          TRUSTY_SQUIRE_REAPER_POLL_MS: "25",
          TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS: "50",
        },
        stdio: "ignore",
      });
      let members: number[] = [];
      let groupLeaders: number[] = [];
      try {
        await waitUntil(
          () => existsSync(readyFile) && existsSync(groupFile) && existsSync(helperGroupFile),
          10_000,
        );
        const browserMembers = JSON.parse(await fs.readFile(groupFile, "utf8")) as number[];
        const helperMembers = JSON.parse(await fs.readFile(helperGroupFile, "utf8")) as number[];
        members = [...browserMembers, ...helperMembers];
        groupLeaders = [browserMembers[0]!, helperMembers[0]!];
        expect(members).toHaveLength(4);
        expect(members.every(processIsRunning)).toBe(true);

        // Prove the persisted pgid + exact launch marker can reap the group
        // even after its original leader is already gone.
        for (const leader of groupLeaders) process.kill(leader, "SIGKILL");
        await waitUntil(() => groupLeaders.every((pid) => !processIsRunning(pid)), 10_000);
        expect(processIsRunning(browserMembers[1]!)).toBe(true);
        expect(processIsRunning(helperMembers[1]!)).toBe(true);

        owner.kill("SIGKILL");
        await waitForExit(owner);
        await waitUntil(() => members.every((pid) => !processIsRunning(pid)), 10_000);

        expect(members.filter(processIsRunning)).toEqual([]);
      } finally {
        owner.kill("SIGKILL");
        for (const pid of groupLeaders) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        }
      }
    },
    30_000,
  );
});

interface InitResponse {
  result?: { serverInfo?: { name?: string } };
}

interface McpResponse {
  id?: number;
  result?: {
    isError?: boolean;
    content?: Array<{ text?: string }>;
    tools?: unknown[];
  };
}

function mcpConversation(
  scriptPath: string,
  home: string,
  requests: Array<
    | { name: string; arguments: Record<string, unknown> }
    | { method: string; params: Record<string, unknown> }
  >,
): Promise<McpResponse[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, "server"], {
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        TRUSTY_SQUIRE_SESSION_FILE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const replies = new Map<number, McpResponse>();
    let buffer = "";
    const expected = requests.length + 1;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`stdio conversation timed out: ${buffer}`));
    }, 20_000);
    const finish = () => {
      if (replies.size !== expected) return;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(requests.map((_request, index) => replies.get(index + 2)!));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const reply = JSON.parse(line) as McpResponse;
        if (typeof reply.id === "number") replies.set(reply.id, reply);
        if (replies.has(1)) finish();
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "stdio-resilience", version: "1" } } })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    );
    for (const [index, request] of requests.entries()) {
      const id = index + 2;
      const method = "name" in request ? "tools/call" : request.method;
      const params =
        "name" in request ? { name: request.name, arguments: request.arguments } : request.params;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    }
  });
}

async function startMcpServer(scriptPath: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [scriptPath, "server"], {
    env: {
      ...process.env,
      HOME: tmpDir,
      XDG_CONFIG_HOME: path.join(tmpDir, "server-shutdown-config"),
      TRUSTY_SQUIRE_SESSION_FILE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await mcpRequest(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "shutdown-smoke", version: "1" },
    },
  });
  return child;
}

function mcpRequest(child: ChildProcess, request: object): Promise<McpResponse> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`MCP request timed out: ${JSON.stringify(request)}`));
    }, 20_000);
    const onData = (data: Buffer) => {
      stdout += data.toString();
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      try {
        resolve(JSON.parse(stdout.slice(0, newline)) as McpResponse);
      } catch (err) {
        reject(err as Error);
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`MCP server exited before responding (code=${code} signal=${signal})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout!.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    child.stdout!.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdin!.write(`${JSON.stringify(request)}\n`);
  });
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("MCP server did not exit within 20 seconds"));
    }, 20_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true before timeout");
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function processIsRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const state = close < 0 ? "?" : stat.slice(close + 2).split(" ")[0];
    return state !== "Z";
  } catch {
    return false;
  }
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
