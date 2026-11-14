import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  chromeScopeLauncherExecutable,
  playwrightBrowsersDirectory,
  resolvePlaywrightChromiumExecutable,
  resolveSelfLaunchBinary,
} from "../browser-process-runtime.js";

const savedBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
const savedChromeBinary = process.env.UNIVERSAL_BOT_CHROME_BINARY;
const roots: string[] = [];

afterEach(() => {
  if (savedBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  else process.env.PLAYWRIGHT_BROWSERS_PATH = savedBrowsersPath;
  if (savedChromeBinary === undefined) delete process.env.UNIVERSAL_BOT_CHROME_BINARY;
  else process.env.UNIVERSAL_BOT_CHROME_BINARY = savedChromeBinary;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeChromium(root: string, revision = "1248"): string {
  const chrome = join(root, `chromium-${revision}`, "chrome-linux64", "chrome");
  mkdirSync(join(root, `chromium-${revision}`, "chrome-linux64"), { recursive: true });
  writeFileSync(chrome, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return chrome;
}

describe("playwrightBrowsersDirectory", () => {
  it("honors PLAYWRIGHT_BROWSERS_PATH over the default cache", () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = "/ms-playwright";
    expect(playwrightBrowsersDirectory()).toBe("/ms-playwright");
  });

  it("resolves a relative PLAYWRIGHT_BROWSERS_PATH against cwd", () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = "relative-browsers";
    expect(playwrightBrowsersDirectory()).toBe(join(process.cwd(), "relative-browsers"));
  });

  it("returns null for PLAYWRIGHT_BROWSERS_PATH=0 (package-local Playwright layout)", () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
    expect(playwrightBrowsersDirectory()).toBeNull();
  });
});

describe("resolvePlaywrightChromiumExecutable", () => {
  it("finds chromium under PLAYWRIGHT_BROWSERS_PATH without ~/.cache/ms-playwright", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-browsers-"));
    roots.push(root);
    const chrome = fakeChromium(root);
    mkdirSync(join(root, "chromium_headless_shell-1248", "chrome-headless-shell-linux64"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "chromium_headless_shell-1248", "chrome-headless-shell-linux64", "chrome-headless-shell"),
      "headless\n",
    );
    process.env.PLAYWRIGHT_BROWSERS_PATH = root;
    expect(resolvePlaywrightChromiumExecutable()).toBe(chrome);
  });

  it("prefers the newest chromium revision", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-browsers-"));
    roots.push(root);
    fakeChromium(root, "1000");
    const newer = fakeChromium(root, "1248");
    process.env.PLAYWRIGHT_BROWSERS_PATH = root;
    expect(resolvePlaywrightChromiumExecutable()).toBe(newer);
  });

  it("returns null when the browsers directory is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-browsers-empty-"));
    roots.push(root);
    process.env.PLAYWRIGHT_BROWSERS_PATH = root;
    expect(resolvePlaywrightChromiumExecutable()).toBeNull();
  });
});

describe("resolveSelfLaunchBinary", () => {
  it("uses PLAYWRIGHT_BROWSERS_PATH for bundled chromium before the Playwright fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-browsers-self-"));
    roots.push(root);
    const chrome = fakeChromium(root);
    process.env.PLAYWRIGHT_BROWSERS_PATH = root;
    delete process.env.UNIVERSAL_BOT_CHROME_BINARY;
    expect(resolveSelfLaunchBinary(null, () => "/from-playwright-executablePath")).toBe(chrome);
  });

  it("falls back to Playwright's executablePath when the env path has no chromium", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-browsers-miss-"));
    roots.push(root);
    process.env.PLAYWRIGHT_BROWSERS_PATH = root;
    delete process.env.UNIVERSAL_BOT_CHROME_BINARY;
    expect(resolveSelfLaunchBinary(null, () => "/from-playwright-executablePath")).toBe(
      "/from-playwright-executablePath",
    );
  });
});

describe("chromeScopeLauncherExecutable", () => {
  it("invokes a non-executable launcher through /bin/sh", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-launcher-"));
    roots.push(root);
    const source = join(root, "chrome-scope-launcher");
    const marker = join(root, "ran");
    writeFileSync(
      source,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\n`,
      { mode: 0o644 },
    );
    chmodSync(source, 0o644);
    const executable = chromeScopeLauncherExecutable(source);
    expect(executable).not.toBe(source);
    const result = spawnSync(executable, ["--from-playwright"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(readFileSync(marker, "utf8")).toBe("--from-playwright\n");
  });
});
