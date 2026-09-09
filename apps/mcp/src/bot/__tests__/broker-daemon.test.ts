import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, lstat, readFile, readdir } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { SessionStore } from "../../session.js";
import { BrokerClient, listenBroker } from "../broker/transport.js";
import {
  brokerDrainAllowsMethod,
  brokerIdleShutdownEligible,
  brokerIdleTimeoutMs,
  brokerShutdownCleanupComplete,
} from "../broker/daemon.js";
import { brokerEnvironment, brokerIsSupervised } from "../broker/discovery.js";
import { DispatchJournal } from "../broker/dispatch-journal.js";
import { forwarderId } from "../broker/lineage.js";
import { BrokerRefusal } from "../broker/scheduler.js";
const require = createRequire(import.meta.url);
const sleep = async (ms: number) => await new Promise((r) => setTimeout(r, ms));
async function within<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
const credential = "a".repeat(43);
let chromiumAvailable = false;
try {
  chromiumAvailable = existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const itWithChromium = chromiumAvailable && process.platform === "linux" ? it : it.skip;

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

it("keeps a forwarder's lineage credential out of the detached broker environment", () => {
  expect(
    brokerEnvironment(
      { PATH: "/bin", TRUSTY_SQUIRE_FORWARDER_CREDENTIAL: credential },
      "/tmp/broker.sock",
    ),
  ).toEqual({ PATH: "/bin", TRUSTY_SQUIRE_BROKER_SOCKET: "/tmp/broker.sock" });
});

it("uses a minutes-scale idle policy and disables it for supervised brokers", () => {
  expect(brokerIdleTimeoutMs({})).toBe(5 * 60_000);
  expect(brokerIdleTimeoutMs({ TRUSTY_SQUIRE_BROKER_IDLE_TIMEOUT_MS: "1000" })).toBe(60_000);
  expect(brokerIdleTimeoutMs({ TRUSTY_SQUIRE_BROKER_SUPERVISED: "true" })).toBeUndefined();
  expect(
    brokerIdleTimeoutMs({
      TRUSTY_SQUIRE_BROKER_SUPERVISED: "true",
      TRUSTY_SQUIRE_BROKER_IDLE_TIMEOUT_MS: "60000",
    }),
  ).toBeUndefined();
  expect(brokerIsSupervised({ TRUSTY_SQUIRE_BROKER_SUPERVISED: "1" })).toBe(true);
});

it("defers unsupervised idle shutdown until reconnect custody resolves", () => {
  const idle = {
    closing: false,
    draining: false,
    connectedClients: 0,
    idleTimeout: 60_000,
    inventory: { active: 0, quarantined: 0, admitting: 0 },
  };
  expect(brokerIdleShutdownEligible({ ...idle, hasReconnectGrace: false })).toBe(true);
  expect(
    brokerIdleShutdownEligible({
      ...idle,
      hasReconnectGrace: true,
      inventory: { active: 0, quarantined: 1, admitting: 0 },
    }),
  ).toBe(false);
  expect(
    brokerIdleShutdownEligible({
      ...idle,
      hasReconnectGrace: false,
      inventory: { active: 0, quarantined: 1, admitting: 0 },
    }),
  ).toBe(false);
});

it("keeps a draining recovery endpoint reachable while refusing mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-broker-draining-"));
  const socket = join(root, "b.sock");
  const listener = await listenBroker(socket, {
    authenticate: async (token, _agentId, lineageCredential) =>
      token === "token" && lineageCredential === credential
        ? { accountId: "account", agentId: "agent", forwarderId: forwarderId(credential) }
        : null,
    call: async (_principal, method) => {
      if (!brokerDrainAllowsMethod(method))
        throw new BrokerRefusal(
          "broker_draining",
          "Broker is draining; only durable recovery is available",
        );
      if (method === "recover")
        return {
          requestId: "payment-request",
          result: {
            reconciliation: { operation: "operate_pay", status: "payment_outcome_unknown" },
          },
        };
      return {};
    },
    disconnect: async () => undefined,
  });
  let client: BrokerClient | undefined;
  try {
    let runtimeCloseAttempts = 0;
    expect(
      await brokerShutdownCleanupComplete(
        { active: 0, quarantined: 1, admitting: 0 },
        async () => {
          runtimeCloseAttempts += 1;
          return true;
        },
      ),
    ).toBe(false);
    expect(runtimeCloseAttempts).toBe(0);
    client = await BrokerClient.connect(socket, "token", credential);
    await expect(client.call("recover", { name: "operate_pay", args: {} })).resolves.toEqual({
      requestId: "payment-request",
      result: {
        reconciliation: { operation: "operate_pay", status: "payment_outcome_unknown" },
      },
    });
    await expect(
      client.call("tool", { name: "operate_pay", args: {} }),
    ).rejects.toMatchObject({ code: "broker_draining" });
    await expect(lstat(socket)).resolves.toBeDefined();
  } finally {
    await client?.close();
    await listener.close();
    await rm(root, { recursive: true, force: true });
  }
});

