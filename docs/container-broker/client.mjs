import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const packagedEntry = "/opt/squire/node_modules/@trusty-squire/mcp/dist/bin.js";
const deployedEntry = "/opt/squire/dist/bin.js";
const entry = packagedEntry;
const fallbackEntry = deployedEntry;

function resolveEntry() {
  try {
    readFileSync(entry);
    return entry;
  } catch {
    return fallbackEntry;
  }
}

function say(line) {
  process.stdout.write(`${line}\n`);
}

function profileBrokers(profile) {
  const found = [];
  for (const entryName of readdirSync("/proc")) {
    if (!/^\d+$/.test(entryName)) continue;
    let argv = "";
    let env = "";
    try {
      argv = readFileSync(`/proc/${entryName}/cmdline`, "utf8");
      env = readFileSync(`/proc/${entryName}/environ`, "utf8");
    } catch {
      continue;
    }
    if (!argv.split("\0").includes("broker")) continue;
    if (env.split("\0").includes(`TRUSTY_SQUIRE_PROFILE_DIR=${profile}`)) found.push(Number(entryName));
  }
  return found;
}

class McpClient {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.waiters = new Map();
    this.nextId = 1;
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let end;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== undefined && this.waiters.has(message.id)) {
          const waiter = this.waiters.get(message.id);
          this.waiters.delete(message.id);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    });
    child.on("exit", (code, signal) => {
      const error = new Error(`mcp server exit code=${code} signal=${signal}`);
      for (const waiter of this.waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.waiters.clear();
    });
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`timeout ${method} id=${id}`));
      }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
}

function summarize(label, message) {
  const text = JSON.stringify(message);
  const isError = message.result?.isError === true || message.error !== undefined;
  say(
    `CLIENT ${label} bytes=${text.length} error=${JSON.stringify(message.error ?? null)} isError=${isError}`,
  );
  say(`CLIENT ${label} body_head=${text.slice(0, 1500)}`);
  return { isError, message };
}

const profile =
  process.env.TRUSTY_SQUIRE_PROFILE_DIR ?? "/root/.trusty-squire/chrome-profile";
say(`BROKERS_BEFORE ${JSON.stringify(profileBrokers(profile))}`);

const server = spawn(process.execPath, [resolveEntry(), "server"], {
  env: {
    ...process.env,
    HOME: process.env.HOME ?? "/root",
    TRUSTY_SQUIRE_PROFILE_DIR: profile,
    TRUSTY_SQUIRE_AGENT_IDENTITY: "container-broker-test",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});
const client = new McpClient(server);

try {
  const init = await client.request(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "container-broker-test", version: "0" },
    },
    20_000,
  );
  summarize("initialize", init);
  if (init.error) throw new Error("initialize failed");
  client.notify("notifications/initialized", {});
  const listed = summarize(
    "list_credentials",
    await client.request(
      "tools/call",
      { name: "list_credentials", arguments: {} },
      30_000,
    ),
  );
  if (listed.isError) throw new Error("list_credentials failed");
  const brokers = profileBrokers(profile);
  say(`BROKERS_AFTER ${JSON.stringify(brokers)}`);
  let systemctl = "";
  try {
    systemctl = readFileSync("/var/log/systemctl-calls.log", "utf8");
  } catch {
    systemctl = "(none)";
  }
  say("--- systemctl calls ---");
  say(systemctl || "(none)");
  say("RESULT pass");
  server.kill("SIGTERM");
  process.exit(0);
} catch (error) {
  say("RESULT fail");
  say(error instanceof Error ? (error.stack ?? error.message) : String(error));
  say(`BROKERS_ON_FAIL ${JSON.stringify(profileBrokers(profile))}`);
  say("--- server stderr tail ---");
  say(stderr.slice(-4000));
  server.kill("SIGTERM");
  process.exit(1);
}
