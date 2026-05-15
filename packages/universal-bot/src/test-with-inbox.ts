// Test universal bot with inbox service
// Demonstrates email verification flow

import { InboxService } from "@trusty-squire/inbox";
import { InMemoryAliasStore, InMemoryEmailStore } from "@trusty-squire/inbox";
import { UniversalSignupBot } from "./index.js";

async function main() {
  const serviceName = process.argv[2] || "postmark";
  const signupUrl = process.argv[3];

  console.log(`Testing universal bot for: ${serviceName}`);
  console.log(`With email verification support enabled`);

  // Set up in-memory inbox
  const aliasStore = new InMemoryAliasStore();
  const emailStore = new InMemoryEmailStore();
  const inbox = new InboxService({
    aliasStore,
    emailStore,
    domain: "trustysquire.ai",
  });

  // Create an email alias for this signup
  const alias = await inbox.createAlias({
    account_id: "test-account",
    service: serviceName,
    run_id: "test-run",
  });

  console.log(`Using email alias: ${alias}`);

  // Run the bot
  const bot = new UniversalSignupBot();
  const result = await bot.signup({
    service: serviceName,
    signupUrl,
    email: alias,
    inbox,
  });

  console.log("\n=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));

  if (result.success) {
    console.log("\n✅ SUCCESS!");
    console.log("Credentials:", result.credentials);
  } else {
    console.log("\n❌ FAILED");
    console.log("Error:", result.error);
  }

  console.log("\nSteps taken:");
  result.steps.forEach((step, i) => {
    console.log(`  ${i + 1}. ${step}`);
  });

  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
