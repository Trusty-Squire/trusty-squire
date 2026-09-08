// Run through chrome-devtools-axi run (see docs/browser-broker.md).
// The fixture arm exercises real Chrome and independent OS clients. It does
// NOT substitute for the enrolled Google/real-service qualification arm.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { processInventory } from "./broker-process-inventory.mjs";
const here = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function inventory(profile) {
  return (await processInventory(profile)).owned;
}

async function childMain() {
  const role = process.argv[2];
  const socket = process.env.TRUSTY_SQUIRE_BROKER_SOCKET;
  if (role === "client") {
    const { BrokerClient } = await import("../dist/bot/broker/transport.js");
    const client = await BrokerClient.connect(socket, "fixture-only");
    const site = process.argv[3];
    try {
      const cap = await client.call("open", { site });
      process.send({ event: "ready", pid: process.pid, cap });
      await new Promise((r) => process.once("message", r));
      const evidence = await client.call("provision", { cap });
      process.send({ event: "evidence", pid: process.pid, cap, ...evidence });
      await new Promise((r) => process.once("message", r));
      const after = await client.call("verify", {
        cap,
      });
      assert.match(after.text, /authenticated.*provisioned/s);
      await client.call("finish", { cap });
    } finally {
      await client.close();
    }
    process.disconnect();
  } else if (role === "broker") {
    const { BrokerRuntime } = await import("../dist/bot/broker/runtime.js");
    const { BrokerAuthority } = await import("../dist/bot/broker/authority.js");
    const { listenBroker } = await import("../dist/bot/broker/transport.js");
    const { startHarnessProvisionSession, observe, finishProvisionSession } =
      await import("../dist/bot/provision-session.js");
    const { setSelfManagedChromeTerminationSignalExitEnabled } =
      await import("../dist/bot/browser.js");
    setSelfManagedChromeTerminationSignalExitEnabled(false);
    const runtime = new BrokerRuntime("fixture-account");
    const authority = new BrokerAuthority("fixture-account", "fixture-cell");
    const sites = new Set();
    const listener = await listenBroker(socket, {
      authenticate: async (token) =>
        token === "fixture-only"
          ? { accountId: "fixture-account", agentId: "fixture-agent" }
          : null,
      call: async (principal, method, args, requestId) => {
        if (method === "open") {
          sites.add(args.site);
          return await authority.open(principal, [args.site], async () => {
            const { browser } = await runtime.acquire({
              profileDir: process.env.TRUSTY_SQUIRE_PROFILE_DIR,
            });
            // Harness admission bypasses Google only in this explicit fixture arm.
            const observation = await startHarnessProvisionSession({
              browser,
              serviceUrl: args.site,
              observationFormat: "browser-use-dom",
            });
            await browser.setHostScopeAllowedHosts(() => [new URL(args.site).hostname]);
            await browser.goto(`${args.site}/login`);
            const targetId = await browser.brokerTargetId();
            return {
              targetId,
              invoke: async (name) => {
                const start = Date.now();
                if (name === "provision") await browser.click("button");
                await sleep(1000);
                const actual = await observe(observation.session_id);
                const text = await browser.extractVisibleText();
                assert.equal(new URL(actual.url).origin, args.site);
                assert.match(text, /authenticated.*provisioned/s);
                return {
                  start,
                  end: Date.now(),
                  text,
                  url: actual.url,
                  sessionId: observation.session_id,
                };
              },
              close: async () => {
                await finishProvisionSession(observation.session_id);
                await runtime.release(browser);
                return true;
              },
            };
          });
        }
        if (method === "finish") return await authority.close(principal, args.cap);
        return await authority.invoke(principal, args.cap, requestId, method, {});
      },
      disconnect: async (principal) => await authority.disconnect(principal),
    });
    process.send({ event: "ready", pid: process.pid });
    process.once("message", async () => {
      await listener.close();
      assert.deepEqual(authority.inventory(), { active: 0, quarantined: 0, admitting: 0 });
      assert.equal(await runtime.close(), true);
      const reopened = new BrokerRuntime("fixture-account");
      for (const site of sites) {
        const { browser } = await reopened.acquire({
          profileDir: process.env.TRUSTY_SQUIRE_PROFILE_DIR,
        });
        await browser.goto(`${site}/account`);
        assert.match(await browser.extractVisibleText(), /authenticated.*provisioned/s);
        await reopened.release(browser);
      }
      assert.equal(await reopened.close(), true);
      process.send({ event: "closed" });
      process.disconnect();
      process.exit(0);
    });
  }
}

