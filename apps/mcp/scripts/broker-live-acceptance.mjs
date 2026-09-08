// The release acceptance arm uses three independent MCP stdio servers and
// an enrolled, isolated real profile. It never seeds cookies or bypasses the
// Google admission gate. Invoke through chrome-devtools-axi run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { processInventory } from "./broker-process-inventory.mjs";
const script = fileURLToPath(import.meta.url);
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function runClient(configPath, index) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const service = config.services[index];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "server"],
    env: process.env,
    stderr: "pipe",
  });
  const client = new Client({ name: `broker-acceptance-${index}`, version: "1" });
  let sessionId;
  try {
    await client.connect(transport);
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: 600000,
      });
      if (result.isError) throw new Error(JSON.stringify(result.content));
      const text = result.content.find((item) => item.type === "text")?.text;
      assert.equal(typeof text, "string");
      return JSON.parse(text);
    };
    const initial = await call("operate_start", {
      service_url: service.url,
      allowed_hosts: service.allowedHosts ?? [],
    });
    assert.equal(
      initial.needs_user,
      undefined,
      "Enrolled test Google identity is required; no admission bypass is permitted",
    );
    sessionId = initial.session_id;
    assert.equal(typeof sessionId, "string");
    process.send({
      event: "ready",
      pid: process.pid,
      mcpPid: transport.pid,
      sessionId,
      broker: initial.broker,
    });
    await new Promise((r) => process.once("message", r));
    const start = Date.now();
    // A service driver can use only MCP calls. Its successful return is not
    // proof: the final live DOM must also carry both configured postconditions.
    const driver = await import(pathToFileURL(resolve(dirname(configPath), service.driver)).href);
    await driver.provision({ call, sessionId, initial });
    const observed = await call("operate_observe", { session_id: sessionId });
    const rendered = observed.dom ?? observed.text ?? "";
    assert.match(
      rendered,
      new RegExp(service.authPattern),
      "Real-service account evidence missing",
    );
    assert.match(
      rendered,
      new RegExp(service.provisionPattern),
      "Provisioning postcondition missing",
    );
    const end = Date.now();
    process.send({
      event: "evidence",
      pid: process.pid,
      mcpPid: transport.pid,
      sessionId,
      start,
      end,
      url: observed.url,
      authenticated: true,
      provisioned: true,
    });
    await new Promise((r) => process.once("message", r));
    const after = await call("operate_observe", { session_id: sessionId });
    assert.equal(
      new URL(after.url).hostname,
      new URL(observed.url).hostname,
      "Cross-tab adoption after sibling teardown",
    );
    assert.match(after.dom ?? after.text ?? "", new RegExp(service.authPattern));
    await call("operate_finish", { session_id: sessionId });
    sessionId = undefined;
  } finally {
    await client.close();
    process.disconnect();
  }
}

async function ownedProcesses(profile) {
  return (await processInventory(profile)).owned;
}

