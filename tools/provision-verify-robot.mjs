#!/usr/bin/env node
// provision-verify-robot.mjs — create / warm / rotate / delete the verify-pool
// robot identities (Cloud Identity Free Google accounts on the verify domain)
// so the OAuth verify pool never exhausts again.
//
// WHY: the verify pool is N fresh Google identities (verify-NN@<domain>). "Spent"
// is one-shot per (robot, service) — once verify-03 signs up at unify it's a
// returning user there forever. A debugging marathon on ONE service can burn all
// N robots' slots for that service. The fix is rotation, NOT growth: the managed
// verifier fleet has a hard cap of 10 active robots. When a service needs fresh
// identities, retire old robots first, then mint replacements under the same cap.
// A fresh robot is a fresh slate at EVERY service.
//
// SPLIT OF AUTONOMY:
//   • account create / delete + pool bookkeeping → FULLY autonomous here
//     (Admin SDK Directory API + JSON files). No human, no token-paste.
//   • profile WARMING (a logged-in Chrome session per robot) → human-in-the-loop
//     by design: Google blocks automated logins (see apps/mcp/src/bot/
//     google-login.ts), so a human logs each NEW robot in ONCE via the noVNC
//     tunnel. One login per new robot — NOT per signup.
//
// PREREQ (one-time, operator): the service-account key at
// ~/.trusty-squire/admin-sa.json with domain-wide delegation for the scope
// https://www.googleapis.com/auth/admin.directory.user — see the header of
// tools/google-admin-token.mjs for the exact GCP + Admin-console steps.
//
// USAGE:
//   node tools/provision-verify-robot.mjs list
//   node tools/provision-verify-robot.mjs create [N] [--dry-run]
//   node tools/provision-verify-robot.mjs warm verify-NN
//   node tools/provision-verify-robot.mjs rotate [--spent-ge=K] [--target=N] [--dry-run]
//   node tools/provision-verify-robot.mjs delete verify-NN [--dry-run]
//
// --dry-run is fully OFFLINE (no token, no API, no writes): it prints exactly
// what create/rotate/delete WOULD do, computed from the local pool. Use it to
// sanity-check before the SA key is in place.

import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mintAdminToken } from "./google-admin-token.mjs";

const DOMAIN = process.env.TRUSTY_SQUIRE_VERIFY_DOMAIN ?? "trustysquire.ai";
const FREE_CAP = Number(process.env.CLOUD_IDENTITY_FREE_CAP ?? 50);
// HARD COST CAP — the max ACTIVE managed verifier robots we ever hold. This is
// deliberately NOT environment-overridable: raising it creates additional seats.
// To get fresh identities, rotate old robots out first.
const POOL_CAP = 10;
const BASE = process.env.TRUSTY_SQUIRE_VERIFY_POOL_DIR ?? join(homedir(), ".trusty-squire");
const POOL_PATH = join(BASE, "verify-identities.json");
const PW_PATH = join(BASE, "verify-passwords.json");
const USAGE_PATH = join(BASE, "identity-usage.json");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR_API = "https://admin.googleapis.com/admin/directory/v1/users";

// ── JSON helpers — every write snapshots a timestamped .bak first ──────────
function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(path, obj) {
  if (existsSync(path)) copyFileSync(path, `${path}.bak-${Date.now()}`);
  writeFileSync(path, `${JSON.stringify(obj, null, 1)}\n`);
}

function loadPool() {
  return readJson(POOL_PATH, { identities: [] });
}
function loadUsage() {
  const paths = [USAGE_PATH];
  try {
    for (const name of readdirSync(BASE)) {
      if (/^identity-usage\.json\.bak-/.test(name)) paths.push(join(BASE, name));
    }
  } catch {
    // Missing/unreadable base falls through to primary-only fallback.
  }
  const byPair = new Map();
  for (const path of paths) {
    const usage = readJson(path, { spent: [] });
    for (const row of usage.spent ?? []) {
      const key = `${row.identityId}\u0000${row.service}`;
      if (!byPair.has(key)) byPair.set(key, row);
    }
  }
  return { spent: [...byPair.values()] };
}

// Distinct services each robot id has been spent at.
function servicesByRobot(usage) {
  const m = new Map();
  for (const r of usage.spent ?? []) {
    if (!m.has(r.identityId)) m.set(r.identityId, new Set());
    m.get(r.identityId).add(r.service);
  }
  return m;
}

