#!/usr/bin/env node
// google-login-fleet.mjs — sign the verify-fleet robots into their browser
// profiles (one-time, or to refresh an expired session).
//
//   node tools/google-login-fleet.mjs --all
//   node tools/google-login-fleet.mjs verify-03
//
// Each robot is a Cloud Identity Free Google account (2SV off) whose profile
// lives at ~/.trusty-squire/profiles/<id>. This drives the real Google login
// (email -> password -> new-account ToS) headed under Xvfb through the
// fleet egress, so the OAuth-first signup path later reuses the session.
//
// Identities come from ~/.trusty-squire/verify-identities.json (the pool config).
// Passwords come from ~/.trusty-squire/verify-passwords.json (operator-local,
// chmod 600, gitignored — NEVER hardcode them here) or the per-id env override
// VERIFY_<ID>_PW. The canonical password store is the vault credential
// `trustysquire-verify-bots`; this local file is the operator-box mirror the
// CLI reads (same pattern as harvester.env).
//
// Gotchas baked in (learned 2026-06-13):
//   - hl=en is REQUIRED — a foreign-IP egress makes Google localize, which
//     breaks the ToS-button text match.
//   - the per-launch proxy must be FORCED on (the box ASN reads "unknown" so
//     the ASN gate would otherwise skip it) — we set proxyUrl explicitly +
//     UNIVERSAL_BOT_PROXY_ALWAYS.
//   - Google's email field is #identifierId (type=text), NOT input[type=email].

import { BrowserController } from "../apps/mcp/dist/bot/browser.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.TRUSTY_SQUIRE_VERIFY_POOL_DIR ?? join(homedir(), ".trusty-squire");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadIdentities() {
  const raw = JSON.parse(readFileSync(join(BASE, "verify-identities.json"), "utf8"));
  return (raw.identities ?? []).map((i) => ({
    ...i,
    profileDir: i.profileDir.startsWith("~/") ? join(homedir(), i.profileDir.slice(2)) : i.profileDir,
  }));
}
function loadPasswords() {
  try {
    return JSON.parse(readFileSync(join(BASE, "verify-passwords.json"), "utf8"));
  } catch {
    return {};
  }
}
function passwordFor(identity, passwords) {
  const envKey = `VERIFY_${identity.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PW`;
  return process.env[envKey] ?? passwords[identity.email] ?? null;
}

async function loginOne(identity, password) {
  const out = { id: identity.id, email: identity.email, stages: [] };
  const bc = new BrowserController({
    profileDir: identity.profileDir,
    humanize: true,
    ...(identity.proxyUrl !== undefined ? { proxyUrl: identity.proxyUrl } : {}),
  });
  try {
    await bc.start();
    const page = bc["page"];
    await page.goto(
      "https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn&hl=en&continue=https%3A%2F%2Fmyaccount.google.com%2F",
      { waitUntil: "domcontentloaded", timeout: 45000 },
    );
    await sleep(4500);
    // Cookie-consent wall.
    await page
      .evaluate(() => {
        const want = /^(accept all|i agree|agree|accept|reject all)$/i;
        for (const b of document.querySelectorAll("button,[role=button]")) {
          if (want.test((b.textContent || "").trim())) { b.click(); return; }
        }
      })
      .catch(() => {});
    await sleep(1500);
    // Already signed in?
    const cookiesNow = await bc["context"].cookies();
    if (cookiesNow.some((c) => /^(SID|__Secure-1PSID|SAPISID|__Secure-3PSID)$/.test(c.name) && c.value.length > 5)) {
      out.stages.push("already-signed-in");
      out.loggedIn = true;
      await bc.close().catch(() => {});
      return out;
    }
    // Email — #identifierId, not input[type=email].
    const EMAIL = '#identifierId, input[name="identifier"], input[type="email"]';
    await page.waitForSelector(EMAIL, { state: "visible", timeout: 15000 });
    await page.fill(EMAIL, identity.email);
    out.stages.push("email");
    await sleep(400);
    await page.keyboard.press("Enter");
    await sleep(6500);
    // Password.
    const PW = 'input[type="password"][name="Passwd"], input[type="password"]';
    await page.waitForSelector(PW, { state: "visible", timeout: 15000 });
    await page.fill(PW, password);
    out.stages.push("password");
    await sleep(400);
    await page.keyboard.press("Enter");
    await sleep(8000);
    // New-account ToS speedbump + follow-ons — patient (renders a few s later).
    for (let i = 0; i < 8; i++) {
      const clicked = await page
        .evaluate(() => {
          const want = /^(not now|skip|confirm|i understand|i agree|accept|agree|got it|continue|done|maybe later|next)$/i;
          for (const b of document.querySelectorAll("button,[role=button],a,input[type=submit]")) {
            const t = (b.textContent || b.value || "").trim();
            if (want.test(t)) { b.click(); return t; }
          }
          return null;
        })
        .catch(() => null);
      if (clicked) { out.stages.push(`post:${clicked}`); await sleep(4000); }
      else { if (/myaccount\.google\.com/.test(page.url())) break; await sleep(3000); }
    }
    await sleep(2000);
    out.finalUrl = page.url();
    const cookies = await bc["context"].cookies();
    out.loggedIn = cookies.some((c) => /^(SID|__Secure-1PSID|SAPISID|__Secure-3PSID)$/.test(c.name) && c.value.length > 5);
  } catch (e) {
    out.error = String((e && e.stack) || e).slice(0, 240);
  }
  await bc.close().catch(() => {});
  return out;
}

const arg = process.argv[2];
if (arg === undefined) {
  console.error("usage: node tools/google-login-fleet.mjs --all | <identity-id>");
  process.exit(2);
}
// Force the proxy on for these logins (box ASN reads 'unknown').
process.env.UNIVERSAL_BOT_PROXY_ALWAYS = "true";
const identities = loadIdentities();
const passwords = loadPasswords();
const targets = arg === "--all" ? identities : identities.filter((i) => i.id === arg);
if (targets.length === 0) {
  console.error(`no identity matches "${arg}" in verify-identities.json`);
  process.exit(1);
}
let failed = 0;
for (const identity of targets) {
  const pw = passwordFor(identity, passwords);
  if (pw === null) {
    console.log(`${identity.id}: ❌ no password (set ${identity.email} in verify-passwords.json or VERIFY_*_PW)`);
    failed++;
    continue;
  }
  const r = await loginOne(identity, pw);
  console.log(`${identity.id.padEnd(11)} ${r.loggedIn ? "✅ logged in" : "❌ " + (r.error || JSON.stringify(r.stages))}`);
  if (!r.loggedIn) failed++;
}
process.exit(failed > 0 ? 1 : 0);