itWithChromium("keeps the real daemon endpoint recoverable when real browser cleanup remains unproven", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-broker-drain-process-"));
  const socket = join(root, "b.sock");
  const config = join(root, "config");
  const profile = join(root, "profile");
  const account = {
    account_id: "fixture-account",
    agent_session_token: "before",
    api_base_url: "http://127.0.0.1:1",
    saved_at: new Date().toISOString(),
  };
  const reapers = join(root, "reapers");
  const journal = new DispatchJournal(join(profile, "trusty-squire-broker-dispatch.jsonl"));
  await mkdir(profile);
  await mkdir(join(root, "home"));
  await new SessionStore(join(config, "trusty-squire", "session.json")).write(account);
  const service = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Drain recovery browser</title>");
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  const address = service.address();
  if (address === null || typeof address === "string") throw new Error("test service did not bind");
  const serviceUrl = `http://127.0.0.1:${address.port}/`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      fileURLToPath(new URL("./fixtures/broker-draining-daemon.ts", import.meta.url)),
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
        UNIVERSAL_BOT_CHANNEL: "chrome",
        UNIVERSAL_BOT_CHROME_BINARY: chromium.executablePath(),
        BOT_SELF_LAUNCH: "1",
        BOT_CDP_ENDPOINT: "",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnostic += String(chunk);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  let initial: BrokerClient | undefined;
  let client: BrokerClient | undefined;
  let browserPid: number | undefined;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (
        await lstat(socket).then(
          () => true,
          () => false,
        )
      )
        break;
      if (child.exitCode !== null) throw new Error(diagnostic);
      await sleep(25);
    }
    initial = await BrokerClient.connect(socket, account.agent_session_token, credential);
    const started = (await initial.call("tool", {
      name: "operate_start",
      args: { service_url: serviceUrl },
    })) as { capability?: { sessionId?: string; targetId?: string } };
    const sessionId = started.capability?.sessionId;
    if (typeof sessionId !== "string" || typeof started.capability?.targetId !== "string")
      throw new Error(`real browser session was not created: ${JSON.stringify(started)}`);
    for (let attempt = 0; attempt < 200; attempt++) {
      const launchPid = await readdir(reapers)
        .then(async (entries) =>
          await Promise.all(
            entries.filter((entry) => entry.endsWith(".json")).map(async (entry) => {
              const manifest = JSON.parse(await readFile(join(reapers, entry), "utf8")) as {
                resources?: Array<{ pid?: number; user_data_dir?: string }>;
              };
              return manifest.resources?.find((resource) => resource.user_data_dir === profile)?.pid;
            }),
          ),
        )
        .then((pids) => pids.find((pid): pid is number => Number.isSafeInteger(pid)));
      if (launchPid !== undefined) {
        browserPid = launchPid;
        break;
      }
      await sleep(25);
    }
    if (browserPid === undefined) throw new Error("real broker browser was not registered with its reaper");
    const paymentArgs = { session_id: sessionId, item: "fixture purchase", reason: "drain recovery" };
    await journal.record(sessionId, "stuck-payment", "outcome", {
      forwarderId: forwarderId(credential),
      operation: "operate_pay",
      inputHash: createHmac("sha256", createHash("sha256").update(credential).digest())
        .update(
          `{"args":{"item":"fixture purchase","reason":"drain recovery","session_id":"${sessionId}"},"name":"operate_pay"}`,
        )
        .digest("hex"),
      outcome: { status: "payment_outcome_unknown" },
    });
    process.kill(browserPid, "SIGSTOP");
    await initial.close();
    initial = undefined;
    await sleep(100);
    child.kill("SIGTERM");
    for (let attempt = 0; attempt < 200; attempt++) {
      if (diagnostic.includes("cleanup unproven")) break;
      if (child.exitCode !== null) throw new Error(diagnostic);
      await sleep(25);
    }
    if (!diagnostic.includes("cleanup unproven"))
      throw new Error(`draining broker never reported unproven cleanup: ${diagnostic}`);
    await expect(lstat(socket)).resolves.toBeDefined();
    client = await within(
      BrokerClient.connect(socket, account.agent_session_token, credential),
      5_000,
      "draining broker reconnect",
    );
    await expect(
      within(
        client.call("recover", { name: "operate_pay", args: paymentArgs }),
        5_000,
        "draining broker recovery",
      ),
    ).resolves.toEqual({
      requestId: "stuck-payment",
      result: {
        reconciliation: {
          request_id: "stuck-payment",
          operation: "operate_pay",
          status: "payment_outcome_unknown",
        },
      },
    });
    await expect(
      client.call("tool", { name: "operate_start", args: { service_url: "https://example.test" } }),
    ).rejects.toMatchObject({ code: "broker_draining" });
  } finally {
    await within(initial?.close() ?? Promise.resolve(), 1_000, "initial broker close").catch(
      () => undefined,
    );
    await within(client?.close() ?? Promise.resolve(), 1_000, "recovery broker close").catch(
      () => undefined,
    );
    if (browserPid !== undefined) {
      try {
        process.kill(browserPid, "SIGCONT");
      } catch {
        // The owner reaper may already have proved the stopped process dead.
      }
    }
    if (child.exitCode === null) child.kill("SIGKILL");
    await within(exited, 1_000, "broker daemon exit").catch(() => undefined);
    await closeServer(service);
    let removed = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await rm(root, { recursive: true, force: true });
        removed = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
        await sleep(25);
      }
    }
    if (!removed) throw new Error("broker test fixture remained busy during cleanup");
  }
}, 120000);

