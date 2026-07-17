#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverBin = path.join(packageRoot, "dist", "bin.js");
const version = spawnSync("opencode", ["--version"], { encoding: "utf8" });

if (version.error?.code === "ENOENT") {
  console.log("SKIP: OpenCode is not installed; install it to run the compatibility smoke test.");
  process.exit(0);
}
if (version.status !== 0) {
  process.stderr.write(version.stderr || "OpenCode version check failed.\n");
  process.exit(version.status ?? 1);
}
if (!existsSync(serverBin)) {
  console.error("Missing dist/bin.js. Run `pnpm --filter @trusty-squire/mcp build` first.");
  process.exit(1);
}

const isolatedHome = mkdtempSync(path.join(tmpdir(), "ts-opencode-smoke-"));
try {
  const env = {
    ...process.env,
    HOME: isolatedHome,
    XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        squire_smoke: {
          type: "local",
          command: [process.execPath, serverBin, "server"],
          environment: { TRUSTY_SQUIRE_AGENT_IDENTITY: "opencode-smoke" },
          enabled: true,
          timeout: 30_000,
        },
      },
    }),
  };
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_DIR;

  const result = spawnSync("opencode", ["mcp", "list", "--pure"], {
    env,
    encoding: "utf8",
    timeout: 45_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  if (result.status !== 0 || !/squire_smoke\s+connected/.test(plain)) {
    process.stderr.write(output);
    console.error("OpenCode did not report the Trusty Squire MCP server as connected.");
    process.exit(result.status ?? 1);
  }
  process.stdout.write(output);
  console.log(`PASS: OpenCode ${version.stdout.trim()} connected to Trusty Squire over stdio.`);
} finally {
  rmSync(isolatedHome, { recursive: true, force: true });
}
