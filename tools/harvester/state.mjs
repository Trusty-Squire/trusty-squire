// Atomic IO helpers shared by the harvester + future subagent.
//
// Atomic = write to a tempfile in the same directory, then rename.
// Same-FS rename is atomic on POSIX; placing the tempfile alongside
// the target avoids cross-FS rename failures (`/tmp` is often a
// different mount). The crash window is bounded: either the old
// file is intact (we crashed before rename) or the new file is
// intact (rename succeeded). Never a half-written target.
//
// Lock-free: single-instance is the caller's contract (systemd
// enforces). Callers that need cross-process locking should use
// `flock(1)` around their invocation, not bake locking in here.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// Read JSON or return null if the file doesn't exist. Errors other
// than ENOENT (malformed JSON, IO failure) propagate — callers
// decide whether to treat malformed state as "start fresh" or "halt
// and ask for help."
export async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await atomicWrite(filePath, JSON.stringify(value, null, 2));
}

export async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeTextAtomic(filePath, text) {
  await atomicWrite(filePath, text);
}

// Append a JSON line. Used for append-only audit logs (runs.jsonl,
// halts.jsonl). On Linux, single `appendFile` writes under PIPE_BUF
// (~4KB) are atomic; we don't expect lines this small to need
// further serialization at our cadence.
export async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(value) + "\n", "utf8");
}

async function atomicWrite(filePath, contents) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${base}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmp, contents, "utf8");
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}
