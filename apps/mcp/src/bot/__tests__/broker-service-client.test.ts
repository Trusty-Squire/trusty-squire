import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { liveUnixSocket } from "../broker/discovery.js";

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bin = join(packageRoot, "dist", "bin.js");
beforeAll(() => execFileSync("pnpm", ["build"], { cwd: packageRoot, stdio: "pipe" }), 120_000);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ts-service-client-"));
  cleanup.push(async () => await rm(root, { recursive: true, force: true }));
  const profile = join(root, ".trusty-squire", "chrome-profile");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  // Scope probing and cleanup must agree that this user manager is unavailable.
  for (const command of ["systemctl", "systemd-run"])
    await writeFile(join(root, command), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, ".config"),
    TRUSTY_SQUIRE_PROFILE_DIR: profile,
    TRUSTY_SQUIRE_BROKER_SOCKET: join(root, "broker.sock"),
    PATH: `${root}:${process.env.PATH}`,
  };
  delete env.INVOCATION_ID;
  delete env.TRUSTY_SQUIRE_BROKER_UNIT;
  return { root, profile, env };
}
async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exit;
}
function processFor(env: NodeJS.ProcessEnv, command: string) {
  const child = spawn(process.execPath, [bin, command], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  cleanup.push(async () => await stop(child));
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return { child, stderr: () => stderr };
}
function peer(child: ChildProcessWithoutNullStreams) {
  const replies = new Map<number, { result?: unknown; error?: { message: string } }>();
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const frame = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (typeof frame.id === "number") replies.set(frame.id, frame);
    }
  });
  const send = (id: number, method: string, params = {}) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  send(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "service-test", version: "1" },
  });
  return { replies, send };
}
async function profileBrokers(profile: string): Promise<number[]> {
  const entries = await readdir("/proc");
  const found = await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry) => {
        const argv = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
        if (!argv.split("\0").includes("broker")) return undefined;
        const env = await readFile(`/proc/${entry}/environ`, "utf8").catch(() => "");
        return env.split("\0").includes(`TRUSTY_SQUIRE_PROFILE_DIR=${profile}`)
          ? Number(entry)
          : undefined;
      }),
  );
  return found.filter((pid): pid is number => pid !== undefined);
}
it.skipIf(process.platform !== "linux")(
  "Reproduction BBC-1: unavailable sockets and a failed manager never create a broker",
  async () => {
    await Promise.all(
      ["absent", "invalid-marker", "stale-socket"].map(async (mode) => {
        const f = await fixture();
        if (mode === "invalid-marker")
          await writeFile(
            join(f.root, ".trusty-squire", ".trusty-squire-broker-unit.json"),
            "{ invalid",
            { mode: 0o600 },
          );
        if (mode === "stale-socket") await writeFile(f.env.TRUSTY_SQUIRE_BROKER_SOCKET!, "stale");
        expect(await profileBrokers(f.profile)).toEqual([]);
        const { child, stderr } = processFor(f.env, "server");
        const { replies } = peer(child);
        const start = Date.now();
        const samples: number[][] = [];
        const sample = setInterval(() => {
          void profileBrokers(f.profile).then((pids) => samples.push(pids));
        }, 100);
        try {
          const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
          expect(code).toBe(1);
          expect(Date.now() - start).toBeGreaterThanOrEqual(9_000);
          expect(Date.now() - start).toBeLessThan(15_000);
          expect(stderr()).toContain("broker not running");
          expect(replies.get(1)?.error?.message).toContain("broker not running");
          expect(samples.flat()).toEqual([]);
          expect(await profileBrokers(f.profile)).toEqual([]);
          const sockets = execFileSync("ss", ["-xlp"], { encoding: "utf8" })
            .split("\n")
            .filter((line) => line.includes(f.root));
          expect(sockets).toEqual([]);
          process.stdout.write(
            `BBC-1 ${mode}: exit=1; broker not running; broker PIDs=[]; ss listeners=[]\n`,
          );
        } finally {
          clearInterval(sample);
        }
      }),
    );
  },
  20_000,
);
it.skipIf(process.platform !== "linux")(
  "concurrent clients initialize on a foreground broker and reconnect to its replacement",
  async () => {
    const f = await fixture();
    const relays = [processFor(f.env, "server"), processFor(f.env, "server")];
    const peers = relays.map(({ child }) => peer(child));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await profileBrokers(f.profile)).toEqual([]);
    let broker = processFor(f.env, "broker");
    await vi.waitFor(
      async () => expect(await liveUnixSocket(f.env.TRUSTY_SQUIRE_BROKER_SOCKET!)).toBe(true),
      { timeout: 8_000 },
    );
    await vi.waitFor(
      () => peers.forEach(({ replies }) => expect(replies.get(1)?.result).toBeTruthy()),
      { timeout: 8_000 },
    );
    relays.forEach(({ child }) =>
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'),
    );
    expect(await profileBrokers(f.profile)).toEqual([broker.child.pid]);
    const prior = broker.child.pid;
    await stop(broker.child);
    broker = processFor(f.env, "broker");
    await vi.waitFor(
      async () => expect(await liveUnixSocket(f.env.TRUSTY_SQUIRE_BROKER_SOCKET!)).toBe(true),
      { timeout: 8_000 },
    );
    await vi.waitFor(
      async () => {
        peers.forEach(({ send }) => send(2, "tools/list"));
        await new Promise((resolve) => setTimeout(resolve, 100));
        peers.forEach(({ replies }) => expect(replies.get(2)?.result).toBeTruthy());
      },
      { timeout: 8_000 },
    );
    expect(await profileBrokers(f.profile)).toEqual([broker.child.pid]);
    expect(broker.child.pid).not.toBe(prior);
    expect(relays.every(({ child }) => child.exitCode === null)).toBe(true);
    process.stdout.write(
      `BBC-1 restart: two connected clients list tools after replacement; exactly one broker PID=${broker.child.pid}\n`,
    );
  },
  30_000,
);
it("exits promptly when stdin closes during initial service wait", async () => {
  const f = await fixture();
  const { child } = processFor(f.env, "server");
  peer(child);
  const start = Date.now();
  child.stdin.end();
  expect(await new Promise<number | null>((resolve) => child.once("exit", resolve))).toBe(0);
  expect(Date.now() - start).toBeLessThan(3_000);
});
