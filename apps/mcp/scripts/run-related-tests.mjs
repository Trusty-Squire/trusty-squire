#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildImportGraph,
  loadRealBrowserFiles,
  selectDirectImportTests,
} from "./related-tests.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const files = [];
  let printOnly = false;
  let run = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--print") {
      printOnly = true;
      run = false;
    } else if (arg === "--run") {
      run = true;
    } else if (arg === "--files") {
      continue;
    } else if (arg.startsWith("-")) {
      console.error(`unknown flag: ${arg}`);
      process.exit(2);
    } else {
      files.push(arg);
    }
  }
  return { files, printOnly, run };
}

function runVitest(files) {
  return new Promise((resolveExit) => {
    const child = spawn("pnpm", ["exec", "vitest", "run", "--config", "vitest.config.ts", ...files], {
      cwd: packageRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", (error) => {
      console.error(error.message);
      resolveExit(1);
    });
    child.on("exit", (code, signal) => {
      if (signal !== null) console.error(`vitest terminated by ${signal}`);
      resolveExit(code ?? 1);
    });
  });
}

const { files, printOnly, run } = parseArgs(process.argv.slice(2));
if (files.length === 0) {
  console.error("usage: node scripts/run-related-tests.mjs [--print|--run] [--files] <changed...>");
  console.error("Do not pass this through `vitest related`. The transitive graph is the operator cone.");
  process.exit(2);
}

const graph = buildImportGraph(packageRoot);
const selected = selectDirectImportTests({
  packageRoot,
  changedFiles: files,
  graph,
  realBrowserFiles: loadRealBrowserFiles(packageRoot),
});

const payload = {
  changed: files,
  tests: selected.tests,
  notes: selected.notes,
};
console.log(JSON.stringify(payload, null, 2));

if (selected.tests.length === 0) {
  // Empty is not "skip tests". The fail-closed planner (run-validation-tests)
  // maps this to test:fast. This CLI refuses so a raw invocation cannot
  // silently drop coverage.
  console.error("related-tests: empty selection; cannot prove irrelevance");
  process.exit(2);
}

if (printOnly || !run) process.exit(0);
process.exitCode = await runVitest(selected.tests);