export async function runLiveAcceptance(configPath) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.services?.length, 3, "Exactly three authorized service drivers are required");
  assert.equal(new Set(config.services.map((s) => new URL(s.url).hostname)).size, 3);
  const root = process.cwd();
  const profile = resolve(config.profileDir);
  assert.ok(
    profile.startsWith(root + "/"),
    "This task may use only an explicitly enrolled profile inside its worktree",
  );
  await readFile(join(profile, "Local State"));
  assert.ok(
    config.accountId && config.configHome,
    "Pinned account and isolated session-store path are required",
  );
  const qualification = await import("../dist/bot/broker/qualification.js");
  const runId = await qualification.beginBrokerQualification(profile, config.accountId);
  let qualified = false;
  const lab = resolve(root, ".broker-acceptance", `live-${Date.now()}`);
  await mkdir(lab, { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".t"), { recursive: true, mode: 0o700 });
  const socket = join(root, ".t", `live-${process.pid}.sock`);
  const env = {
    ...process.env,
    HOME: resolve(config.configHome),
    XDG_CONFIG_HOME: resolve(config.configHome),
    TRUSTY_SQUIRE_ACCOUNT_ID: config.accountId,
    TRUSTY_SQUIRE_PROFILE_DIR: profile,
    TRUSTY_SQUIRE_BROKER_SOCKET: socket,
    TRUSTY_SQUIRE_BROKER_QUALIFICATION_RUN_ID: runId,
    TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION: "0",
    TRUSTY_SQUIRE_REAPER_DIR: join(lab, "reapers"),
    TMPDIR: join(root, ".t"),
    BOT_CDP_ENDPOINT: "",
  };
  const baseline = await ownedProcesses(profile);
  assert.deepEqual(baseline, [], "Test identity is already in use");
  const children = [];
  const spawnChild = (args, ipc = true, extraEnv = {}) => {
    const child = spawn(process.execPath, args, {
      env: { ...env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc"] : [])],
    });
    children.push(child);
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.done = new Promise((r, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? r() : reject(new Error(`Child ${child.pid} exited ${code}`)),
      );
    });
    child.done.catch(() => {});
    return child;
  };
  const receive = (child, event) =>
    new Promise((r, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out: ${event}`)), 600000);
      const callback = (message) => {
        if (message.event === event) {
          clearTimeout(timer);
          child.off("message", callback);
          r(message);
        }
      };
      child.on("message", callback);
      child.done.catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  const broker = spawnChild([bin, "broker"], false);
  try {
    // Endpoint existence is readiness to attempt authentication, not success.
    for (let n = 0; n < 100; n++) {
      if ((await readdir(dirname(socket))).includes(socket.split("/").at(-1))) break;
      if (broker.exitCode !== null) await broker.done;
      await delay(100);
    }
    const clients = [0, 1, 2].map((index) =>
      spawnChild([script, "client", resolve(configPath), String(index)], true, {
        TRUSTY_SQUIRE_FORWARDER_CREDENTIAL: randomBytes(32).toString("base64url"),
      }),
    );
    const ready = await Promise.all(clients.map((child) => receive(child, "ready")));
    assert.equal(new Set(ready.map((row) => row.mcpPid)).size, 3);
    assert.equal(new Set(ready.map((row) => row.sessionId)).size, 3);
    assert.equal(new Set(ready.map((row) => row.broker.targetId)).size, 3);
    assert.equal(new Set(ready.map((row) => row.broker.browserEpoch)).size, 1);
    const { chromeRoots } = await processInventory(profile);
    assert.equal(chromeRoots.length, 1);
    const pending = clients.map((child) => receive(child, "evidence"));
    clients.forEach((child) => child.send("go"));
    const rows = await Promise.all(pending);
    assert.ok(Math.max(...rows.map((r) => r.start)) < Math.min(...rows.map((r) => r.end)));
    clients[0].send("finish");
    await clients[0].done;
    clients.slice(1).forEach((child) => child.send("finish"));
    await Promise.all(clients.map((child) => child.done));
    await broker.done;
    for (let n = 0; n < 200 && (await ownedProcesses(profile)).length !== 0; n++) await delay(100);
    const after = await ownedProcesses(profile);
    assert.deepEqual(after, baseline);
    const evidence = {
      kind: "real-service-three-MCP-process-acceptance",
      chromeRoots,
      ready,
      rows,
      baseline,
      after,
    };
    const evidencePath = join(lab, "evidence.json");
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    await qualification.completeBrokerQualification(
      profile,
      config.accountId,
      runId,
      evidencePath,
      config.services.map((service) => new URL(service.url).hostname),
    );
    qualified = true;
    return { evidencePath, ...evidence };
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.allSettled(children.map((child) => child.done));
    if (!qualified) await qualification.abandonBrokerQualification(profile, config.accountId, runId);
  }
}
if (process.argv[2] === "client") await runClient(process.argv[3], Number(process.argv[4]));
