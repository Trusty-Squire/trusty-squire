import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../session.js";
import { brokerElectionRoot } from "../broker/discovery.js";
import { ProfileBusyError, acquireProfileOperationGuard } from "../profile.js";

const require = createRequire(import.meta.url);
const credential = "a".repeat(43);
const sleep = async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms));

let chromiumAvailable = false;
try {
  chromiumAvailable = existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}

interface StdioClient {
  initialize(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface EndpointOwner {
  pid: number;
  start_time: string;
  profileDir: string;
}

interface BrowserLaunch {
  marker: string;
  user_data_dir: string;
  anchor?: { pid: number; start_time: string };
}

interface ReaperManifest {
  owner: { pid: number };
  launches: BrowserLaunch[];
}

function stdioClient(child: ChildProcess, diagnostics: () => string): StdioClient {
  let nextId = 1;
  let buffered = "";
  const pending = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  child.stdout?.on("data", (chunk: Buffer) => {
    buffered += String(chunk);
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const message = JSON.parse(line) as { id?: string | number; result?: Record<string, unknown> };
      if (message.id === undefined) continue;
      const reply = pending.get(String(message.id));
      if (reply === undefined) continue;
      pending.delete(String(message.id));
      reply.resolve(message.result ?? {});
    }
  });
  const request = async (method: string, params: Record<string, unknown>) =>
    await new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = String(nextId++);
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out: ${diagnostics()}`));
      }, 30_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    initialize: async () => {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "stdio-restart", version: "1" },
      });
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
      );
    },
    callTool: async (name, args) => {
      const response = await request("tools/call", { name, arguments: args });
      const content = response.content as Array<{ type?: unknown; text?: unknown }> | undefined;
      const text = content?.find((entry) => entry.type === "text")?.text;
      if (response.isError === true || typeof text !== "string")
        throw new Error(`MCP ${name} failed: ${JSON.stringify(response)} ${diagnostics()}`);
      return JSON.parse(text) as Record<string, unknown>;
    },
  };
}

function waitForExit(child: ChildProcess, diagnostics: () => string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal === null) resolve(code);
      else reject(new Error(`process exited signal=${signal}: ${diagnostics()}`));
    });
  });
}

async function processIsGone(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const state = close < 0 ? undefined : stat.slice(close + 2).split(" ")[0];
    return state === "Z" || state === "X";
  } catch {
    return true;
  }
}

async function waitFor<T>(read: () => Promise<T | undefined>, description: string): Promise<T> {
  let failure = "";
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    await sleep(25);
  }
  throw new Error(`${description} did not become available${failure ? `: ${failure}` : ""}`);
}

async function endpointOwner(path: string): Promise<EndpointOwner | undefined> {
  try {
    const owner = JSON.parse(await readFile(`${path}.owner.json`, "utf8")) as EndpointOwner;
    return Number.isSafeInteger(owner.pid) && typeof owner.start_time === "string" ? owner : undefined;
  } catch {
    return undefined;
  }
}

async function browserLaunch(
  root: string,
  brokerPid: number,
  profile: string,
): Promise<{ marker: string; pid: number; startTime: string } | undefined> {
  try {
    for (const entry of await readdir(root)) {
      if (!entry.endsWith(".json")) continue;
      const manifest = JSON.parse(await readFile(join(root, entry), "utf8")) as ReaperManifest;
      if (manifest.owner?.pid !== brokerPid) continue;
      const launch = manifest.launches?.find(
        (candidate) => candidate.user_data_dir === profile && candidate.anchor !== undefined,
      );
      if (launch?.anchor === undefined) continue;
      return {
        marker: launch.marker,
        pid: launch.anchor.pid,
        startTime: launch.anchor.start_time,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const describeChromium = chromiumAvailable && process.platform === "linux" ? describe : describe.skip;

describeChromium("broker-backed MCP stdio restart", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
    );
  });

  it("reclaims one supervised broker and one real browser after an MCP stdio restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-broker-stdio-restart-"));
    roots.push(root);
    const socket = join(root, "broker.sock");
    const config = join(root, "config");
    const profile = join(root, "profile");
    const reapers = join(root, "reapers");
    await Promise.all([mkdir(profile), mkdir(join(root, "home"))]);
    const account = {
      account_id: "fixture-account",
      agent_session_token: "fixture-token",
      api_base_url: "http://127.0.0.1:1",
      saved_at: new Date().toISOString(),
    };
    await new SessionStore(join(config, "trusty-squire", "session.json")).write(account);

    const service = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Retained browser</title><button>Ready</button>");
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    const address = service.address();
    if (address === null || typeof address === "string") throw new Error("test service did not bind");
    const serviceUrl = `http://127.0.0.1:${address.port}/`;

    let brokerDiagnostics = "";
    const broker = spawn(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        fileURLToPath(new URL("../../bin.ts", import.meta.url)),
        "broker",
      ],
      {
        env: {
          ...process.env,
          HOME: join(root, "home"),
          XDG_CONFIG_HOME: config,
          TMPDIR: root,
          TRUSTY_SQUIRE_ACCOUNT_ID: account.account_id,
          TRUSTY_SQUIRE_PROFILE_DIR: profile,
          TRUSTY_SQUIRE_REAPER_DIR: reapers,
          TRUSTY_SQUIRE_BROKER_SOCKET: socket,
          TRUSTY_SQUIRE_BROKER_SUPERVISED: "1",
          TRUSTY_SQUIRE_REAPER_POLL_MS: "20",
          TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS: "20",
          TRUSTY_SQUIRE_AGENT_IDENTITY: "stdio-restart",
          UNIVERSAL_BOT_CHANNEL: "chrome",
          UNIVERSAL_BOT_CHROME_BINARY: chromium.executablePath(),
          BOT_SELF_LAUNCH: "1",
          BOT_CDP_ENDPOINT: "",
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    broker.stderr?.on("data", (chunk) => {
      brokerDiagnostics += String(chunk);
    });
    const brokerExited = waitForExit(broker, () => brokerDiagnostics);
    const children: ChildProcess[] = [];
    const launchServer = () => {
      let diagnostics = "";
      const child = spawn(
        process.execPath,
        [
          "--import",
          require.resolve("tsx"),
          fileURLToPath(new URL("../../bin.ts", import.meta.url)),
          "server",
        ],
        {
          env: {
            ...process.env,
            HOME: join(root, "home"),
            XDG_CONFIG_HOME: config,
            TMPDIR: root,
            TRUSTY_SQUIRE_ACCOUNT_ID: account.account_id,
            TRUSTY_SQUIRE_PROFILE_DIR: profile,
            TRUSTY_SQUIRE_REAPER_DIR: reapers,
            TRUSTY_SQUIRE_BROKER_SOCKET: socket,
            TRUSTY_SQUIRE_BROKER_SUPERVISED: "1",
            TRUSTY_SQUIRE_FORWARDER_CREDENTIAL: credential,
            TRUSTY_SQUIRE_AGENT_IDENTITY: "stdio-restart",
            BOT_CDP_ENDPOINT: "",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      children.push(child);
      child.stderr?.on("data", (chunk) => {
        diagnostics += String(chunk);
      });
      return { child, diagnostics: () => diagnostics };
    };

    try {
      const owner = await waitFor(
        async () => {
          if (broker.exitCode !== null) throw new Error(brokerDiagnostics);
          return await endpointOwner(socket);
        },
        "supervised broker endpoint owner",
      );
      let contender: { release(): void } | undefined;
      try {
        contender = acquireProfileOperationGuard(profile, brokerElectionRoot(profile));
        throw new Error("supervised broker did not retain its canonical profile election");
      } catch (error) {
        expect(error).toBeInstanceOf(ProfileBusyError);
      } finally {
        contender?.release();
      }

      const first = launchServer();
      const firstClient = stdioClient(first.child, first.diagnostics);
      await firstClient.initialize();
      const started = await firstClient.callTool("operate_start", { service_url: serviceUrl });
      expect(started).toMatchObject({ needs_user: { wall: "google_session" } });
      const before = await waitFor(
        async () => await browserLaunch(reapers, owner.pid, profile),
        "real broker browser owner",
      );

      const firstExited = waitForExit(first.child, first.diagnostics);
      first.child.stdin?.end();
      expect(await firstExited).toBe(0);
      await sleep(150);
      expect(broker.exitCode).toBeNull();
      expect(await processIsGone(before.pid)).toBe(false);
      expect(await browserLaunch(reapers, owner.pid, profile)).toEqual(before);

      const second = launchServer();
      const secondClient = stdioClient(second.child, second.diagnostics);
      await secondClient.initialize();
      const resumed = await secondClient.callTool("operate_start", { service_url: serviceUrl });
      expect(resumed).toMatchObject({ needs_user: { wall: "google_session" } });
      const after = await waitFor(
        async () => await browserLaunch(reapers, owner.pid, profile),
        "retained real broker browser owner",
      );
      expect(after).toEqual(before);
      expect(await endpointOwner(socket)).toEqual(owner);
      expect(broker.exitCode).toBeNull();

      process.kill(owner.pid, "SIGKILL");
      await brokerExited.catch(() => undefined);
      await waitFor(
        async () => ((await processIsGone(before.pid)) ? true : undefined),
        "owner-reaper browser cleanup after broker death",
      );
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
      if (broker.exitCode === null) broker.kill("SIGTERM");
      await brokerExited.catch(() => undefined);
      await closeServer(service);
    }
  }, 120_000);
});
