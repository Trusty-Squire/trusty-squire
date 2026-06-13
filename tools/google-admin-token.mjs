#!/usr/bin/env node
// google-admin-token.mjs — mint a Google Workspace Admin SDK access token from a
// SERVICE-ACCOUNT key with domain-wide delegation, fully autonomously (no
// interactive consent, no 1-hour-expiry token-paste dance).
//
//   node tools/google-admin-token.mjs            # prints an access token
//   ACCESS=$(node tools/google-admin-token.mjs)  # use in a curl/mint
//
// WHY this exists: the vault is write-only to the agent (can't read/recombine a
// refresh token + client secret), and admin.directory is a restricted scope
// (a NEW refresh token needs one-time super-admin consent). A service account
// with domain-wide delegation sidesteps both: it impersonates an admin via a
// signed JWT bearer assertion — Google issues a fresh ~1h token each call, so
// the agent re-mints on demand and never asks for a token again.
//
// ONE-TIME operator setup (the irreducible step — needs GCP + Workspace admin,
// which the agent has no credentials for):
//   1. GCP console → IAM & Admin → Service Accounts → create one → add a JSON key.
//   2. Note the service account's Client ID (numeric, "Unique ID").
//   3. Admin console → Security → API controls → Domain-wide delegation →
//      Add new → that Client ID, scope:
//        https://www.googleapis.com/auth/admin.directory.user
//   4. Drop the JSON key at ~/.trusty-squire/admin-sa.json (chmod 600).
// After that, every mint/login/sweep is autonomous.
//
// Config (env overrides): the SA key path and the admin to impersonate.
//   GOOGLE_ADMIN_SA_KEY   (default ~/.trusty-squire/admin-sa.json)
//   GOOGLE_ADMIN_SUBJECT  (default lunchbox@trustysquire.ai — must be a super admin)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSign } from "node:crypto";

const KEY_PATH = process.env.GOOGLE_ADMIN_SA_KEY ?? join(homedir(), ".trusty-squire", "admin-sa.json");
const SUBJECT = process.env.GOOGLE_ADMIN_SUBJECT ?? "lunchbox@trustysquire.ai";
const SCOPE = "https://www.googleapis.com/auth/admin.directory.user";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function mintAdminToken() {
  let sa;
  try {
    sa = JSON.parse(readFileSync(KEY_PATH, "utf8"));
  } catch (err) {
    throw new Error(
      `service-account key not found/readable at ${KEY_PATH} ` +
        `(${err instanceof Error ? err.message : String(err)}). See the one-time setup in this file's header.`,
    );
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error(`${KEY_PATH} is missing client_email / private_key — not a valid SA key JSON`);
  }
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      sub: SUBJECT, // impersonate the super admin (domain-wide delegation)
      scope: SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = b64url(createSign("RSA-SHA256").update(signingInput).sign(sa.private_key));
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(
      `token exchange failed (${res.status}): ${JSON.stringify(body)}. ` +
        `Common cause: domain-wide delegation not authorized for this SA's client id + scope, ` +
        `or GOOGLE_ADMIN_SUBJECT (${SUBJECT}) is not a super admin.`,
    );
  }
  return body.access_token;
}

// CLI: print the token (so `ACCESS=$(node tools/google-admin-token.mjs)` works).
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.stdout.write((await mintAdminToken()) + "\n");
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
