// The broker-only path, proven against a real broker + real Chrome + real MCP
// stdio servers rather than by argument.
//
// Two behaviours, and only two, are the acceptance criteria for making the
// broker the single way anything reaches a browser:
//
//   1. Two sessions run at once: one drives its own page while the other opens
//      its own tab in the SAME physical browser.
//   2. An enrollment completes while a session is already live: the live
//      session keeps driving, the ceremony's tab lands in the same Chrome, and
//      the session's next account-acting call acts as the freshly enrolled
//      account.
//
// Nothing here supplies a broker credential to any process. The only thing the
// clients present is the socket path.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../session.js";
import { brokerElectionRoot, defaultBrokerSocket } from "../bot/broker/discovery.js";
import { BrokerClient } from "../bot/broker/transport.js";
import { profilePathIdentity } from "../bot/profile.js";

const require = createRequire(import.meta.url);
const DIST_BIN = fileURLToPath(new URL("../bin.js", import.meta.url));

const canRun = process.platform === "linux" && existsSync(chromium.executablePath());
const describeReal = canRun ? describe : describe.skip;

const ACCOUNT_ID = "acceptance-account";
const FIRST_TOKEN = "acceptance-token-1";
const SECOND_TOKEN = "acceptance-token-2";

interface RecordedCall {
  method: string;
  url: string;
  authorization: string | undefined;
}

/** A local stand-in for the product API: a few pages to drive and a JSON
 * endpoint that records who asked. It never decides anything about payment. */
