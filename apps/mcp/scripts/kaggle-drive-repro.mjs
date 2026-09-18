/**
 * MANUAL LIVE REPRO DRIVER — for fm/ts-recaptcha-autosolve-not-engaging.
 * Spawns the locally built MCP server (dist/bin.js server) and speaks plain
 * MCP stdio, then relays JSON command lines dropped into a queue directory
 * (.kaggle-drive-queue/*.json, one JSON object per file: {name, args}) so the
 * operator can drive a PLAIN operate_* run step by step across shells.
 * Server stderr (provision-audit + captcha-autosolve-diag lines) is inherited;
 * note the broker daemon's stderr (where those lines actually land) is
 * ~/.trusty-squire/.trusty-squire-broker-leases/launch/broker.log.
 *
 * Usage:
 *   node scripts/kaggle-drive-repro.mjs > .kaggle-drive-out.log 2> .kaggle-drive-server.log &
 *   echo '{"name":"operate_start","args":{...}}' > .kaggle-drive-queue/001-start.json
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "dist", "bin.js");

if (!existsSync(serverPath)) {
  console.error(JSON.stringify({ driver: "missing server build", serverPath }));
  process.exit(1);
}

// Mirror the codex "squire" env so this drives the same account + test profile.
const env = {
  ...process.env,
  TRUSTY_SQUIRE_PROFILE_DIR:
    process.env.TRUSTY_SQUIRE_PROFILE_DIR ?? "/home/lunchbox/.trusty-squire/signup-test-profile",
  TRUSTY_SQUIRE_ACCOUNT_ID: process.env.TRUSTY_SQUIRE_ACCOUNT_ID ?? "01KS0BKRYTVE9T9FAQQ31A4MK3",
  TRUSTY_SQUIRE_AGENT_IDENTITY: process.env.TRUSTY_SQUIRE_AGENT_IDENTITY ?? "codex",
  TRUSTY_SQUIRE_REGISTRY_URL:
    process.env.TRUSTY_SQUIRE_REGISTRY_URL ?? "https://registry.trustysquire.ai",
  TRUSTY_SQUIRE_SKIP_VERSION_CHECK: "1",
};

const server = spawn(process.execPath, [serverPath, "server"], {
  env,
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const pending = new Map();

function send(method, params) {
  const id = nextId++;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  server.stdin.write(msg + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method} id=${id}`));
      }
    }, 300_000);
  });
}

createInterface({ input: server.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

async function init() {
  const result = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "kaggle-drive-repro", version: "0.0.1" },
  });
  server.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
  console.log(JSON.stringify({ driver: "initialized", serverInfo: result?.serverInfo }));
}

async function callTool(name, args) {
  const t0 = Date.now();
  try {
    const result = await send("tools/call", { name, arguments: args });
    const text = (result?.content ?? [])
      .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
      .join("\n");
    console.log(
      JSON.stringify({ tool: name, ms: Date.now() - t0, isError: result?.isError === true, text }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({ tool: name, ms: Date.now() - t0, error: String(error).slice(0, 2000) }),
    );
  }
}

async function commandLoop() {
  const queueDir = path.join(here, "..", "..", "..", ".kaggle-drive-queue");
  mkdirSync(queueDir, { recursive: true });
  let served = new Set();
  while (true) {
    const entries = readdirSync(queueDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const entry of entries) {
      if (served.has(entry)) continue;
      served.add(entry);
      const file = path.join(queueDir, entry);
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        console.log(JSON.stringify({ driver: "unparsable", entry, error: String(e) }));
        rmSync(file);
        continue;
      }
      if (parsed.name === "__wait") {
        await new Promise((r) => setTimeout(r, parsed.ms ?? 1000));
        console.log(JSON.stringify({ driver: "waited", ms: parsed.ms ?? 1000 }));
        rmSync(file);
        continue;
      }
      if (parsed.name === "__diag") {
        try {
          const log = readFileSync(process.env.DRIVE_SERVER_LOG ?? "", "utf8");
          const lines = log
            .split("\n")
            .filter((l) => l.includes("captcha") || l.includes("provision-audit"));
          console.log(JSON.stringify({ driver: "diag", lines: lines.slice(-40) }));
        } catch (e) {
          console.log(JSON.stringify({ driver: "diag_error", error: String(e) }));
        }
        rmSync(file);
        continue;
      }
      await callTool(parsed.name, parsed.args ?? {});
      rmSync(file);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

init()
  .then(commandLoop)
  .catch((error) => {
    console.error(JSON.stringify({ driver: "fatal", error: String(error) }));
    process.exit(1);
  });
