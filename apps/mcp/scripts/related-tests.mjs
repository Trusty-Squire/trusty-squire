#!/usr/bin/env node

// Direct-import test map for apps/mcp.
//
// Vitest `--related` is not usable here. provision-session.ts, browser.ts, and
// act.ts are hubs: a transitive walk collapses to ~134 test files / ~978s for
// almost any operator leaf, including card-secret-tokens.ts. This map stays
// one hop away from those hubs.
//
// A test is related to a changed source file when:
//   1. it is that file's own collocated test (foo.ts → foo.test.ts /
//      __tests__/foo.test.ts), or
//   2. it statically imports / import()s / vi.mock()s / new URL()s the file, or
//   3. it is the own test of a non-hub production module that directly
//      imports the file.
//
// REAL_BROWSER_FILES are included only when they directly import the changed
// module (AGENTS.md §14: whole files, never a test-name shard). Walking
// through a hub to reach them is how a four-line leaf fix re-pays 17 minutes.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const HUB_FILES = Object.freeze([
  "src/bot/provision-session.ts",
  "src/bot/session/lifecycle.ts",
  "src/bot/session/model.ts",
  "src/bot/browser.ts",
  "src/bot/page-driver.ts",
  "src/bot/act/act.ts",
  "src/bot/operate-drive.ts",
  "src/bot/broker/daemon.ts",
  "src/bot/broker/protocol.ts",
  "src/bot/broker/operator.ts",
  "src/tools/provision-drive.ts",
  "src/server.ts",
  "src/bin.ts",
]);

const HUB_SET = new Set(HUB_FILES);

// Fixtures live at the repo-root fixtures/ tree; serializer tests load them
// via new URL(), which the static walk already sees when the test itself
// changes, but a fixture-only edit has no importer in apps/mcp/src.
export const FIXTURE_HAND_EDGES = Object.freeze([
  {
    match(rel) {
      return (
        rel.startsWith("fixtures/browser-use/") ||
        rel === "src/bot/browser-use-serializer.ts"
      );
    },
    tests: Object.freeze([
      "src/bot/__tests__/browser-use-serializer.test.ts",
      "src/bot/__tests__/observation-byte-efficiency.test.ts",
    ]),
  },
]);

const SOURCE_WALK_ROOTS = Object.freeze(["src", "scripts"]);
const SOURCE_EXTS = new Set([".ts", ".mts", ".mjs", ".js"]);
const TEST_FILE_RE = /\.test\.(ts|mts|mjs|js)$/;