function robotNum(id) {
  const m = /^verify-(\d+)$/.exec(id);
  return m ? Number(m[1]) : NaN;
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function idFor(n) {
  return `verify-${pad2(n)}`;
}
function emailFor(n) {
  return `verify-${pad2(n)}@${DOMAIN}`;
}
function profileDirFor(n) {
  // Stored with a literal ~ like the existing entries; identity-pool.ts expands it.
  return `~/.trusty-squire/profiles/verify-${pad2(n)}`;
}

// A strong password that satisfies Google's policy (≥8, mixed classes). 24 chars.
function genPassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digit = "23456789";
  const sym = "!@#$%^&*-_=+";
  const all = upper + lower + digit + sym;
  const pick = (set) => set[randomBytes(1)[0] % set.length];
  const chars = [pick(upper), pick(lower), pick(digit), pick(sym)];
  while (chars.length < 24) chars.push(pick(all));
  // Fisher–Yates with crypto bytes so the guaranteed-class chars aren't always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// ── Directory API ──────────────────────────────────────────────────────────
async function dirApi(method, token, pathSuffix = "", body) {
  const res = await fetch(`${DIR_API}${pathSuffix}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  const json = text.length > 0 ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = json?.error?.message ?? text;
    throw new Error(`Directory API ${method} ${pathSuffix || "(insert)"} failed (${res.status}): ${msg}`);
  }
  return json;
}

// ── Enterprise License Manager API (serves on www.googleapis.com) ───────────
async function licensingApi(method, token, suffix) {
  const res = await fetch(`https://www.googleapis.com/apps/licensing/v1/${suffix}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  const json = text.length > 0 ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`Licensing ${method} ${suffix} (${res.status}): ${json?.error?.message ?? text}`);
  }
  return json;
}

// Every paid Google Workspace license assignment on the domain (paginated).
async function listWorkspaceLicenses(token) {
  const items = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ customerId: DOMAIN, maxResults: "100" });
    if (pageToken) q.set("pageToken", pageToken);
    const page = await licensingApi("GET", token, `product/Google-Apps/users?${q.toString()}`);
    for (const it of page.items ?? []) items.push(it);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

// All users on the domain (paginated). Returns array of {primaryEmail,...}.
async function listDomainUsers(token) {
  const users = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ domain: DOMAIN, maxResults: "200" });
    if (pageToken) q.set("pageToken", pageToken);
    const page = await dirApi("GET", token, `?${q.toString()}`);
    for (const u of page.users ?? []) users.push(u);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return users;
}

// The set of verify-NN numbers already taken — locally AND in Google — so we
// never collide with a half-provisioned account.
function takenNumbers(pool, domainUsers, usage = { spent: [] }) {
  const taken = new Set();
  for (const e of pool.identities ?? []) {
    const n = robotNum(e.id);
    if (!Number.isNaN(n)) taken.add(n);
  }
  for (const r of usage.spent ?? []) {
    const n = robotNum(r.identityId);
    if (!Number.isNaN(n)) taken.add(n);
  }
  for (const u of domainUsers ?? []) {
    const m = /^verify-(\d+)@/.exec(u.primaryEmail ?? "");
    if (m) taken.add(Number(m[1]));
  }
  return taken;
}
function nextFreeNumbers(taken, count) {
  const out = [];
  let n = 1;
  while (out.length < count) {
    if (!taken.has(n)) out.push(n);
    n++;
  }
  return out;
}

// ── commands ─────────────────────────────────────────────────────────────
async function cmdList() {
  const pool = loadPool();
  const usage = loadUsage();
  const byRobot = servicesByRobot(usage);
  const token = await mintAdminToken();
  const domainUsers = await listDomainUsers(token);
  console.log(`Cloud Identity Free cap: ${domainUsers.length}/${FREE_CAP} active domain users (headroom ${FREE_CAP - domainUsers.length})`);
  console.log(`Pool (verify-identities.json): ${pool.identities.length} robot(s)`);
  const sorted = [...pool.identities].sort((a, b) => robotNum(a.id) - robotNum(b.id));
  for (const e of sorted) {
    const spent = byRobot.get(e.id)?.size ?? 0;
    const live = domainUsers.some((u) => (u.primaryEmail ?? "").toLowerCase() === e.email.toLowerCase());
    console.log(`  ${e.id}  spent@${String(spent).padStart(2)} services  google=${live ? "live" : "MISSING"}`);
  }
}

