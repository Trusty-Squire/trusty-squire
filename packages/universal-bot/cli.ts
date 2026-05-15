#!/usr/bin/env node
// CLI for the universal signup bot.
//
// Usage:
//   trusty-squire-signup <service> [signup-url]
//
// Environment:
//   ANTHROPIC_API_KEY        — required, used by the agent to plan form fills
//   TRUSTY_SQUIRE_API_URL    — defaults to https://trusty-squire-api.fly.dev
//   UNIVERSAL_BOT_API_KEY    — if set, uses production inbox (SES → API → bot)
//                              if not set, falls back to in-memory inbox
//                              (signup will work but verification won't)
//   UNIVERSAL_BOT_HEADLESS=false — show the browser window

import { randomBytes } from "crypto";
import { UniversalSignupBot, InboxClient } from "./src/index.js";
import { InboxService, InMemoryAliasStore, InMemoryEmailStore } from "@trusty-squire/inbox";
import type { AgentInbox } from "./src/index.js";

async function main(): Promise<void> {
  const service = process.argv[2];
  const signupUrl = process.argv[3];

  if (service === undefined) {
    console.error(`
Usage: trusty-squire-signup <service> [signup-url]

Examples:
  trusty-squire-signup plunk https://app.useplunk.com/signup
  trusty-squire-signup mailgun https://signup.mailgun.com/new/signup
  trusty-squire-signup ipinfo

Env vars:
  ANTHROPIC_API_KEY        — required
  UNIVERSAL_BOT_API_KEY    — if set, uses prod inbox (verification works)
  TRUSTY_SQUIRE_API_URL    — defaults to https://trusty-squire-api.fly.dev
`);
    process.exit(1);
  }

  if (process.env.ANTHROPIC_API_KEY === undefined) {
    console.error("Missing ANTHROPIC_API_KEY");
    process.exit(2);
  }

  console.log(`🤖 Signing up for ${service}...`);

  const runId = `cli-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const accountId = process.env.UNIVERSAL_BOT_ACCOUNT_ID ?? "cli-user";

  // Pick inbox: prod HTTP if API key set, otherwise in-memory.
  let inbox: AgentInbox;
  let alias: string;
  const apiKey = process.env.UNIVERSAL_BOT_API_KEY;
  if (apiKey !== undefined && apiKey !== "") {
    const baseUrl = process.env.TRUSTY_SQUIRE_API_URL ?? "https://trusty-squire-api.fly.dev";
    const client = new InboxClient({ baseUrl, apiKey });
    alias = await client.createAlias({ account_id: accountId, service, run_id: runId });
    inbox = client;
    console.log(`📧 Using prod inbox alias: ${alias}`);
    console.log(`   (mail will route: external → SES → S3 → API → /v1/inbox/wait)`);
  } else {
    const aliasStore = new InMemoryAliasStore();
    const emailStore = new InMemoryEmailStore();
    const local = new InboxService({
      aliasStore,
      emailStore,
      domain: "trustysquire.ai",
      pollIntervalMs: 1000,
    });
    alias = await local.createAlias({ account_id: accountId, service, run_id: runId });
    inbox = local;
    console.warn(`⚠ No UNIVERSAL_BOT_API_KEY — using in-memory inbox (verification disabled)`);
    console.log(`📧 Using local alias: ${alias}`);
  }

  const bot = new UniversalSignupBot();
  const result = await bot.signup({
    service,
    ...(signupUrl !== undefined ? { signupUrl } : {}),
    email: alias,
    inbox,
  });

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  if (result.success && result.credentials !== undefined) {
    console.log("✅ SUCCESS!");
    console.log("");
    console.log("**Credentials:**");
    if (result.credentials.api_key !== undefined) console.log(`  API Key:  ${result.credentials.api_key}`);
    if (result.credentials.username !== undefined) console.log(`  Username: ${result.credentials.username}`);
    if (result.credentials.password !== undefined) console.log(`  Password: ${result.credentials.password}`);
    if (result.credentials.email !== undefined) console.log(`  Email:    ${result.credentials.email}`);
  } else {
    console.log("❌ FAILED");
    console.log(`Error: ${result.error}`);
  }
  console.log("");
  console.log("**Steps:**");
  result.steps.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Revoke prod alias when done (best-effort).
  if (apiKey !== undefined && apiKey !== "" && "revokeAlias" in inbox) {
    try {
      await (inbox as InboxClient).revokeAlias(alias);
    } catch {
      // noop — alias will TTL-expire anyway
    }
  }

  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
