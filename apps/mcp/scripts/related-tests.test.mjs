import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildImportGraph,
  extractImportSpecs,
  hasBareDynamicImport,
  HUB_FILES,
  isHubFile,
  loadRealBrowserFiles,
  ownTestsFor,
  resolveSpecifier,
  selectDirectImportTests,
} from "./related-tests.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const graph = buildImportGraph(packageRoot);
const realBrowserFiles = loadRealBrowserFiles(packageRoot);

function select(changed) {
  return selectDirectImportTests({
    packageRoot,
    changedFiles: Array.isArray(changed) ? changed : [changed],
    graph,
    realBrowserFiles,
  });
}

describe("direct-import selection", () => {
  it("maps a card-secret-tokens leaf to its own test and direct importers only", () => {
    const { tests, notes } = select("src/bot/card-secret-tokens.ts");
    expect(tests).toEqual([
      "src/bot/__tests__/card-secret-tokens.test.ts",
      "src/tools/__tests__/inject-card-result.test.ts",
    ]);
    expect(notes).toContain("skipped-hub-hop:src/bot/act/act.ts");
    expect(tests.some((file) => file.includes("oauth-login"))).toBe(false);
    expect(tests.some((file) => file.includes("operate-drive-fixture"))).toBe(false);
    expect(tests.some((file) => file.includes("browser-hosted-field-remount"))).toBe(false);
    expect(tests.some((file) => file.includes("browser-inject-card"))).toBe(false);
  });

  it("does not walk through provision-session into the operator cone", () => {
    const { tests } = select("src/bot/card-secret-tokens.ts");
    expect(tests).not.toContain("src/bot/__tests__/oauth-login.test.ts");
    expect(tests.length).toBeLessThan(10);
  });

  it("keeps one hop of non-hub production callers and their own tests", () => {
    const { tests, notes } = select("src/bot/credential-shape.ts");
    expect(tests).toContain("src/bot/__tests__/credential-shape.test.ts");
    expect(tests).toContain("src/bot/__tests__/provision-session.test.ts");
    expect(tests).toContain("src/bot/capture/__tests__/capture.test.ts");
    expect(tests).toContain("src/bot/capture/__tests__/verification.test.ts");
    expect(notes).toContain("skipped-hub-hop:src/tools/provision-drive.ts");
    expect(tests).not.toContain("src/bot/capture/__tests__/credential-capture-browser.test.ts");
    expect(tests).not.toContain("src/bot/__tests__/oauth-login.test.ts");
  });

  it("follows a new URL worker edge from owner-process-reaper", () => {
    const specs = extractImportSpecs(
      [
        'import { fileURLToPath } from "node:url";',
        'const compiled = fileURLToPath(new URL("./owner-process-reaper-worker.js", import.meta.url));',
        'const source = fileURLToPath(new URL("./owner-process-reaper-worker.ts", import.meta.url));',
      ].join("\n"),
    );
    expect(specs).toEqual([
      "node:url",
      "./owner-process-reaper-worker.js",
      "./owner-process-reaper-worker.ts",
    ]);
    expect(
      resolveSpecifier(
        packageRoot,
        "src/bot/owner-process-reaper.ts",
        "./owner-process-reaper-worker.ts",
      ),
    ).toBe("src/bot/owner-process-reaper-worker.ts");
    const { tests } = select("src/bot/owner-process-reaper-worker.ts");
    expect(tests).toContain("src/bot/__tests__/owner-process-reaper.test.ts");
  });

  it("treats vi.mock as a direct import and ignores missing ghost tier paths", () => {
    expect(realBrowserFiles).not.toContain("src/bot/__tests__/autocomplete-commit-confirm.test.ts");
    expect(realBrowserFiles.every((file) => file.endsWith(".test.ts"))).toBe(true);
    const specs = extractImportSpecs('vi.mock("../provision-session.js", async (importOriginal) => ({}));');
    expect(specs).toEqual(["../provision-session.js"]);
  });

  it("does not treat runtime new URL(pageUrl) as a module edge", () => {
    expect(extractImportSpecs("const host = new URL(url).hostname;")).toEqual([]);
  });

  it("flags a bare dynamic import as unprovable", () => {
    expect(hasBareDynamicImport('await import(variableName)')).toBe(true);
    expect(hasBareDynamicImport('await import("./inject-card.js")')).toBe(false);
  });

  it("names collocated own tests only, not every test in the directory", () => {
    expect(ownTestsFor("src/bot/capture/capture.ts", graph.files)).toEqual([
      "src/bot/capture/__tests__/capture.test.ts",
    ]);
  });

  it("knows the hub overlay list the fail-closed planner will use", () => {
    expect(HUB_FILES).toContain("src/bot/provision-session.ts");
    expect(HUB_FILES).toContain("src/bot/browser.ts");
    expect(isHubFile("src/bot/card-secret-tokens.ts")).toBe(false);
  });
});
