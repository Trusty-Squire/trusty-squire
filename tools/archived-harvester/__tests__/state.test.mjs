import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readJson,
  writeJsonAtomic,
  readText,
  writeTextAtomic,
  appendJsonLine,
} from "../state.mjs";

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "state-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("readJson", () => {
  it("returns null when the file is missing", async () => {
    expect(await readJson(path.join(tmpDir, "absent.json"))).toBeNull();
  });

  it("returns the parsed object when the file exists", async () => {
    const target = path.join(tmpDir, "present.json");
    await fs.writeFile(target, JSON.stringify({ a: 1, b: [2, 3] }));
    expect(await readJson(target)).toEqual({ a: 1, b: [2, 3] });
  });

  it("propagates non-ENOENT errors (malformed JSON does not silently return null)", async () => {
    const target = path.join(tmpDir, "malformed.json");
    await fs.writeFile(target, "{ not valid json");
    await expect(readJson(target)).rejects.toThrow();
  });
});

describe("writeJsonAtomic", () => {
  it("creates the file and round-trips through readJson", async () => {
    const target = path.join(tmpDir, "out.json");
    await writeJsonAtomic(target, { hello: "world" });
    expect(await readJson(target)).toEqual({ hello: "world" });
  });

  it("creates parent directories as needed", async () => {
    const target = path.join(tmpDir, "nested", "deep", "out.json");
    await writeJsonAtomic(target, { ok: true });
    expect(await readJson(target)).toEqual({ ok: true });
  });

  it("overwrites an existing file", async () => {
    const target = path.join(tmpDir, "out.json");
    await writeJsonAtomic(target, { v: 1 });
    await writeJsonAtomic(target, { v: 2 });
    expect(await readJson(target)).toEqual({ v: 2 });
  });

  it("leaves no .tmp turds behind after a successful write", async () => {
    const target = path.join(tmpDir, "out.json");
    await writeJsonAtomic(target, { ok: true });
    const entries = await fs.readdir(tmpDir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });
});

describe("readText / writeTextAtomic", () => {
  it("round-trips arbitrary text", async () => {
    const target = path.join(tmpDir, "out.txt");
    await writeTextAtomic(target, "hello\nworld\n");
    expect(await readText(target)).toBe("hello\nworld\n");
  });

  it("returns null for missing text file", async () => {
    expect(await readText(path.join(tmpDir, "absent.txt"))).toBeNull();
  });
});

describe("appendJsonLine", () => {
  it("creates the file and appends lines as NDJSON", async () => {
    const target = path.join(tmpDir, "audit.jsonl");
    await appendJsonLine(target, { event: "start" });
    await appendJsonLine(target, { event: "finish", n: 2 });
    const raw = await fs.readFile(target, "utf8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { event: "start" },
      { event: "finish", n: 2 },
    ]);
  });

  it("creates parent directories", async () => {
    const target = path.join(tmpDir, "logs", "audit.jsonl");
    await appendJsonLine(target, { ok: true });
    expect(await fs.readFile(target, "utf8")).toBe('{"ok":true}\n');
  });
});
