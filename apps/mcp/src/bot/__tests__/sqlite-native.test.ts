// Regression: npx reuses a cache whose better-sqlite3 install script never
// ran (published tarball has no build/). require() succeeds; new Database()
// throws "Could not locate the bindings file". Connect then died after
// "Browser service ready". Self-heal must rebuild once and retry; a failed
// rebuild must name `npm rebuild better-sqlite3`.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureBetterSqlite3NativeBinding,
  isSqliteNativeBindingError,
  loadNativeModuleWithHeal,
  sqliteBindingFailureMessage,
  sqliteBindingRebuildCommand,
} from "../sqlite-native.js";

const BINDINGS_ERROR = new Error(
  "Could not locate the bindings file. Tried:\n" +
    " → /cache/node_modules/better-sqlite3/build/Release/better_sqlite3.node\n" +
    " → /cache/node_modules/better-sqlite3/lib/binding/node-v137-linux-x64/better_sqlite3.node",
);

const ABI_ERROR = new Error(
  "The module '/cache/node_modules/better-sqlite3/build/Release/better_sqlite3.node' " +
    "was compiled against a different Node.js version using NODE_MODULE_VERSION 127. " +
    "This version of Node.js requires NODE_MODULE_VERSION 137.",
);

describe("isSqliteNativeBindingError", () => {
  it("matches the bindings-package missing-file error", () => {
    expect(isSqliteNativeBindingError(BINDINGS_ERROR)).toBe(true);
  });
  it("matches a Node ABI mismatch after a Node upgrade reuses the npx cache", () => {
    expect(isSqliteNativeBindingError(ABI_ERROR)).toBe(true);
  });
  it("does not swallow unrelated load failures", () => {
    expect(isSqliteNativeBindingError(new Error("Cannot find module 'better-sqlite3'"))).toBe(
      false,
    );
  });
});

describe("loadNativeModuleWithHeal", () => {
  it("returns a healthy load without rebuilding", () => {
    let rebuilt = 0;
    const Database = loadNativeModuleWithHeal({
      load: () => "ok",
      isHealable: isSqliteNativeBindingError,
      heal: () => {
        rebuilt += 1;
        return { ok: true, detail: "" };
      },
      retry: () => "retried",
      fail: (err, heal) => new Error(sqliteBindingFailureMessage(err, heal, "/pkg")),
    });
    expect(Database).toBe("ok");
    expect(rebuilt).toBe(0);
  });

  it("rebuilds once and retries after a missing native binding", () => {
    let rebuilt = 0;
    const Database = loadNativeModuleWithHeal({
      load: () => {
        throw BINDINGS_ERROR;
      },
      isHealable: isSqliteNativeBindingError,
      heal: () => {
        rebuilt += 1;
        return { ok: true, detail: "prebuild-install: downloaded" };
      },
      retry: () => "healed",
      fail: (err, heal) => new Error(sqliteBindingFailureMessage(err, heal, "/pkg")),
    });
    expect(Database).toBe("healed");
    expect(rebuilt).toBe(1);
  });

  it("rebuilds on an ABI mismatch from a reused npx cache after a Node upgrade", () => {
    const Database = loadNativeModuleWithHeal({
      load: () => {
        throw ABI_ERROR;
      },
      isHealable: isSqliteNativeBindingError,
      heal: () => ({ ok: true, detail: "" }),
      retry: () => "healed-abi",
      fail: (err, heal) => new Error(sqliteBindingFailureMessage(err, heal, "/pkg")),
    });
    expect(Database).toBe("healed-abi");
  });

  it("names npm rebuild better-sqlite3 when rebuild itself fails", () => {
    const pkgDir = "/home/u/.npm/_npx/abc/node_modules/better-sqlite3";
    expect(() =>
      loadNativeModuleWithHeal({
        load: () => {
          throw BINDINGS_ERROR;
        },
        isHealable: isSqliteNativeBindingError,
        heal: () => ({ ok: false, detail: "prebuild-install: ENOTFOUND" }),
        retry: () => "should-not-run",
        fail: (err, heal) => new Error(sqliteBindingFailureMessage(err, heal, pkgDir)),
      }),
    ).toThrow(/npm rebuild better-sqlite3 --prefix \/home\/u\/.npm\/_npx\/abc/);
  });

  it("names npm rebuild better-sqlite3 when rebuild succeeds but the retry still fails", () => {
    const pkgDir = "/home/u/.npm/_npx/abc/node_modules/better-sqlite3";
    expect(() =>
      loadNativeModuleWithHeal({
        load: () => {
          throw BINDINGS_ERROR;
        },
        isHealable: isSqliteNativeBindingError,
        heal: () => ({ ok: true, detail: "rebuilt" }),
        retry: () => {
          throw BINDINGS_ERROR;
        },
        fail: (err, heal) => new Error(sqliteBindingFailureMessage(err, heal, pkgDir)),
      }),
    ).toThrow(sqliteBindingRebuildCommand(pkgDir));
  });

  it("does not rebuild for an unrelated error", () => {
    let rebuilt = 0;
    expect(() =>
      loadNativeModuleWithHeal({
        load: () => {
          throw new Error("EACCES /tmp/lock.sqlite");
        },
        isHealable: isSqliteNativeBindingError,
        heal: () => {
          rebuilt += 1;
          return { ok: true, detail: "" };
        },
        retry: () => "nope",
        fail: (err, heal) => new Error(sqliteBindingFailureMessage(err, heal, "/pkg")),
      }),
    ).toThrow(/EACCES/);
    expect(rebuilt).toBe(0);
  });
});