it("returns only a durable start outcome after daemon death", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-broker-daemon-recovery-"));
  const socket = join(root, "b.sock");
  const config = join(root, "config");
  const profile = join(root, "profile");
  const account = {
    account_id: "fixture-account",
    agent_session_token: "before",
    api_base_url: "http://127.0.0.1:1",
    saved_at: new Date().toISOString(),
  };
  const args = { service_url: "https://example.test" };
  const journal = new DispatchJournal(join(profile, "trusty-squire-broker-dispatch.jsonl"));
  const lineage = forwarderId(credential);
  const inputHash = createHmac("sha256", createHash("sha256").update(credential).digest())
    .update(
      '{"args":{"service_url":"https://example.test"},"capability":null,"name":"operate_start"}',
    )
    .digest("hex");
  await mkdir(profile);
  await mkdir(join(root, "home"));
  await new SessionStore(join(config, "trusty-squire", "session.json")).write(account);
  await journal.record("lost-session", "old-process-request", "outcome", {
    forwarderId: lineage,
    start: true,
    operation: "operate_start",
    inputHash,
    outcome: { status: "completed" },
  });
  await journal.acknowledge(lineage, "old-process-request");
  const child = spawn(
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
        TRUSTY_SQUIRE_REAPER_DIR: join(root, "reapers"),
        TRUSTY_SQUIRE_BROKER_SOCKET: socket,
        BOT_CDP_ENDPOINT: "",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnostic += String(chunk);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  let sameLineage: BrokerClient | undefined;
  let foreign: BrokerClient | undefined;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (
        await lstat(socket).then(
          () => true,
          () => false,
        )
      )
        break;
      if (child.exitCode !== null) throw new Error(diagnostic);
      await sleep(25);
    }
    sameLineage = await BrokerClient.connect(socket, account.agent_session_token, credential);
    await expect(sameLineage.call("recover", { name: "operate_start", args })).resolves.toEqual({
      requestId: "old-process-request",
      result: {
        reconciliation: {
          request_id: "old-process-request",
          operation: "operate_start",
          status: "completed",
        },
        recovery: {
          status: "session_unavailable",
          next_step:
            "Broker restart ended the session; reconcile this recorded outcome before any new work.",
        },
      },
    });
    foreign = await BrokerClient.connect(socket, account.agent_session_token, "b".repeat(43));
    await expect(foreign.call("recover", { name: "operate_start", args })).resolves.toBeNull();
    await expect(
      sameLineage.call("tool", { name: "operate_start", args }, "fresh-process-request"),
    ).rejects.toThrow("Prior start result awaits caller delivery");
    const records = (await readFile(join(profile, "trusty-squire-broker-dispatch.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { phase: string; inputHash?: string });
    expect(records.some((record) => record.phase === "recovered")).toBe(true);
    expect(records.every((record) => record.inputHash !== "https://example.test")).toBe(true);
  } finally {
    await sameLineage?.close();
    await foreign?.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it("keeps a live control client, coordinates plain maintenance, refreshes credentials, and removes its endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-broker-daemon-"));
  const socket = join(root, "b.sock");
  const config = join(root, "config");
  const store = new SessionStore(join(config, "trusty-squire", "session.json"));
  const account = {
    account_id: "fixture-account",
    agent_session_token: "before",
    api_base_url: "http://127.0.0.1:1",
    saved_at: new Date().toISOString(),
  };
  await store.write(account);
  await mkdir(join(root, "home"));
  const profile = join(root, "profile");
  await mkdir(profile);
  const child = spawn(
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
        TRUSTY_SQUIRE_REAPER_DIR: join(root, "reapers"),
        TRUSTY_SQUIRE_BROKER_SOCKET: socket,
        TRUSTY_SQUIRE_FORWARDER_CREDENTIAL: credential,
        TRUSTY_SQUIRE_BROKER_SUPERVISED: "1",
        BOT_CDP_ENDPOINT: "",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnostic += String(chunk);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  let first: BrokerClient | undefined;
  let replacement: BrokerClient | undefined;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (
        await lstat(socket).then(
          () => true,
          () => false,
        )
      )
        break;
      if (child.exitCode !== null) throw new Error(diagnostic);
      await sleep(25);
    }
    first = await BrokerClient.connect(socket, "before", credential);
    await sleep(1200);
    expect(child.exitCode).toBeNull();
    expect(await first.call("maintenance", {})).toMatchObject({ state: "ready" });
    await store.write({ ...account, agent_session_token: "after" });
    expect(await first.call("resume", {})).toEqual({ state: "resumed" });
    await expect(BrokerClient.connect(socket, "before", credential)).rejects.toThrow(
      "Invalid broker credential",
    );
    await first.close();
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        replacement = await BrokerClient.connect(socket, "after", credential);
        break;
      } catch {
        await sleep(25);
      }
    }
    if (replacement === undefined) throw new Error("replacement broker client did not connect");
    await sleep(1200);
    expect(child.exitCode).toBeNull();
    expect(await replacement.call("maintenance", {})).toMatchObject({ state: "ready" });
    await store.write({ ...account, agent_session_token: "after-disconnect" });
    await replacement.close();
    // Losing the maintenance client must recover the same pinned account and
    // its refreshed credential after the plain browser is proven closed.
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        replacement = await BrokerClient.connect(socket, "after-disconnect", credential);
        break;
      } catch {
        await sleep(25);
      }
    }
    expect(await replacement.call("maintenance", {})).toMatchObject({ state: "ready" });
    await replacement.call("resume", {});
    await replacement.close();
    await sleep(1200);
    expect(child.exitCode).toBeNull();
    child.kill("SIGTERM");
    const result = await Promise.race([exited, sleep(10000).then(() => "timeout")]);
    expect(result, diagnostic).toBe(0);
    expect(
      await lstat(socket).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(
      await lstat(`${socket}.owner.json`).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await first?.close();
    await replacement?.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
