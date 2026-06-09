#!/usr/bin/env node
// Independent Gmail IMAP credential check — isolates "is the app password
// valid?" from "is the Fly secret set?" and from any signup flow.
//
// Usage (creds never touch disk/git — pass them inline):
//   GMAIL_USER=lunchboxfortwo@gmail.com \
//   GMAIL_APP_PASSWORD='xxxx xxxx xxxx xxxx' \
//   node tools/test-gmail-imap.mjs
//
// Reads imapflow from apps/api's node_modules (already a dependency there).
// Exit 0 + "OK" means the password is valid and IMAP works. Any other output
// prints Gmail's EXACT rejection (auth failed / app-password invalid / IP
// blocked) instead of the opaque "Command failed" the API surfaces.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, "..", "apps", "api", "package.json"));

const user = process.env.GMAIL_USER;
const pass = process.env.GMAIL_APP_PASSWORD;
if (!user || !pass) {
  console.error("Set GMAIL_USER and GMAIL_APP_PASSWORD in the environment.");
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
