#!/usr/bin/env node
// Independent operator-IMAP credential check — isolates "is the app password
// valid?" from "is the Fly secret set?" and from any signup flow. The operator
// IMAP identity is a Google account (Workspace lunchbox@trustysquire.ai),
// served by imap.gmail.com.
//
// Usage (creds never touch disk/git — pass them inline):
//   OPERATOR_IMAP_USER=lunchbox@trustysquire.ai \
//   OPERATOR_IMAP_PASSWORD='xxxx xxxx xxxx xxxx' \
//   node tools/test-operator-imap.mjs
//   (legacy GMAIL_USER / GMAIL_APP_PASSWORD are also accepted)
//
// Reads imapflow from apps/api's node_modules (already a dependency there).
// Exit 0 + "OK" means the password is valid and IMAP works. Any other output
// prints Google's EXACT rejection (auth failed / app-password invalid / IP
// blocked) instead of the opaque "Command failed" the API surfaces.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, "..", "apps", "api", "package.json"));

const user = process.env.OPERATOR_IMAP_USER ?? process.env.GMAIL_USER;
const pass = process.env.OPERATOR_IMAP_PASSWORD ?? process.env.GMAIL_APP_PASSWORD;
if (!user || !pass) {
  console.error("Set OPERATOR_IMAP_USER and OPERATOR_IMAP_PASSWORD (or legacy GMAIL_USER / GMAIL_APP_PASSWORD).");
  process.exit(2);
}

let ImapFlow;
try {
  ({ ImapFlow } = require("imapflow"));
} catch {
  console.error("Could not load imapflow — run `pnpm -F @trusty-squire/api install` first.");
  process.exit(2);
}

const client = new ImapFlow({
  host: "imap.gmail.com",
  port: 993,
  secure: true,
  auth: { user, pass: pass.replace(/\s+/g, "") }, // Google shows app pw with spaces
  logger: false,
});

try {
  await client.connect();
  console.log(`OK — authenticated to imap.gmail.com as ${user}`);
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = await client.search({ since: new Date(Date.now() - 3600_000) }, { uid: true });
    console.log(`OK — INBOX searchable; ${Array.isArray(uids) ? uids.length : 0} message(s) in the last hour`);
  } finally {
    lock.release();
  }
  await client.logout();
  process.exit(0);
} catch (err) {
  // Surface Gmail's real response, not just err.message.
  const e = /** @type {any} */ (err);
  console.error("FAILED:", e?.message ?? String(err));
  if (e?.responseText) console.error("  serverResponse:", e.responseText);
  if (e?.serverResponseCode) console.error("  responseCode:", e.serverResponseCode);
  if (e?.authenticationFailed) console.error("  authenticationFailed: true (app password invalid/expired — regenerate at myaccount.google.com → App passwords)");
  try { await client.logout(); } catch { /* ignore */ }
  process.exit(1);
}
