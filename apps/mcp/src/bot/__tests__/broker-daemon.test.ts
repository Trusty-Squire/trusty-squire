import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, lstat, readFile } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { SessionStore } from "../../session.js";
import { BrokerClient } from "../broker/transport.js";
import { brokerEnvironment } from "../broker/discovery.js";
import { DispatchJournal } from "../broker/dispatch-journal.js";
import { forwarderId } from "../broker/lineage.js";
const require = createRequire(import.meta.url);
const sleep = async (ms: number) => await new Promise((r) => setTimeout(r, ms));
const credential = "a".repeat(43);

it("keeps a forwarder's lineage credential out of the detached broker environment", () => {
  expect(
    brokerEnvironment(
      { PATH: "/bin", TRUSTY_SQUIRE_FORWARDER_CREDENTIAL: credential },
      "/tmp/broker.sock",
    ),
  ).toEqual({ PATH: "/bin", TRUSTY_SQUIRE_BROKER_SOCKET: "/tmp/broker.sock" });
});

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
    [require.resolve("tsx/cli"), fileURLToPath(new URL("../../bin.ts", import.meta.url)), "broker"],
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
    [require.resolve("tsx/cli"), fileURLToPath(new URL("../../bin.ts", import.meta.url)), "broker"],
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
