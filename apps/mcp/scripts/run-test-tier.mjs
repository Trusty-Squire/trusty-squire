#!/usr/bin/env node

import { spawn } from "node:child_process";

const tier = process.argv[2];
if (tier !== "fast" && tier !== "slow") {
  console.error("usage: node scripts/run-test-tier.mjs <fast|slow>");
  process.exit(2);
}

function runVitest(name, config) {
  console.log(`\n=== ${name} ===`);
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["exec", "vitest", "run", "--config", config], {
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", (error) => {
      console.error(`${name}: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal !== null) console.error(`${name}: terminated by ${signal}`);
      resolve(code ?? 1);
    });
  });
}

const groups =
  tier === "slow"
    ? [["slow post-merge tier", "vitest.slow.config.ts"]]
    : [
        ["fast core", "vitest.fast-core.config.ts"],
        ["required behavior", "vitest.behavior-required.config.ts"],
        ["required payment safety", "vitest.payment-required.config.ts"],
      ];

// These suites include real-browser and process-lifecycle tests whose bounded
// timers must be able to run. Starting all three Vitest processes together can
// starve those timers on constrained CI runners, turning correct timeout
// behavior into intermittent test failures. Run every group, one at a time.
const results = [];
for (const [name, config] of groups) {
  results.push(await runVitest(name, config));
}
process.exitCode = results.some((code) => code !== 0) ? 1 : 0;