// `from "..."` covers multiline `import { ... } from` / `export { ... } from`.
// Side-effect `import "x"`, `import("x")`, and `vi.mock("x")` have no `from`.
const FROM_SPEC_RE = /\bfrom\s+["']([^"']+)["']/g;
const BARE_IMPORT_RE = /\bimport\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']/g;
const VI_MOCK_RE = /\bvi\.mock\(\s*["']([^"']+)["']/g;
const NEW_URL_RELATIVE_RE = /\bnew\s+URL\(\s*["'](\.[^"']+)["']/g;
const BARE_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*[^"'`\s]/;

export function toPosix(rel) {
  return rel.split(sep).join("/");
}

export function isTestFile(rel) {
  return TEST_FILE_RE.test(toPosix(rel));
}

export function isHubFile(rel) {
  return HUB_SET.has(toPosix(rel));
}

function isSourceFile(name) {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return SOURCE_EXTS.has(name.slice(dot));
}

export function walkSourceFiles(packageRoot) {
  const out = [];
  const visit = (absDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        visit(abs);
        continue;
      }
      if (!entry.isFile() || !isSourceFile(entry.name)) continue;
      out.push(toPosix(relative(packageRoot, abs)));
    }
  };
  for (const root of SOURCE_WALK_ROOTS) visit(join(packageRoot, root));
  return out.sort();
}

export function ownTestsFor(rel, knownFiles) {
  const posix = toPosix(rel);
  if (isTestFile(posix)) return [posix];
  const dir = dirname(posix);
  const base = posix.slice(posix.lastIndexOf("/") + 1).replace(/\.(ts|mts|mjs|js)$/, "");
  const candidates = [
    `${dir}/${base}.test.ts`,
    `${dir}/${base}.test.mts`,
    `${dir}/${base}.test.mjs`,
    `${dir}/${base}.test.js`,
    `${dir}/__tests__/${base}.test.ts`,
    `${dir}/__tests__/${base}.test.mts`,
    `${dir}/__tests__/${base}.test.mjs`,
    `${dir}/__tests__/${base}.test.js`,
  ];
  const known = new Set(knownFiles);
  return candidates.filter((candidate) => known.has(candidate));
}

function resolveExisting(abs) {
  try {
    return statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

export function resolveSpecifier(packageRoot, fromRel, spec) {
  if (!spec.startsWith(".")) return null;
  const fromAbs = join(packageRoot, fromRel);
  const raw = resolve(dirname(fromAbs), spec);
  const tries = [raw];
  if (raw.endsWith(".js")) {
    tries.push(raw.replace(/\.js$/, ".ts"), raw.replace(/\.js$/, ".mts"));
  } else if (raw.endsWith(".mjs")) {
    tries.push(raw.replace(/\.mjs$/, ".mts"), raw.replace(/\.mjs$/, ".ts"));
  } else {
    tries.push(`${raw}.ts`, `${raw}.mts`, `${raw}.mjs`, `${raw}.js`);
    tries.push(join(raw, "index.ts"), join(raw, "index.mts"), join(raw, "index.js"));
  }
  for (const candidate of tries) {
    const hit = resolveExisting(candidate);
    if (!hit) continue;
    const rel = toPosix(relative(packageRoot, hit));
    if (rel.startsWith("..")) return null;
    return rel;
  }
  return null;
}

export function extractImportSpecs(source) {
  const specs = new Set();
  const collect = (regex) => {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(source))) specs.add(match[1]);
  };
  collect(FROM_SPEC_RE);
  collect(BARE_IMPORT_RE);
  collect(DYNAMIC_IMPORT_RE);
  collect(VI_MOCK_RE);
  collect(NEW_URL_RELATIVE_RE);
  return [...specs];
}

export function hasBareDynamicImport(source) {
  return BARE_DYNAMIC_IMPORT_RE.test(source);
}

export function buildImportGraph(packageRoot) {
  const files = walkSourceFiles(packageRoot);
  /** @type {Map<string, Set<string>>} */
  const imports = new Map();
  /** @type {Map<string, Set<string>>} */
  const importers = new Map();
  /** @type {Set<string>} */
  const bareDynamicImporters = new Set();

  const addEdge = (from, to) => {
    if (!imports.has(from)) imports.set(from, new Set());
    if (!importers.has(to)) importers.set(to, new Set());
    imports.get(from).add(to);
    importers.get(to).add(from);
  };

  for (const rel of files) {
    if (!imports.has(rel)) imports.set(rel, new Set());
    const source = readFileSync(join(packageRoot, rel), "utf8");
    if (hasBareDynamicImport(source)) bareDynamicImporters.add(rel);
    for (const spec of extractImportSpecs(source)) {
      const resolved = resolveSpecifier(packageRoot, rel, spec);
      if (resolved) addEdge(rel, resolved);
    }
  }

  return { files, imports, importers, bareDynamicImporters };
}

function normalizeChanged(rel, packageRoot) {
  const posix = toPosix(rel).replace(/^\.\//, "");
  if (existsSync(join(packageRoot, posix))) return posix;
  const underSrc = posix.startsWith("apps/mcp/") ? posix.slice("apps/mcp/".length) : posix;
  if (existsSync(join(packageRoot, underSrc))) return underSrc;
  return posix;
}

export function loadListedTierFiles(packageRoot, exportName) {
  const source = readFileSync(join(packageRoot, "vitest.tiers.ts"), "utf8");
  const block = source.match(new RegExp(`export const ${exportName} = \\[([\\s\\S]*?)\\];`));
  if (!block) return [];
  return [...block[1].matchAll(/"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((file) => existsSync(join(packageRoot, file)));
}

export function loadRealBrowserFiles(packageRoot) {
  return loadListedTierFiles(packageRoot, "REAL_BROWSER_FILES");
}

export function applyFixtureHandEdges(changedRel, knownFiles) {
  const tests = [];
  const known = new Set(knownFiles);
  for (const edge of FIXTURE_HAND_EDGES) {
    if (!edge.match(changedRel)) continue;
    for (const test of edge.tests) {
      if (known.has(test)) tests.push(test);
    }
  }
  return tests;
}

/**
 * Direct-import selection only. Does not decide fail-closed fallbacks;
 * an empty set means "could not prove a related test", not "run nothing".
 */
export function selectDirectImportTests({
  packageRoot,
  changedFiles,
  graph,
  realBrowserFiles = [],
}) {
  const realBrowser = new Set(realBrowserFiles.filter((file) => existsSync(join(packageRoot, file))));
  const selected = new Set();
  const notes = [];

  for (const raw of changedFiles) {
    const changed = normalizeChanged(raw, packageRoot);
    if (!graph.files.includes(changed) && !changed.startsWith("fixtures/")) {
      notes.push(`unmapped:${changed}`);
      continue;
    }

    if (isTestFile(changed) && graph.files.includes(changed)) {
      selected.add(changed);
    }

    for (const own of ownTestsFor(changed, graph.files)) selected.add(own);

    const directImporters = graph.importers.get(changed) ?? new Set();
    for (const importer of directImporters) {
      if (isTestFile(importer)) {
        // Direct test importers run even when they are real-browser files.
        selected.add(importer);
        continue;
      }
      if (isHubFile(importer)) {
        notes.push(`skipped-hub-hop:${importer}`);
        continue;
      }
      // One hop: the caller's own collocated test, not every test that
      // imports the caller. A real-browser own-test is included only when
      // that file also directly imports the changed module.
      for (const own of ownTestsFor(importer, graph.files)) {
        if (realBrowser.has(own) && !directImporters.has(own)) continue;
        selected.add(own);
      }
    }

    for (const test of applyFixtureHandEdges(changed, graph.files)) selected.add(test);
  }

  return {
    tests: [...selected].sort(),
    notes,
  };
}