describe("ensureBetterSqlite3NativeBinding", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("no-ops when the copied tree has no better-sqlite3", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-sqlite-none-"));
    dir = root;
    mkdirSync(join(root, "node_modules"), { recursive: true });
    let rebuilt = 0;
    ensureBetterSqlite3NativeBinding(join(root, "node_modules"), () => {
      rebuilt += 1;
      return { ok: true, detail: "" };
    });
    expect(rebuilt).toBe(0);
  });

  it("rebuilds a copied tree whose install script never wrote the .node", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-sqlite-missing-"));
    dir = root;
    const pkgDir = join(root, "node_modules", "better-sqlite3");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), '{"name":"better-sqlite3"}\n');
    const rebuilt: string[] = [];
    expect(() =>
      ensureBetterSqlite3NativeBinding(join(root, "node_modules"), (target) => {
        rebuilt.push(target);
        return { ok: false, detail: "no compiler" };
      }),
    ).toThrow(/npm rebuild better-sqlite3/);
    expect(rebuilt).toEqual([pkgDir]);
  });

  it("accepts a rebuild that writes the native addon", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-sqlite-heal-"));
    dir = root;
    const pkgDir = join(root, "node_modules", "better-sqlite3");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), '{"name":"better-sqlite3"}\n');
    ensureBetterSqlite3NativeBinding(join(root, "node_modules"), (target) => {
      const release = join(target, "build", "Release");
      mkdirSync(release, { recursive: true });
      writeFileSync(join(release, "better_sqlite3.node"), "");
      return { ok: true, detail: "prebuild-install" };
    });
    expect(existsSync(join(pkgDir, "build", "Release", "better_sqlite3.node"))).toBe(true);
  });

  it("still fails when rebuild claims success but wrote no .node", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-sqlite-empty-heal-"));
    dir = root;
    const pkgDir = join(root, "node_modules", "better-sqlite3");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), '{"name":"better-sqlite3"}\n');
    expect(() =>
      ensureBetterSqlite3NativeBinding(join(root, "node_modules"), () => ({
        ok: true,
        detail: "exited 0",
      })),
    ).toThrow(/Could not locate the bindings file/);
  });

  it("skips rebuild when the native addon is already present", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-sqlite-present-"));
    dir = root;
    const release = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(release, { recursive: true });
    writeFileSync(
      join(root, "node_modules", "better-sqlite3", "package.json"),
      '{"name":"better-sqlite3"}\n',
    );
    writeFileSync(join(release, "better_sqlite3.node"), "");
    let rebuilt = 0;
    ensureBetterSqlite3NativeBinding(join(root, "node_modules"), () => {
      rebuilt += 1;
      return { ok: true, detail: "" };
    });
    expect(rebuilt).toBe(0);
  });
});