// Audit (and with --apply, strip) the paid Workspace license on every verify-NN
// bot — they should be on free Cloud Identity, not a billed Business Starter seat.
// Never touches non-bot users (dani@/lunchbox@). Re-lists after to confirm.
async function cmdLicenses(apply) {
  const token = await mintAdminToken();
  const all = await listWorkspaceLicenses(token);
  const bots = all.filter((a) => /^verify-\d+@/.test(a.userId ?? ""));
  console.log(`Workspace (paid) license holders: ${all.length} total — ${bots.length} are verify-NN bots:`);
  for (const a of bots) console.log(`  ${a.userId}  ${a.skuName} (${a.skuId})`);
  if (bots.length === 0) {
    console.log("No bot holds a paid Workspace license — already clean ✓");
    return;
  }
  if (!apply) {
    console.log(`\n[dry-run] pass --apply to UNASSIGN these ${bots.length} bot licenses (reversible).`);
    return;
  }
  for (const a of bots) {
    await licensingApi(
      "DELETE",
      token,
      `product/${a.productId}/sku/${a.skuId}/user/${encodeURIComponent(a.userId)}`,
    );
    console.log(`unassigned ${a.userId}`);
  }
  const after = (await listWorkspaceLicenses(token)).filter((a) => /^verify-\d+@/.test(a.userId ?? ""));
  console.log(
    after.length === 0
      ? `\nAll verify-NN bots are off paid Workspace seats ✓`
      : `\nStill paid: ${after.map((a) => a.userId).join(", ")} (re-run, or auto-assign re-added them — turn it off in Admin → Billing)`,
  );
}

async function cmdCreate(count, dryRun) {
  const pool = loadPool();
  if (dryRun) {
    const taken = takenNumbers(pool, [], loadUsage());
    const nums = nextFreeNumbers(taken, count);
    const over = pool.identities.length + count > POOL_CAP;
    console.log(`[dry-run] would create ${count} robot(s): ${nums.map(idFor).join(", ")}`);
    console.log(
      `[dry-run] pool ${pool.identities.length}→${pool.identities.length + count} of cap ${POOL_CAP}` +
        (over ? ` — OVER the hard cap; would be REJECTED (use 'rotate --make-room=${count}' instead)` : " — within cap ✓"),
    );
    for (const n of nums) console.log(`[dry-run]   ${emailFor(n)}  profile=${profileDirFor(n)}`);
    return;
  }
  // HARD CAP (the billing guardrail): never let managed robots exceed POOL_CAP.
  // To add fresh capacity without raising cost, rotate (retire spent → mint
  // fresh, net zero). There is intentionally no bypass.
  if (pool.identities.length + count > POOL_CAP) {
    throw new Error(
      `creating ${count} would put the pool at ${pool.identities.length + count} robots, over the hard cap of ` +
        `${POOL_CAP} (each robot = a billed seat). To add capacity WITHOUT increasing cost, rotate instead: ` +
        `node tools/provision-verify-robot.mjs rotate --make-room=${count}`,
    );
  }
  const token = await mintAdminToken();
  const domainUsers = await listDomainUsers(token);
  if (domainUsers.length + count > FREE_CAP) {
    throw new Error(
      `creating ${count} would exceed the Cloud Identity Free cap (${domainUsers.length}/${FREE_CAP} used). ` +
        `Rotate fully-spent robots out first: node tools/provision-verify-robot.mjs rotate`,
    );
  }
  const taken = takenNumbers(pool, domainUsers, loadUsage());
  const nums = nextFreeNumbers(taken, count);
  const pw = readJson(PW_PATH, {});
  const created = [];
  for (const n of nums) {
    const email = emailFor(n);
    const password = genPassword();
    await dirApi("POST", token, "", {
      primaryEmail: email,
      password,
      name: { givenName: "Verify", familyName: `Robot ${pad2(n)}` },
      // The robot logs in with THIS password during warming — never force a change.
      changePasswordAtNextLogin: false,
    });
    pool.identities.push({ id: idFor(n), email, profileDir: profileDirFor(n), providers: ["google"] });
    pw[email] = password;
    created.push(idFor(n));
    console.log(`created ${email}`);
    // Persist after EACH success so a mid-batch failure leaves a consistent pool.
    writeJson(POOL_PATH, pool);
    writeJson(PW_PATH, pw);
  }
  console.log(`\nDone — created: ${created.join(", ")}`);
  console.log(`Next: WARM each (automated Google login, no human):`);
  for (const id of created) console.log(`  node tools/provision-verify-robot.mjs warm ${id}`);
}

