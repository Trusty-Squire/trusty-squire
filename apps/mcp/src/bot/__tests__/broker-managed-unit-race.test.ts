import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { sharedMcpSocketPath } from "../broker/mcp-socket-path.js";

const STUB = `import { createServer } from "node:net";
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
const path = process.env.STUB_MCP_SOCKET;
if (!path) throw new Error("STUB_MCP_SOCKET is required");
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
try { unlinkSync(path); } catch { /* first bind */ }
const server = createServer((socket) => {
  let buffer = "";
  let identified = false;
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const end = buffer.indexOf("\\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!identified) { identified = true; continue; }
      const frame = JSON.parse(line);
      if (frame.method === "initialize") {
        socket.write(JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "managed-stub", version: "1" },
          },
        }) + "\\n");
      } else if (frame.method === "tools/list") {
        socket.write(JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: { tools: [{ name: "operate_start" }] },
        }) + "\\n");
      }
    }
  });
});
server.listen(path);
`;

type Cleanup = () => Promise<void>;
const cleanup: Cleanup[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function systemdUserAvailable(): boolean {
  const unit = `trusty-squire-broker-probe-${process.pid}-${randomUUID().slice(0, 8)}`;
  const started = spawnSync("systemd-run", [
    "--user", "--quiet", "--collect", "--unit", unit, "/bin/true",
  ], { stdio: "ignore", timeout: 3_000 });
  spawnSync("systemctl", ["--user", "stop", `${unit}.service`], { stdio: "ignore", timeout: 3_000 });
  spawnSync("systemctl", ["--user", "reset-failed", `${unit}.service`], { stdio: "ignore", timeout: 3_000 });
  return started.status === 0;
}

function show(unit: string, property: string): string {
  return execFileSync("systemctl", ["--user", "show", unit, "-p", property, "--value"], {
    encoding: "utf8",
    timeout: 3_000,
  }).trim();
}

function socketPid(path: string): number | null {
  try {
    const output = execFileSync("lsof", ["-a", "-t", "-U", "--", path], { encoding: "utf8" });
    const pid = Number(output.trim().split(/\s+/)[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function killLeakedBrokers(profile: string): void {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      if (!cmdline.includes("broker") || !cmdline.some((arg) => arg.endsWith("bin.js"))) continue;
      const env = readFileSync(`/proc/${entry}/environ`, "utf8");
      if (!env.split("\0").includes(`TRUSTY_SQUIRE_PROFILE_DIR=${profile}`)) continue;
      process.kill(Number(entry), "SIGKILL");
    } catch {
      /* gone or unreadable */
    }
  }
}

it.skipIf(!systemdUserAvailable())(
  "keeps a connected relay on the systemd unit after restart and does not launch a detached broker",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-broker-unit-race-"));
    cleanup.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const profile = join(root, ".trusty-squire", "chrome-profile");
    const privateDir = join(root, ".trusty-squire");
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    const socket = sharedMcpSocketPath(root, profile);
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const stub = join(root, "stub.mjs");
    writeFileSync(stub, STUB);
    const unit = `trusty-squire-broker-race-${process.pid}-${randomUUID().slice(0, 8)}`;
    const started = spawnSync("systemd-run", [
      "--user",
      "--unit", unit,
      "--property=Restart=always",
      "--property=RestartSec=1",
      `--setenv=HOME=${root}`,
      `--setenv=TRUSTY_SQUIRE_PROFILE_DIR=${profile}`,
      `--setenv=STUB_MCP_SOCKET=${socket}`,
      process.execPath,
      stub,
      "broker",
    ], { encoding: "utf8", timeout: 5_000 });
    expect(started.status, started.stderr).toBe(0);
    cleanup.push(async () => {
      spawnSync("systemctl", ["--user", "stop", `${unit}.service`], { stdio: "ignore", timeout: 5_000 });
      spawnSync("systemctl", ["--user", "reset-failed", `${unit}.service`], { stdio: "ignore", timeout: 5_000 });
      killLeakedBrokers(profile);
    });

    await vi.waitFor(() => expect(socketPid(socket)).not.toBeNull());
    const beforePid = Number(show(`${unit}.service`, "MainPID"));
    expect(beforePid).toBeGreaterThan(0);
    expect(socketPid(socket)).toBe(beforePid);

    const bin = fileURLToPath(new URL("../../bin.ts", import.meta.url));
    const relay = spawn(process.execPath, ["--import", "tsx", bin, "relay"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: root,
        TRUSTY_SQUIRE_PROFILE_DIR: profile,
        TRUSTY_SQUIRE_AGENT_IDENTITY: "race-agent",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanup.push(async () => {
      if (relay.exitCode === null) relay.kill("SIGKILL");
    });
    const replies = new Map<number, { result?: unknown; error?: { message: string } }>();
    let output = "";
    relay.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      for (;;) {
        const end = output.indexOf("\n");
        if (end < 0) break;
        const frame = JSON.parse(output.slice(0, end)) as {
          id?: number;
          result?: unknown;
          error?: { message: string };
        };
        output = output.slice(end + 1);
        if (typeof frame.id === "number") replies.set(frame.id, frame);
      }
    });
    const call = async (id: number, method: string, params: Record<string, unknown> = {}) => {
      relay.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      await vi.waitFor(() => expect(replies.has(id)).toBe(true));
      const frame = replies.get(id)!;
      if (frame.error) throw new Error(frame.error.message);
      return frame.result;
    };
    await call(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "race", version: "1" },
    });
    relay.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    expect(await call(2, "tools/list")).toEqual({ tools: [{ name: "operate_start" }] });

    const restart = spawnSync("systemctl", ["--user", "restart", `${unit}.service`], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(restart.status, restart.stderr).toBe(0);

    await vi.waitFor(() => {
      const main = Number(show(`${unit}.service`, "MainPID"));
      expect(main).toBeGreaterThan(0);
      expect(main).not.toBe(beforePid);
      expect(socketPid(socket)).toBe(main);
    });
    expect(await call(3, "tools/list")).toEqual({ tools: [{ name: "operate_start" }] });
    expect(relay.exitCode).toBeNull();

    const restartsAfter = Number(show(`${unit}.service`, "NRestarts"));
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(Number(show(`${unit}.service`, "NRestarts"))).toBe(restartsAfter);
    expect(restartsAfter).toBeLessThan(3);
    killLeakedBrokers(profile);
    expect(Number(show(`${unit}.service`, "MainPID"))).toBe(socketPid(socket));
  },
  20_000,
);
