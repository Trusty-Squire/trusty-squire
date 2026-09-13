import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { forwarderId, requireLineageCredential } from "../broker/lineage.js";
import { DispatchJournal } from "../broker/dispatch-journal.js";

const require = createRequire(import.meta.url);
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function profile(): string {
  const root = mkdtempSync(join(tmpdir(), "ts-lineage-"));
  roots.push(root);
  return root;
}
function restartedCredential(root: string): string {
  return execFileSync(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      "--input-type=module",
      "-e",
      `import { requireLineageCredential } from ${JSON.stringify(new URL("../broker/lineage.ts", import.meta.url).href)};
     process.stdout.write(requireLineageCredential());`,
    ],
    { encoding: "utf8", env: { ...process.env, TRUSTY_SQUIRE_PROFILE_DIR: root } },
  );
}
it("retains a default lineage across process restarts and finds its unresolved journal", async () => {
  vi.stubEnv("TRUSTY_SQUIRE_FORWARDER_CREDENTIAL", undefined);
  const root = profile();
  const first = restartedCredential(root);
  const journal = new DispatchJournal(join(root, "dispatch.jsonl"));
  await journal.record("session", "payment", "entered", {
    forwarderId: forwarderId(first),
    operation: "operate_pay",
    inputHash: "input",
  });
  const second = restartedCredential(root);
  expect(second).toBe(first);
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(statSync(join(root, "trusty-squire-forwarders", "0", "credential")).mode & 0o777).toBe(
    0o600,
  );
  expect(await journal.hasOutstanding(undefined, forwarderId(second))).toBe(true);
  await journal.record("session", "payment", "settled");
  expect(await journal.hasOutstanding(undefined, forwarderId(second))).toBe(false);
});
it("recovers the retained lineage after a process is killed without releasing its lease", () => {
  vi.stubEnv("TRUSTY_SQUIRE_FORWARDER_CREDENTIAL", undefined);
  const root = profile();
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      "--input-type=module",
      "-e",
      `import { requireLineageCredential } from ${JSON.stringify(new URL("../broker/lineage.ts", import.meta.url).href)};
     import { writeSync } from "node:fs";
     writeSync(1, requireLineageCredential());
     process.kill(process.pid, "SIGKILL");`,
    ],
    { encoding: "utf8", env: { ...process.env, TRUSTY_SQUIRE_PROFILE_DIR: root } },
  );
  expect(child.signal).toBe("SIGKILL");
  expect(child.stdout).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(restartedCredential(root)).toBe(child.stdout);
});
it("keeps live sibling processes independent while reusing a retired sibling slot", () => {
  vi.stubEnv("TRUSTY_SQUIRE_FORWARDER_CREDENTIAL", undefined);
  const root = profile();
  const first = requireLineageCredential(root);
  const sibling = restartedCredential(root);
  expect(sibling).not.toBe(first);
  expect(restartedCredential(root)).toBe(sibling);
  expect(requireLineageCredential(root)).toBe(first);
});
it("refuses a corrupt retained credential instead of losing journal identity", () => {
  vi.stubEnv("TRUSTY_SQUIRE_FORWARDER_CREDENTIAL", undefined);
  const root = profile();
  restartedCredential(root);
  writeFileSync(join(root, "trusty-squire-forwarders", "0", "credential"), "short");
  expect(() => requireLineageCredential(root)).toThrow("unguessable");
});
it("preserves an explicit restart credential and refuses malformed credentials", () => {
  vi.stubEnv("TRUSTY_SQUIRE_FORWARDER_CREDENTIAL", "a".repeat(43));
  expect(requireLineageCredential()).toBe("a".repeat(43));
  vi.stubEnv("TRUSTY_SQUIRE_FORWARDER_CREDENTIAL", "short");
  expect(() => requireLineageCredential()).toThrow("unguessable");
});