// Warm a robot's Chrome profile by driving the AUTOMATED Google login (email →
// password → new-account ToS) headed under Xvfb — fully autonomous, no human, no
// noVNC. This is the same path that warmed the original fleet (2026-06-13). The
// "never type into Google's form" guard in google-login.ts is about the SIGNUP
// bot not typing a USER's creds into a service's login; warming OUR OWN robots
// with OUR OWN known passwords (from verify-passwords.json / the vault mirror) is
// exactly what the fleet logger is for. Delegates to tools/google-login-fleet.mjs.
async function cmdWarm(id) {
  const pool = loadPool();
  const robot = pool.identities.find((e) => e.id === id);
  if (!robot) throw new Error(`${id} not in the pool (verify-identities.json). Create it first.`);
  const pw = readJson(PW_PATH, {});
  if (!pw[robot.email]) {
    console.warn(
      `WARN: no password for ${robot.email} in verify-passwords.json — the fleet logger will fail. ` +
        `(create stores it; if this robot was minted elsewhere, set VERIFY_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PW.)`,
    );
  }
  // A Directory-API-created account is UNUSABLE for OAuth (it bounces to
  // /signin/deletedaccount) until a real first sign-in completes Google's ToS —
  // `agreedToTerms` flips true only then. A never-activated account keeps a
  // stale SID from its creation that lands on myaccount.google.com, so every
  // session shortcut fires and the warm reports a FALSE ✅ without ever showing
  // the ToS page. Detect the not-yet-activated state and force the fleet logger
  // to clear the session + run the full email→password→ToS activation flow.
  // (Working robots stay on the fast path — this only triggers for the rot.)
  let forceFresh = process.env.FLEET_FORCE_FRESH === "1";
  try {
    const token = await mintAdminToken();
    const rec = await dirApi("GET", token, `/${encodeURIComponent(robot.email)}?fields=agreedToTerms,lastLoginTime`);
    const activated = rec?.agreedToTerms === true;
    if (!activated) {
      forceFresh = true;
      console.log(`  ${id}: agreedToTerms=false (never activated) — forcing a clean ToS activation login.`);
    }
  } catch (err) {
    console.warn(`  ${id}: activation precheck failed (${err instanceof Error ? err.message : String(err)}) — warming as-is.`);
  }
  console.log(`Warming ${id} (${robot.email}) via automated Google login (headed/Xvfb, no human)…`);
  const child = spawn(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), "google-login-fleet.mjs"), id],
    { stdio: "inherit", env: { ...process.env, ...(forceFresh ? { FLEET_FORCE_FRESH: "1" } : {}) } },
  );
  await new Promise((resolve, reject) => {
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`fleet login exited ${code}`))));
    child.on("error", reject);
  });
  console.log(`\n${id} warmed — its profile holds a logged-in Google session.`);
}

async function cmdDelete(id, dryRun) {
  const pool = loadPool();
  const robot = pool.identities.find((e) => e.id === id);
  if (!robot) throw new Error(`${id} not in the pool.`);
  if (dryRun) {
    console.log(`[dry-run] would DELETE ${robot.email} (Directory API) and remove its pool + password + usage rows.`);
    return;
  }
  const token = await mintAdminToken();
  await dirApi("DELETE", token, `/${encodeURIComponent(robot.email)}`);
  // Pool
  pool.identities = pool.identities.filter((e) => e.id !== id);
  writeJson(POOL_PATH, pool);
  // Password
  const pw = readJson(PW_PATH, {});
  delete pw[robot.email];
  writeJson(PW_PATH, pw);
  // Usage rows (so a re-created same id starts fresh in our notebook)
  const usage = loadUsage();
  usage.spent = (usage.spent ?? []).filter((r) => r.identityId !== id);
  writeJson(USAGE_PATH, usage);
  console.log(`deleted ${robot.email} + purged its pool/password/usage entries.`);
}

