// Native manager acceptance. No browser or enrollment is needed for MCP initialize/tools/list.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.ok(
  ["linux", "darwin"].includes(process.platform),
  "Native acceptance requires systemd or launchd",
);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Linux CI creates a dedicated user with this isolated home so its manager reads
// the same XDG unit directory as the installer. macOS bootstraps an explicit plist.
const home =
  process.platform === "linux"
    ? process.env.TS_NATIVE_ACCEPTANCE_HOME
    : await mkdtemp(join("/tmp", "ts-native-"));
assert.ok(home && home.startsWith("/tmp/ts-native-"), "An isolated acceptance home is required");
const profile = join(home, ".trusty-squire", "chrome-profile");
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  TRUSTY_SQUIRE_PROFILE_DIR: profile,
};
delete env.TRUSTY_SQUIRE_BROKER_SOCKET;
delete env.TRUSTY_SQUIRE_BROKER_UNIT;
delete env.INVOCATION_ID;
await mkdir(profile, { recursive: true, mode: 0o700 });
const run = (command, args) =>
  execFileSync(command, args, {
    env,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
if (process.platform === "linux") run("systemctl", ["--user", "show-environment"]);
else run("launchctl", ["print", `gui/${process.getuid()}`]);

async function waitFor(observe, description, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let error;
  do {
    try {
      return await observe();
    } catch (next) {
      error = next;
    }
    await new Promise((done) => setTimeout(done, 200));
  } while (Date.now() < deadline);
  throw new Error(`${description}: ${error?.message}`);
}
async function stage(version) {
  const cache = join(home, "_npx", version);
  const pkg = join(cache, "node_modules", "@trusty-squire", "mcp");
  await mkdir(pkg, { recursive: true });
  await cp(join(packageRoot, "dist"), join(pkg, "dist"), { recursive: true });
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  await writeFile(join(pkg, "package.json"), JSON.stringify({ ...metadata, version }));
  await symlink(join(packageRoot, "node_modules"), join(pkg, "node_modules"));
  return { cache, pkg };
}
function install(pkg) {
  const url = pathToFileURL(join(pkg, "dist", "install", "broker-service.js")).href;
  run(process.execPath, [
    "--input-type=module",
    "-e",
    `const { installBrokerService } = await import(${JSON.stringify(url)}); await installBrokerService(process.env.TRUSTY_SQUIRE_PROFILE_DIR);`,
  ]);
}
const name = "trusty-squire-broker";
const unit = `${name}.service`;
const domain = `gui/${process.getuid()}`;
const target = `${domain}/ai.trustysquire.${name}`;
const registration =
  process.platform === "linux"
    ? join(env.XDG_CONFIG_HOME, "systemd", "user", unit)
    : join(home, "Library", "LaunchAgents", `ai.trustysquire.${name}.plist`);
let wireSocket = "";
function managerPid() {
  const output =
    process.platform === "linux"
      ? run("systemctl", ["--user", "show", unit, "-p", "MainPID", "--value"])
      : run("launchctl", ["print", target]).match(/\bpid = (\d+)/)?.[1];
  const pid = Number(output);
  assert.ok(pid > 0, "Manager must report a running broker PID");
  return pid;
}
function brokers() {
  return run("ps", ["-axo", "pid=,command="])
    .split("\n")
    .filter(
      (line) => line.includes(join(home, ".trusty-squire", "broker")) && /\bbroker\s*$/.test(line),
    )
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}
function listeners() {
  const output =
    process.platform === "linux"
      ? run("ss", ["-xlp"])
      : execFileSync("lsof", ["-U", "-n", "-P"], { encoding: "utf8" });
  return output
    .split("\n")
    .filter((line) => line.includes(home) || (wireSocket && line.includes(wireSocket)));
}
const clients = [];
function client(bin) {
  const child = spawn(process.execPath, [bin, "server"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "",
    stderr = "",
    nextId = 0;
  const replies = new Map();
  const exited = new Promise((done) => child.once("exit", done));
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const frame = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (frame.id !== undefined) replies.set(frame.id, frame);
    }
  });
  const send = (method, params) => {
    const id = ++nextId;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return id;
  };
  const result = async (id) =>
    waitFor(() => {
      const reply = replies.get(id);
      assert.ok(reply, `MCP reply ${id} missing; ${stderr}`);
      return reply;
    }, "MCP response");
  const api = { child, exited, send, result, stderr: () => stderr };
  clients.push(api);
  return api;
}
async function initialize(peer) {
  const reply = await peer.result(
    peer.send("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "native-service-acceptance", version: "1" },
    }),
  );
  assert.ok(reply.result, JSON.stringify(reply));
  peer.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  return reply.result.serverInfo.version;
}
async function tools(peer) {
  await waitFor(async () => {
    const reply = await peer.result(peer.send("tools/list", {}));
    assert.ok(reply.result?.tools?.length, JSON.stringify(reply));
    assert.equal(peer.child.exitCode, null);
  }, "Clients reconnect and list tools");
}
async function noBroker() {
  await waitFor(() => assert.deepEqual(brokers(), []), "Broker stopped");
  assert.deepEqual(listeners(), []);
}
let registered = false;
try {
  const first = await stage("0.0.0-acceptance.1");
  // The same built installer entry called by connect performs actual registration.
  registered = true;
  install(first.pkg);
  wireSocket = JSON.parse(
    await readFile(join(home, ".trusty-squire", ".trusty-squire-broker-unit.json"), "utf8"),
  ).socket;
  await rm(first.cache, { recursive: true });
  const firstEntry = join(
    home,
    ".trusty-squire",
    "broker",
    "0.0.0-acceptance.1",
    "node_modules",
    "@trusty-squire",
    "mcp",
    "dist",
    "bin.js",
  );
  assert.ok((await readFile(registration, "utf8")).includes(firstEntry));
  const firstPid = managerPid();
  assert.deepEqual(brokers(), [firstPid]);
  if (process.platform === "linux")
    assert.equal(run("systemctl", ["--user", "is-enabled", unit]).trim(), "enabled");
  else {
    const plist = await readFile(registration, "utf8");
    assert.ok(plist.includes("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>"));
    assert.ok(plist.includes("<key>ThrottleInterval</key><integer>5</integer>"));
  }
  const peers = [client(firstEntry), client(firstEntry)];
  assert.deepEqual(await Promise.all(peers.map(initialize)), [
    "0.0.0-acceptance.1",
    "0.0.0-acceptance.1",
  ]);
  await Promise.all(peers.map(tools));
  console.log(
    `native ${process.platform} fresh: registered; PID=${firstPid}; two MCP clients initialized after cache deletion`,
  );

  const second = await stage("0.0.0-acceptance.2");
  install(second.pkg);
  await rm(second.cache, { recursive: true });
  const secondEntry = firstEntry.replace("acceptance.1", "acceptance.2");
  assert.ok((await readFile(registration, "utf8")).includes(secondEntry));
  assert.equal(managerPid(), firstPid, "connect must preserve the running broker PID");
  await Promise.all(peers.map(tools));
  assert.deepEqual(brokers(), [firstPid]);
  const upgraded = client(secondEntry);
  assert.equal(await initialize(upgraded), "0.0.0-acceptance.1");
  await tools(upgraded);
  upgraded.child.stdin.end();
  await upgraded.exited;
  console.log(
    `native ${process.platform} upgrade: new entry staged; PID=${firstPid} and two connected clients preserved`,
  );

  if (process.platform === "linux") run("systemctl", ["--user", "restart", unit]);
  else {
    run("launchctl", ["bootout", target]);
    await waitFor(
      () => run("launchctl", ["bootstrap", domain, registration]),
      "Launchd rebootstrap after bootout",
    );
  }
  const restartedPid = await waitFor(() => {
    const pid = managerPid();
    assert.notEqual(pid, firstPid);
    return pid;
  }, "Manager restart replaced broker PID");
  assert.ok(run("ps", ["-p", String(restartedPid), "-o", "args="]).includes(secondEntry));
  await Promise.all(peers.map(tools));
  assert.deepEqual(brokers(), [restartedPid]);
  const restarted = client(secondEntry);
  assert.equal(await initialize(restarted), "0.0.0-acceptance.2");
  await tools(restarted);
  restarted.child.stdin.end();
  await restarted.exited;
  console.log(
    `BBC-1 native ${process.platform} restart: two clients reconnected; exactly one broker PID=${restartedPid}`,
  );
  for (const peer of peers) {
    peer.child.stdin.end();
    await peer.exited;
  }
  if (process.platform === "linux") run("systemctl", ["--user", "stop", unit]);
  else run("launchctl", ["bootout", target]);
  await noBroker();
  const stopped = client(secondEntry);
  stopped.send("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "stopped", version: "1" },
  });
  const observed = [];
  const samples = setInterval(() => observed.push(...brokers()), 100);
  try {
    assert.equal(await stopped.exited, 1);
    assert.match(stopped.stderr(), /broker not running/);
    assert.deepEqual(observed, []);
    await noBroker();
  } finally {
    clearInterval(samples);
  }
  console.log(
    `BBC-1 native ${process.platform} stopped: exit=1; broker not running; broker PIDs=[]; listeners=[]`,
  );
} catch (error) {
  // Preserve this isolated broker's startup evidence before cleanup removes it.
  console.error(error);
  const log = await readFile(join(home, ".trusty-squire", `${name}.log`), "utf8").catch(
    () => "Broker log unavailable",
  );
  console.error(log);
  throw error;
} finally {
  for (const peer of clients) {
    if (peer.child.exitCode === null && peer.child.signalCode === null) {
      peer.child.kill("SIGTERM");
      await peer.exited;
    }
  }
  if (registered) {
    if (process.platform === "linux") run("systemctl", ["--user", "disable", "--now", unit]);
    else {
      try {
        run("launchctl", ["bootout", target]);
      } catch {
        /* already unloaded */
      }
    }
    await rm(registration, { force: true });
    if (process.platform === "linux") run("systemctl", ["--user", "daemon-reload"]);
    await noBroker();
  }
  if (process.platform === "darwin") await rm(home, { recursive: true });
}