async function startApiStub(): Promise<{
  baseUrl: string;
  calls: RecordedCall[];
  close: () => Promise<void>;
}> {
  const calls: RecordedCall[] = [];
  const server: Server = createServer((request, response) => {
    const url = request.url ?? "/";
    calls.push({
      method: request.method ?? "GET",
      url,
      authorization: request.headers.authorization as string | undefined,
    });
    if (url.startsWith("/v1/")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><title>stub ${url}</title><body><h1>stub page ${url}</h1>` +
        `<p>marker ${url.replace(/\W+/g, "-")}</p></body>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no stub port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Processes actually holding this profile (Chrome's own root, never a
 * renderer/GPU child). */
async function chromeRoots(profile: string): Promise<number> {
  const pids = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry));
  const matches = await Promise.all(
    pids.map(async (pid) => {
      const argv = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
      const words = argv.replaceAll("\0", " ").split(" ");
      return (
        words.includes(`--user-data-dir=${profile}`) &&
        !words.some((word) => word.startsWith("--type="))
      );
    }),
  );
  return matches.filter(Boolean).length;
}

interface Stack {
  profile: string;
  socket: string;
  baseUrl: string;
  calls: RecordedCall[];
  /** Publish an enrollment exactly as `connect` completes one. */
  enroll: (token: string) => Promise<void>;
  startServer: () => Promise<Client>;
  /** Launch the daemon the way `connect` does — with the caller's isolated
   * environment — so a test can reach the broker with no enrollment at all. */
  startBroker: () => Promise<void>;
  stop: () => Promise<void>;
}

/** The pid of the elected broker for this profile, when one is resident. */
async function brokerPid(profile: string): Promise<number | null> {
  const root = brokerElectionRoot(profile);
  const names = await readdir(root).catch(() => [] as string[]);
  const lock = names.find((name) => name.endsWith(".lock"));
  if (lock === undefined) return null;
  const raw = await readFile(join(root, lock), "utf8").catch(() => null);
  if (raw === null) return null;
  const owner = JSON.parse(raw) as { pid?: number };
  return typeof owner.pid === "number" ? owner.pid : null;
}

async function waitForBrokerSocket(socket: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = await BrokerClient.connect(socket).catch(() => undefined);
    if (client !== undefined) {
      await client.close();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the broker never answered on its socket");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Terminate the elected broker and wait for it to actually exit, so no Chrome
 * survives this file. The broker's graceful path needs its sessions to be
 * drained; a bounded SIGKILL is the backstop for this file's isolated profile. */
async function stopBroker(profile: string): Promise<void> {
  const pid = await brokerPid(profile);
  if (pid === null) return;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
    const deadline = Date.now() + 10_000;
    while (alive(pid) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (!alive(pid)) return;
  }
}

/** Anything left running out of THIS test's isolated root: the broker's own
 * Xvfb rig is a helper process whose argv carries the root path. Scoped to the
 * root by construction — never a broad sweep. */
async function reapRootProcesses(root: string): Promise<void> {
  const pids = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry));
  for (const pid of pids) {
    const argv = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    if (!argv.includes(root)) continue;
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

async function startStack(
  root: string,
  options: { enrolled: boolean; apiBaseUrl: string; calls: RecordedCall[] },
): Promise<Stack> {
  const profile = join(root, "profile");
  const config = join(root, "config");
  await mkdir(profile, { recursive: true });
  await mkdir(join(root, "home"), { recursive: true });
  const store = new SessionStore(join(config, "trusty-squire", "session.json"));
  const enroll = async (token: string): Promise<void> => {
    await store.write({
      account_id: ACCOUNT_ID,
      agent_session_token: token,
      api_base_url: options.apiBaseUrl,
      saved_at: new Date().toISOString(),
    });
  };
  if (options.enrolled) await enroll(FIRST_TOKEN);

  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !entry[0].startsWith("TRUSTY_SQUIRE_BROKER_") &&
        ![
          "TRUSTY_SQUIRE_ACCOUNT_ID",
          "TRUSTY_SQUIRE_FORWARDER_CREDENTIAL",
          "TRUSTY_SQUIRE_SERVER_LINEAGE",
        ].includes(entry[0]),
    ),
  );
  Object.assign(env, {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: config,
    TMPDIR: root,
    NODE_OPTIONS: `--import ${require.resolve("tsx")}`,
    TRUSTY_SQUIRE_ACCOUNT_ID: ACCOUNT_ID,
    TRUSTY_SQUIRE_PROFILE_DIR: profile,
    TRUSTY_SQUIRE_REAPER_DIR: join(root, "reapers"),
    TRUSTY_SQUIRE_REAPER_POLL_MS: "20",
    TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS: "20",
    UNIVERSAL_BOT_CHANNEL: "chrome",
    UNIVERSAL_BOT_CHROME_BINARY: chromium.executablePath(),
    BOT_CDP_ENDPOINT: "",
  });

  const socket = defaultBrokerSocket(profilePathIdentity(profile));
  let broker: ReturnType<typeof spawn> | undefined;
  const clients: Client[] = [];
  const startServer = async (): Promise<Client> => {
    const client = new Client({ name: "broker-only-path-fixture", version: "1" });
    clients.push(client);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_BIN, "server"],
      env,
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    await client.connect(transport);
    return client;
  };

  const startBroker = async (): Promise<void> => {
    broker ??= spawn(process.execPath, [DIST_BIN, "broker"], {
      detached: true,
      stdio: "ignore",
      env,
    });
    broker.unref();
    await waitForBrokerSocket(socket);
  };

  return {
    profile,
    socket,
    baseUrl: options.apiBaseUrl,
    calls: options.calls,
    enroll,
    startServer,
    startBroker,
    stop: async () => {
      await Promise.all(clients.map(async (client) => await client.close().catch(() => undefined)));
      await stopBroker(profile);
      await rm(dirname(socket), { recursive: true, force: true });
    },
  };
}

/** The operator observation fields this file asserts on. */
interface Observation {
  session_id?: string;
  url?: string;
  broker?: { targetId?: string };
}

function structured(result: unknown): Observation {
  const raw = (result as { structuredContent?: unknown }).structuredContent;
  if (raw === null || typeof raw !== "object")
    throw new Error(`no structured result: ${JSON.stringify(result)}`);
  return raw as Observation;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  return structured(result);
}

describeReal("broker-only path acceptance", () => {
  const roots: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close().catch(() => undefined);
    for (const root of roots.splice(0)) {
      await reapRootProcesses(root);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
        () => undefined,
      );
    }
  });

  async function fixture(enrolled: boolean) {
    const root = await mkdtempRoot();
    const api = await startApiStub();
    const stack = await startStack(root, {
      enrolled,
      apiBaseUrl: api.baseUrl,
      calls: api.calls,
    });
    closers.push(stack.stop, api.close);
    return { stack, api };
  }

  async function mkdtempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "ts-broker-only-"));
    roots.push(root);
    return root;
  }

  it(
    "two sessions at once: one drives its page while the other opens its own tab in the same browser",
    { timeout: 180_000 },
    async () => {
      const { stack } = await fixture(true);
      const first = await stack.startServer();
      const second = await stack.startServer();

      const [startedFirst, startedSecond] = await Promise.all([
        call(first, "operate_start", { service_url: `${stack.baseUrl}/a` }),
        call(second, "operate_start", { service_url: `${stack.baseUrl}/b` }),
      ]);

      expect(startedFirst.session_id).toEqual(expect.any(String));
      expect(startedSecond.session_id).toEqual(expect.any(String));
      expect(startedFirst.session_id).not.toBe(startedSecond.session_id);
      // Distinct tabs in the one browser the broker launched.
      expect(startedFirst.broker?.targetId).not.toBe(startedSecond.broker?.targetId);
      expect(await chromeRoots(stack.profile)).toBe(1);

      // Session one drives its own page; session two keeps its own.
      await call(first, "operate_navigate", {
        session_id: startedFirst.session_id,
        url: `${stack.baseUrl}/a/settings`,
      });
      const [seenFirst, seenSecond] = await Promise.all([
        call(first, "operate_observe", { session_id: startedFirst.session_id, format: "full" }),
        call(second, "operate_observe", { session_id: startedSecond.session_id, format: "full" }),
      ]);
      expect(seenFirst.url).toMatch(/\/a\/settings$/);
      expect(JSON.stringify(seenFirst)).toContain("stub page /a/settings");
      expect(seenSecond.url).toMatch(/\/b$/);
      expect(JSON.stringify(seenSecond)).toContain("stub page /b");
      // Driving one session never touched the other's document.
      expect(JSON.stringify(seenSecond)).not.toContain("/a/settings");

      // Same physical browser throughout: one Chrome, two live sessions.
      expect(await chromeRoots(stack.profile)).toBe(1);
      await Promise.all([
        call(first, "operate_finish", { session_id: startedFirst.session_id }),
        call(second, "operate_finish", { session_id: startedSecond.session_id }),
      ]);
    },
  );

  it("an enrollment completes while a session is already live", { timeout: 180_000 }, async () => {
    const { stack, api } = await fixture(true);
    const server = await stack.startServer();
    const started = await call(server, "operate_start", { service_url: `${stack.baseUrl}/a` });
    const sessionId = started.session_id as string;
    expect(await chromeRoots(stack.profile)).toBe(1);

    // Enrollment completes: `connect` publishes a fresh agent session token
    // for the same account. The session above must survive it untouched.
    await stack.enroll(SECOND_TOKEN);

    // 1. The live session keeps driving on the same browser.
    const afterEnrollment = await call(server, "operate_observe", {
      session_id: sessionId,
      format: "full",
    });
    expect(afterEnrollment.url).toMatch(/\/a$/);
    expect(await chromeRoots(stack.profile)).toBe(1);

    // 2. The ceremony's own broker exchange — connect + a ceremony open —
    //    lands a tab in that same live browser, and connect presents no
    //    credential to do it.
    const ceremonyClient = await BrokerClient.connect(stack.socket);
    try {
      const ceremony = (await ceremonyClient.call("open", {
        serviceUrl: `${stack.baseUrl}/confirm`,
        ceremony: true,
      })) as { sessionId?: string };
      expect(ceremony.sessionId).toEqual(expect.any(String));
      expect(await chromeRoots(stack.profile)).toBe(1);
      await ceremonyClient.call("close", {
        sessionId: ceremony.sessionId,
        args: { session_id: ceremony.sessionId },
      });
    } finally {
      await ceremonyClient.release().catch(() => undefined);
    }

    // 3. The live session's next account-acting call acts as the freshly
    //    enrolled account: the broker names token-2 on the API call, and
    //    never the token it started under.
    await call(server, "inject_card", {
      session_id: sessionId,
      merchant: "Fixture Merchant",
      amount_cents: 100,
      currency: "USD",
      item: "fixture item",
      reason: "broker-only-path acceptance",
      card_ref: "fixture-card",
      fields: {},
    });
    const accountCalls = api.calls.filter((entry) => entry.url.startsWith("/v1/"));
    expect(accountCalls.some((entry) => entry.authorization === `Bearer ${SECOND_TOKEN}`)).toBe(
      true,
    );
    expect(accountCalls.some((entry) => entry.authorization === `Bearer ${FIRST_TOKEN}`)).toBe(
      false,
    );

    // The session is still live and still driving the same browser.
    const stillLive = await call(server, "operate_observe", {
      session_id: sessionId,
      format: "full",
    });
    expect(stillLive.url).toMatch(/\/a$/);
    expect(await chromeRoots(stack.profile)).toBe(1);
    await call(server, "operate_finish", { session_id: sessionId });
  });

  it(
    "an unenrolled machine still reaches the browser: a tab opens with no account anywhere",
    { timeout: 180_000 },
    async () => {
      const { stack } = await fixture(false);
      await stack.startBroker();
      // The socket is the whole credential: nothing else is presented, and no
      // session store entry exists to read a token from.
      const client = await BrokerClient.connect(stack.socket);
      try {
        const opened = (await client.call("open", {
          serviceUrl: `${stack.baseUrl}/first-run`,
        })) as { sessionId?: string };
        expect(opened.sessionId).toEqual(expect.any(String));
        expect(await chromeRoots(stack.profile)).toBe(1);
        await client.call("close", {
          sessionId: opened.sessionId,
          args: { session_id: opened.sessionId },
        });
      } finally {
        await client.release().catch(() => undefined);
      }
    },
  );
});