// Cost-flat rotation: retire robots and mint the SAME number of fresh ones, so
// the active count (= billed seats) never increases. DELETE-BEFORE-CREATE is the
// guarantee — the pool only ever shrinks then refills back to a target that is
// capped at POOL_CAP, so it never spikes past the cap mid-rotation.
//
//   rotate --make-room=N   retire the N MOST-SPENT robots (least remaining value)
//                          + mint N fresh → pool size unchanged. Use when a
//                          service's slots are exhausted and you need fresh ones.
//   rotate --spent-ge=K    retire every robot spent at ≥K services + refill to
//                          the current size (housekeeping the worn-out ones).
//   --target=N             explicit final size (still capped at POOL_CAP).
async function cmdRotate({ spentGe, target, makeRoom, dryRun }) {
  const pool = loadPool();
  const usage = loadUsage();
  const byRobot = servicesByRobot(usage);
  const spentOf = (id) => byRobot.get(id)?.size ?? 0;

  let retire;
  if (makeRoom !== undefined) {
    // Most-spent first = least remaining capacity = best to retire.
    retire = [...pool.identities]
      .sort((a, b) => spentOf(b.id) - spentOf(a.id))
      .slice(0, makeRoom)
      .map((e) => e.id);
  } else {
    retire = pool.identities.filter((e) => spentOf(e.id) >= spentGe).map((e) => e.id);
  }

  const keepCount = pool.identities.length - retire.length;
  // Default target keeps the pool the same size (cost-flat); always capped.
  const tgt = Math.min(target ?? pool.identities.length, POOL_CAP);
  const toCreate = Math.max(0, tgt - keepCount);

  console.log(
    makeRoom !== undefined
      ? `Rotate (make-room=${makeRoom}): retire the ${retire.length} most-spent robot(s), mint ${toCreate} fresh — ` +
          `pool stays ${pool.identities.length} (cap ${POOL_CAP}), cost flat.`
      : `Rotate: ${retire.length} robot(s) spent at ≥${spentGe} services → retire; then mint ${toCreate} to reach ${tgt} (cap ${POOL_CAP}).`,
  );
  if (retire.length > 0) {
    console.log(`  retire: ${retire.map((id) => `${id}(spent@${spentOf(id)})`).join(", ")}`);
  }
  if (dryRun) {
    console.log(`[dry-run] DELETE-before-CREATE; no API calls, no writes. Active count never exceeds ${POOL_CAP}.`);
    return;
  }
  // DELETE FIRST — frees the seats so CREATE refills under the cap.
  for (const id of retire) await cmdDelete(id, false);
  if (toCreate > 0) await cmdCreate(toCreate, false);
  if (toCreate > 0) {
    console.log(
      `\nThe ${toCreate} fresh robot(s) are UNWARMED — warm each (automated, no human) before they OAuth:`,
    );
    console.log(`  node tools/provision-verify-robot.mjs warm <verify-NN>   (or google-login-fleet.mjs <id>)`);
  }
}

// ── arg parse ──────────────────────────────────────────────────────────────
function flag(args, name) {
  return args.includes(`--${name}`);
}
function opt(args, name, dflt) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const dryRun = flag(argv, "dry-run");
  const positional = argv.slice(1).filter((a) => !a.startsWith("--"));
  switch (cmd) {
    case "list":
      await cmdList();
      break;
    case "licenses":
      await cmdLicenses(flag(argv, "apply"));
      break;
    case "create":
      if (flag(argv, "allow-grow")) {
        throw new Error("--allow-grow has been removed: verifier pool has a hard cap of 10. Use rotate instead.");
      }
      await cmdCreate(Number(positional[0] ?? "1"), dryRun);
      break;
    case "warm":
      if (!positional[0]) throw new Error("usage: warm verify-NN");
      await cmdWarm(positional[0]);
      break;
    case "delete":
      if (!positional[0]) throw new Error("usage: delete verify-NN [--dry-run]");
      await cmdDelete(positional[0], dryRun);
      break;
    case "rotate":
      await cmdRotate({
        spentGe: Number(opt(argv, "spent-ge", "40")),
        target: opt(argv, "target", undefined) !== undefined ? Number(opt(argv, "target")) : undefined,
        makeRoom: opt(argv, "make-room", undefined) !== undefined ? Number(opt(argv, "make-room")) : undefined,
        dryRun,
      });
      break;
    default:
      console.error(
        "usage: provision-verify-robot.mjs <list | licenses [--apply] | create [N] | " +
          "warm verify-NN | rotate [--make-room=N | --spent-ge=K] [--target=N] | delete verify-NN> [--dry-run]\n" +
          `hard cap = ${POOL_CAP} active robots; rotate is cost-flat (delete-before-create).`,
      );
      process.exit(64);
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