export async function runFixtureAcceptance(root = process.cwd(), crashFirst = false) {
  const lab = resolve(root, ".broker-acceptance", String(Date.now()));
  await mkdir(join(lab, "home"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".t"), { recursive: true, mode: 0o700 });
  // Linux UDS paths have a short limit. TCP is deliberately not the broker transport.
  const socket = join(root, ".t", `b-${process.pid}.sock`);
  const profile = join(lab, "profile");
  const env = {
    ...process.env,
    HOME: join(lab, "home"),
    XDG_CONFIG_HOME: join(lab, "config"),
    XDG_CACHE_HOME: join(lab, "cache"),
    // Chrome creates a Unix-domain crashpad socket below TMPDIR. A worktree
    // path can exceed Linux's 108-byte socket limit and makes Chrome SIGTRAP
    // before DevTools is available; /tmp keeps this disposable runtime path
    // short while profiles and acceptance artifacts remain inside the worktree.
    TMPDIR: process.platform === "linux" ? "/tmp" : join(root, ".t"),
    TRUSTY_SQUIRE_PROFILE_DIR: profile,
    TRUSTY_SQUIRE_REAPER_DIR: join(lab, "reapers"),
    TRUSTY_SQUIRE_BROKER_SOCKET: socket,
    BOT_CDP_ENDPOINT: "",
    TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION: "0",
  };
  const baseline = await inventory(profile);
  const services = new Map();
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const host = req.headers.host;
    if (req.url === "/login") {
      res.setHeader("Set-Cookie", `fixture_auth=${host}; HttpOnly; Max-Age=86400; Path=/`);
      res.end('<form method="POST" action="/provision"><button>Create service</button></form>');
      return;
    }
    const authenticated = req.headers.cookie?.includes(`fixture_auth=${host}`);
    if (req.url === "/provision" && req.method === "POST" && authenticated)
      services.set(host, true);
    res.end(
      `${authenticated ? "authenticated" : "signed out"} ${services.get(host) ? "provisioned" : "empty"}`,
    );
  });
  await new Promise((r) => server.listen(0, "0.0.0.0", r));
  const port = server.address().port;
  const children = [];
  const launch = (role, args = []) => {
    const child = spawn(process.execPath, [here, role, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.push(child);
    child.stderr.on("data", (data) => process.stderr.write(data));
    child.exited = new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolveExit() : reject(new Error(`${role} exited ${code}`)),
      );
    });
    // Attach rejection immediately; still propagated by later awaits.
    child.exited.catch(() => {});
    return child;
  };
  const message = (child, event) =>
    new Promise((resolveMessage, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 90000);
      const receive = (value) => {
        if (value.event === event) {
          clearTimeout(timer);
          child.off("message", receive);
          resolveMessage(value);
        }
      };
      child.on("message", receive);
      child.exited.catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  const broker = launch("broker");
  let evidence;
  try {
    await message(broker, "ready");
    const clients = [1, 2, 3].map((n) => launch("client", [`http://127.0.0.${n}:${port}`]));
    const ready = await Promise.all(clients.map((client) => message(client, "ready")));
    const { chromeRoots } = await processInventory(profile);
    assert.equal(chromeRoots.length, 1, "Exactly one physical Chrome must serve all clients");
    const results = clients.map((client) => message(client, "evidence"));
    for (const client of clients) client.send("go");
    const rows = await Promise.all(results);
    assert.equal(new Set(rows.map((r) => r.pid)).size, 3);
    assert.equal(new Set(rows.map((r) => r.cap.targetId)).size, 3);
    assert.equal(new Set(rows.map((r) => r.cap.browserEpoch)).size, 1);
    assert.equal(new Set(rows.map((r) => r.sessionId)).size, 3);
    assert.ok(Math.max(...rows.map((r) => r.start)) < Math.min(...rows.map((r) => r.end)));
    // Finish one; remaining clients re-observe their original authenticated page.
    if (crashFirst) {
      clients[0].kill("SIGKILL");
      await assert.rejects(clients[0].exited);
      clients[0].exited = Promise.resolve();
    } else {
      clients[0].send("finish");
      await clients[0].exited;
    }
    for (const client of clients.slice(1)) client.send("finish");
    await Promise.all(clients.map((client) => client.exited));
    broker.send("shutdown");
    await broker.exited;
    for (let n = 0; n < 100 && (await inventory(profile)).length > baseline.length; n++)
      await sleep(100);
    const after = await inventory(profile);
    assert.deepEqual(after, baseline);
    evidence = {
      kind: "fixture-only-not-google-auth-qualification",
      brokerPid: broker.pid,
      chromeRoots,
      ready,
      rows,
      servicesProvisioned: services.size,
      firstClientExit: crashFirst ? "SIGKILL" : "graceful",
      cookiesSurvivedBrokerBrowserReopen: true,
      baseline,
      after,
    };
    assert.equal(services.size, 3);
    await writeFile(join(lab, "evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ evidencePath: join(lab, "evidence.json"), ...evidence }));
    return evidence;
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.allSettled(children.map((child) => child.exited));
    await new Promise((r) => server.close(r));
  }
}
if (["client", "broker"].includes(process.argv[2])) await childMain();
