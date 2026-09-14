import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { forwarderId, requireLineageCredential } from "../broker/lineage.js";
import { BrokerAuthority } from "../broker/authority.js";
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
function restartedCredential(root: string, crash = false): string {
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
     ${crash ? 'process.kill(process.pid, "SIGKILL");' : ""}`,
    ],
    { encoding: "utf8", env: { ...process.env, TRUSTY_SQUIRE_PROFILE_DIR: root } },
  );
  if (crash) expect(child.signal).toBe("SIGKILL");
  else expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return child.stdout;
}
it("keeps its default credential in memory for the process lifetime", () => {
  vi.stubEnv("TRUSTY_SQUIRE_FORWARDER_CREDENTIAL", undefined);
  const first = requireLineageCredential();
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(requireLineageCredential()).toBe(first);
});
it("never reassigns crashed sibling lineages or their capabilities to restarted processes", async () => {
  vi.stubEnv("TRUSTY_SQUIRE_FORWARDER_CREDENTIAL", undefined);
  const root = profile();
  const oldSlot = join(root, "trusty-squire-forwarders", "0");
  mkdirSync(oldSlot, { recursive: true });
  writeFileSync(join(oldSlot, "credential"), "z".repeat(43));
  const credentials = [restartedCredential(root, true), restartedCredential(root, true)];
  const broker = new BrokerAuthority("account");
  const journal = new DispatchJournal(join(root, "dispatch.jsonl"));
  const owners = credentials.map((credential, index) => ({
    accountId: "account",
    agentId: "local-agent",
    clientId: String(index),
    forwarderId: forwarderId(credential),
  }));
  const capabilities = [];
  for (const owner of owners) {
    await broker.claimForwarder(owner);
    const capability = await broker.open(owner, async () => ({
      targetId: owner.clientId,
      invoke: async () => "owned",
      close: async () => true,
      orphan: async () => undefined,
    }));
    capabilities.push(capability);
    await journal.record(capability, owner.clientId, "entered", {
      forwarderId: owner.forwarderId,
      operation: "operate_pay",
      inputHash: "input",
    });
    broker.detach(owner);
    broker.releaseForwarder(owner);
  }
  const replacements = [restartedCredential(root), restartedCredential(root)];
  expect(new Set([...credentials, ...replacements, "z".repeat(43)]).size).toBe(5);
  for (const [index, credential] of replacements.entries()) {
    const replacement = {
      ...owners[index]!,
      clientId: `restart-${index}`,
      forwarderId: forwarderId(credential),
    };
    await broker.claimForwarder(replacement);
    expect(broker.reclaim(replacement)).toEqual([]);
    for (const capability of capabilities)
      expect(() => broker.invoke(replacement, capability, "foreign", "read", {})).toThrow(
        "owned live session",
      );
  }
});
it("preserves an explicit restart credential and refuses malformed credentials", () => {
  vi.stubEnv("TRUSTY_SQUIRE_FORWARDER_CREDENTIAL", "a".repeat(43));
  expect(requireLineageCredential()).toBe("a".repeat(43));
  vi.stubEnv("TRUSTY_SQUIRE_FORWARDER_CREDENTIAL", "short");
  expect(() => requireLineageCredential()).toThrow("unguessable");
});
