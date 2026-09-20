/**
 * Live operate_drive signup harness for the five-provider corpus.
 * Speaks MCP stdio to a locally built server. Never prints credential values.
 *
 *   node tools/signup-corpus-drive.mjs <provider>
 *
 * Provider ids: see PROVIDERS below. Original five plus no-verify swaps.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const serverPath = path.join(repo, "apps/mcp/dist/bin.js");
const DATA = process.env.SIGNUP_CORPUS_DATA ?? "/home/lunchbox/firstmate/data/ts-drive-signup-corpus-5";

const PROVIDERS = {
  ipinfo: {
    service: "ipinfo",
    url: "https://ipinfo.io/signup",
    why: "CLAUDE.md verified full signup + API token; email path; no card.",
  },
  resend: {
    service: "resend",
    url: "https://resend.com/signup",
    why: "Verified post-captcha; email signup; free-tier key without a card.",
  },
  postmark: {
    service: "postmark",
    url: "https://account.postmarkapp.com/sign_up",
    why: "Verified post-captcha; email-only (no Google OAuth temptation); free developer key.",
  },
  openrouter: {
    service: "openrouter",
    url: "https://openrouter.ai/",
    why: "Clerk form lives behind the homepage Create-account CTA, not /sign-up marketing nav.",
  },
  meilisearch: {
    service: "meilisearch",
    url: "https://cloud.meilisearch.com/register",
    why: "Reached welcome-informations without email verify; France; key after onboarding.",
  },
  currencyapi: {
    service: "currencyapi",
    url: "https://app.currencyapi.com/register",
    why: "EverAPI (AT); dashboard shows the API key after register. Swap for Postmark.",
  },
  abstractapi: {
    service: "abstractapi",
    url: "https://app.abstractapi.com/users/sign_up",
    why: "Dashboard key after signup; no card. Swap for IPInfo/Resend email wall.",
  },
  algolia: {
    service: "algolia",
    url: "https://www.algolia.com/users/sign_up",
    why: "France; app keys exist on first project. Swap for OpenRouter email/Clerk wall.",
  },
  mistral: {
    service: "mistral",
    url: "https://console.mistral.ai/",
    why: "France; console API keys. Swap candidate if a US provider email-gates.",
  },
  groq: {
    service: "groq",
    url: "https://console.groq.com/",
    why: "STATE.md cracked to keys via in-modal Turnstile; try for a pre-verify key.",
  },
  exchangerateapi: {
    service: "exchangerateapi",
    url: "https://www.exchangerate-api.com/",
    why: "Dashboard often shows the key after register. Swap candidate.",
  },
  imgbb: {
    service: "imgbb",
    url: "https://imgbb.com/signup",
    why: "API key shown in account after email signup; no card.",
  },
  apininjas: {
    service: "apininjas",
    url: "https://api-ninjas.com/register",
    why: "Dashboard key after register. api.api-ninjas.com/register is JSON Forbidden.",
  },
  fireworks: {
    service: "fireworks",
    url: "https://app.fireworks.ai/login",
    why: "Keys in console after email signup; try for a visible key.",
  },
  removebg: {
    service: "removebg",
    url: "https://www.remove.bg/users/sign_up",
    why: "Account API key after signup; no card. Swap candidate.",
  },
  ip2location: {
    service: "ip2location",
    url: "https://www.ip2location.io/sign-up",
    why: "Dashboard key after register. Swap candidate.",
  },
};

const providerId = process.argv[2];
if (providerId === undefined || !(providerId in PROVIDERS)) {
  console.error(`usage: node tools/signup-corpus-drive.mjs <${Object.keys(PROVIDERS).join("|")}>`);
  process.exit(2);
}

const provider = PROVIDERS[providerId];
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(DATA, "runs", `${providerId}-${stamp}`);
mkdirSync(runDir, { recursive: true });
const tracePath = path.join(runDir, "drive-trace.jsonl");
const logPath = path.join(runDir, "harness.log");

const email = `lunchboxfortwo+c5-${providerId}-${Date.now().toString(36)}@gmail.com`;
const goal =
  `Sign up for ${provider.service} using the email/password form, not Google or GitHub. ` +
  `Create the account with the provided facts, complete email verification, reach the ` +
  `API key or access token page, create or reveal the key, and stop when the key is visible.`;

const facts = {
  email,
  first_name: "Squire",
  last_name: "Corpus",
  name: "Squire Corpus",
  company: "CorpusTest",
};

if (!existsSync(serverPath)) {
  console.error(JSON.stringify({ error: "missing server build", serverPath }));
  process.exit(1);
}

function log(obj) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...obj });
  appendFileSync(logPath, `${line}\n`);
  console.log(line);
}

function sanitize(value) {
  if (typeof value === "string") {
    return value
      .replace(/\b(re_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{8,}|pk_[A-Za-z0-9]{8,}|phc_[A-Za-z0-9]{8,})\b/g, "[redacted]")
      .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted-hex]");
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (["credentials", "password", "api_key", "token", "secret"].includes(k)) {
        out[k] = "[omitted]";
        continue;
      }
      out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}

const env = {
  ...process.env,
  TRUSTY_SQUIRE_PROFILE_DIR:
    process.env.TRUSTY_SQUIRE_PROFILE_DIR ?? "/home/lunchbox/.trusty-squire/signup-test-profile",
  TRUSTY_SQUIRE_ACCOUNT_ID: process.env.TRUSTY_SQUIRE_ACCOUNT_ID ?? "01KS0BKRYTVE9T9FAQQ31A4MK3",
  TRUSTY_SQUIRE_AGENT_IDENTITY: process.env.TRUSTY_SQUIRE_AGENT_IDENTITY ?? "signup-corpus-5",
  TRUSTY_SQUIRE_REGISTRY_URL:
    process.env.TRUSTY_SQUIRE_REGISTRY_URL ?? "https://registry.trustysquire.ai",
  TRUSTY_SQUIRE_SKIP_VERSION_CHECK: "1",
  DRIVE_TRACE_PATH: tracePath,
};

const server = spawn(process.execPath, [serverPath, "server"], {
  env,
  stdio: ["pipe", "pipe", "pipe"],
});
const serverErr = path.join(runDir, "server.stderr.log");
createInterface({ input: server.stderr }).on("line", (line) => {
  appendFileSync(serverErr, `${line}\n`);
});

let nextId = 1;
const pending = new Map();

function send(method, params) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method} id=${id}`));
      }
    }, 400_000);
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

async function callTool(name, args) {
  const t0 = Date.now();
  const result = await send("tools/call", { name, arguments: args });
  const text = (result?.content ?? [])
    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
    .join("\n");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 2000) };
  }
  return { name, ms: Date.now() - t0, isError: result?.isError === true, parsed: sanitize(parsed) };
}

function summarizeHandoff(parsed) {
  return {
    status: parsed.status,
    session_id: parsed.session_id,
    steps: parsed.steps,
    seconds: parsed.seconds,
    jev_calls: parsed.jev_calls,
    field: parsed.field,
    reason: parsed.reason,
    done: parsed.done,
    remaining: parsed.remaining,
    url: parsed.observation?.url,
    wall: parsed.observation?.needs_user?.wall,
    trajectory_len: Array.isArray(parsed.trajectory) ? parsed.trajectory.length : 0,
  };
}

async function main() {
  writeFileSync(
    path.join(runDir, "meta.json"),
    JSON.stringify(
      {
        provider: providerId,
        service: provider.service,
        url: provider.url,
        why: provider.why,
        goal,
        facts: { ...facts, email: `${email.replace(/@/, "@")}` },
        tracePath,
      },
      null,
      2,
    ),
  );
  log({ event: "start", provider: providerId, runDir });

  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "signup-corpus-drive", version: "0.0.1" },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  log({ event: "initialized", server: init?.serverInfo?.name });

  let sessionId;
  let totalSteps = 0;
  let calls = 0;
  const MAX_CALLS = 20;
  let last;

  last = await callTool("operate_drive", {
    url: provider.url,
    goal,
    facts,
    max_steps: 60,
    max_seconds: 120,
  });
  calls += 1;
  sessionId = last.parsed.session_id;
  totalSteps += Number(last.parsed.steps ?? 0);
  log({ event: "drive", call: calls, ...summarizeHandoff(last.parsed) });

  while (
    sessionId &&
    ["budget", "evaluate_timeout"].includes(last.parsed.status) &&
    calls < MAX_CALLS &&
    Number(last.parsed.jev_calls ?? 0) < 120 &&
    Number(last.parsed.steps ?? 0) > 0 &&
    !String(last.parsed.done ?? "")
      .split(";")
      .every((part) => part.trim().startsWith("wait"))
  ) {
    last = await callTool("operate_drive", {
      session_id: sessionId,
      goal,
      facts,
      max_steps: 60,
      max_seconds: 120,
    });
    calls += 1;
    totalSteps += Number(last.parsed.steps ?? 0);
    log({ event: "drive", call: calls, ...summarizeHandoff(last.parsed) });
  }

  const outcome = {
    provider: providerId,
    service: provider.service,
    status: last.parsed.status,
    session_id: sessionId,
    drive_calls: calls,
    drive_steps: totalSteps,
    field: last.parsed.field,
    wall: last.parsed.observation?.needs_user?.wall,
    url: last.parsed.observation?.url,
    vault_reference: null,
    stored: false,
    blocked_reason: null,
  };

  if (last.parsed.status === "complete" && sessionId) {
    const extracted = await callTool("operate_extract", {
      session_id: sessionId,
      store: { service: provider.service, label: `corpus-5-${providerId}` },
    });
    log({
      event: "extract",
      stored: extracted.parsed.stored === true || extracted.parsed.stored_credential != null,
      reference: extracted.parsed.stored_credential?.reference ?? extracted.parsed.reference,
      candidate_count: extracted.parsed.candidate_count,
      error: extracted.parsed.error,
    });
    const reference =
      extracted.parsed.stored_credential?.reference ?? extracted.parsed.reference ?? null;
    if (typeof reference === "string" && reference.length > 0) {
      outcome.stored = true;
      outcome.vault_reference = reference;
    } else {
      outcome.blocked_reason = extracted.parsed.error ?? extracted.parsed.blocked_reason ?? "extract_unresolved";
    }
    const finished = await callTool("operate_finish", {
      session_id: sessionId,
      outcome: outcome.stored ? "result" : "none",
      ...(outcome.stored
        ? { summary: `${provider.service} key vaulted`, data: { provider: providerId } }
        : {}),
    });
    log({ event: "finish", closed: finished.parsed.closed, execution: finished.parsed.execution });
  } else if (sessionId) {
    outcome.blocked_reason =
      last.parsed.status === "needs_value"
        ? `needs_value:${last.parsed.field ?? last.parsed.observation?.needs_user?.wall ?? "unknown"}`
        : last.parsed.status;
    await callTool("operate_finish", { session_id: sessionId, outcome: "none" }).catch(() => {});
  }

  writeFileSync(path.join(runDir, "outcome.json"), JSON.stringify(outcome, null, 2));
  const ledger = path.join(DATA, "ledger.jsonl");
  appendFileSync(ledger, `${JSON.stringify({ t: new Date().toISOString(), ...outcome })}\n`);
  log({ event: "done", ...outcome });
}

main()
  .catch((error) => {
    log({ event: "fatal", error: String(error).slice(0, 2000) });
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      server.stdin.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (!server.killed) server.kill("SIGTERM");
      setTimeout(() => process.exit(process.exitCode ?? 0), 1000);
    }, 500);
  });
