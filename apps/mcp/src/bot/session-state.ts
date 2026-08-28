import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, renameSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { BrowserContext } from "playwright";

export type BrowserStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export const SESSION_STATE_FILE = "trusty-squire-session-state.json";
export const GOOGLE_LOGIN_COOKIE_MARKERS = [
  "__Secure-1PSID",
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
] as const;

const SNAPSHOT_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { chmod, readFile, writeFile } = require("node:fs/promises");

async function run() {
  if (workerData.operation === "read") {
    const serialized = await readFile(workerData.path, "utf8");
    parentPort.postMessage({ ok: true, state: JSON.parse(serialized) });
    return;
  }
  await writeFile(workerData.path, JSON.stringify(workerData.state), { mode: 0o600 });
  await chmod(workerData.path, 0o600);
  parentPort.postMessage({ ok: true });
}

run().catch((error) => {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
});
`;

type SnapshotWorkerRequest =
  | { operation: "read"; path: string }
  | { operation: "write"; path: string; state: BrowserStorageState };

type SnapshotWorkerResponse =
  | { ok: true; state?: BrowserStorageState }
  | { ok: false; error: string };

function runSnapshotWorker(
  request: SnapshotWorkerRequest,
): Promise<BrowserStorageState | undefined> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(SNAPSHOT_WORKER_SOURCE, {
      eval: true,
      workerData: request,
    });
    let settled = false;
    worker.once("message", (response: SnapshotWorkerResponse) => {
      settled = true;
      if (response.ok) {
        resolve(response.state);
      } else {
        reject(new Error(response.error));
      }
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`storageState worker exited with code ${code}`));
    });
  });
}

export function sessionStatePath(profileDir: string): string {
  return join(profileDir, SESSION_STATE_FILE);
}

/** A private Chrome profile for exactly one operate session. */
export function createEphemeralProfile(): string {
  const profileDir = mkdtempSync(join(tmpdir(), "trusty-squire-operate-"));
  chmodSync(profileDir, 0o700);
  return profileDir;
}

export async function destroyEphemeralProfile(profileDir: string): Promise<void> {
  await rm(profileDir, { recursive: true, force: true });
}

/**
 * The canonical profile is only login authoring state. Operator sessions never
 * open it; they restore this portable Playwright snapshot into a fresh profile.
 */
export async function readSessionState(
  profileDir: string,
): Promise<BrowserStorageState | undefined> {
  const path = sessionStatePath(profileDir);
  try {
    return await runSnapshotWorker({ operation: "read", path });
  } catch {
    return undefined;
  }
}

/** Last completed snapshot wins. Rename keeps concurrent writers from corrupting it. */
export async function writeSessionState(
  profileDir: string,
  state: BrowserStorageState,
  canPublish: () => boolean = () => true,
): Promise<boolean> {
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const destination = sessionStatePath(profileDir);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await runSnapshotWorker({ operation: "write", path: temporary, state });
    if (!canPublish()) return false;
    renameSync(temporary, destination);
    published = true;
    return true;
  } finally {
    if (!published) await rm(temporary, { force: true }).catch(() => undefined);
  }
}
