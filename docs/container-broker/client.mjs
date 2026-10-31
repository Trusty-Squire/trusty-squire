import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const entry = "/opt/squire/node_modules/@trusty-squire/mcp/dist/bin.js";
const brokerLog = "/tmp/broker.log";

function say(line) {
  process.stdout.write(`${line}\n`);
}

async function waitForListen() {
  const deadline = Date.now() + 90_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = readFileSync(brokerLog, "utf8");
      if (last.includes("[browser-broker] listening")) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(200);
  }
  throw new Error(`broker did not listen: ${last.slice(-2000)}`);
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
  let session = null;
  let url = null;
  const isError = message.result?.isError === true || message.error !== undefined;
  const content = message.result?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block?.text !== "string") continue;
      try {
        const parsed = JSON.parse(block.text);
        session = parsed.session_id ?? session;
        url = parsed.url ?? parsed.final_url ?? url;
      } catch {
        /* observation text is not always JSON */
      }
    }
  }
  say(
    `CLIENT ${label} bytes=${text.length} error=${JSON.stringify(message.error ?? null)} isError=${isError} session_id=${session ?? ""} url=${url ?? ""}`,
  );
  say(`CLIENT ${label} body_head=${text.slice(0, 1500)}`);
  return { session, isError };
}

const version = JSON.parse(
  readFileSync("/opt/squire/node_modules/@trusty-squire/mcp/package.json", "utf8"),
).version;
say(`PACKAGE ${version}`);
await waitForListen();
say("BROKER listening");

const server = spawn(process.execPath, [entry, "server"], {
  env: {
    ...process.env,
    HOME: process.env.HOME ?? "/root",
    TRUSTY_SQUIRE_PROFILE_DIR:
      process.env.TRUSTY_SQUIRE_PROFILE_DIR ?? "/root/.trusty-squire/chrome-profile",
    TRUSTY_SQUIRE_BROKER_UNIT: "1",
    TRUSTY_SQUIRE_AGENT_IDENTITY: "container-broker-test",
  },
  stdio: ["pipe", "pipe", "pipe"],
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
  client.notify("notifications/initialized", {});
  const started = summarize(
    "operate_start",
    await client.request(
      "tools/call",
      {
        name: "operate_start",
        arguments: { service_url: "https://example.com", format: "compact" },
      },
      180_000,
    ),
  );
  if (!started.session || started.isError) {
    throw new Error("operate_start did not open https://example.com");
  }
  const finished = summarize(
    "operate_finish",
    await client.request(
      "tools/call",
      { name: "operate_finish", arguments: { session_id: started.session, outcome: "none" } },
      60_000,
    ),
  );
  if (finished.isError) throw new Error("operate_finish failed");
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
  try {
    say("--- broker log tail ---");
    say(readFileSync(brokerLog, "utf8").slice(-4000));
  } catch {
    /* broker log missing */
  }
  server.kill("SIGTERM");
  process.exit(1);
}
