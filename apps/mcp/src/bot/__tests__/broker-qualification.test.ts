import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  abandonBrokerQualification,
  beginBrokerQualification,
  brokerAdmissionMode,
  brokerForwardingEnabled,
  recordBrokerQualificationEvidence,
} from "../broker/qualification.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function profile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ts-broker-qualification-"));
  roots.push(root);
  const dir = join(root, "profile");
  await mkdir(dir);
  return dir;
}

it("keeps socket-configured production on the single-session path before qualification", async () => {
  const dir = await profile();
  const env = { TRUSTY_SQUIRE_BROKER_SOCKET: join(dir, "broker.sock") };
  await expect(brokerAdmissionMode(dir, "account", env)).resolves.toBe("single");
  await expect(brokerForwardingEnabled(env.TRUSTY_SQUIRE_BROKER_SOCKET, dir, "account", env)).resolves.toBe(false);
});

it("keeps recorded qualification evidence inert until an explicit operator enablement", async () => {
  const dir = await profile();
  const runId = await beginBrokerQualification(dir, "account");
  const socket = join(dir, "broker.sock");
  await expect(brokerForwardingEnabled(socket, dir, "account", {})).resolves.toBe(false);
  await expect(
    brokerForwardingEnabled(socket, dir, "account", {
      TRUSTY_SQUIRE_BROKER_QUALIFICATION_RUN_ID: runId,
    }),
  ).resolves.toBe(true);
  const evidencePath = join(dir, "evidence.json");
  await expect(
    recordBrokerQualificationEvidence(dir, "account", runId, evidencePath, [
      "one.example",
      "two.example",
      "three.example",
    ]),
  ).rejects.toThrow("Qualification evidence is missing");
  await expect(
    brokerAdmissionMode(dir, "account", {
      TRUSTY_SQUIRE_BROKER_QUALIFICATION_RUN_ID: runId,
    }),
  ).resolves.toBe("qualifying");
  await writeFile(evidencePath, JSON.stringify({ kind: "real-service-three-MCP-process-acceptance" }));
  await recordBrokerQualificationEvidence(dir, "account", runId, evidencePath, [
    "one.example",
    "two.example",
    "three.example",
  ]);
  await expect(brokerAdmissionMode(dir, "account", {})).resolves.toBe("single");
  await expect(brokerForwardingEnabled(socket, dir, "account", {})).resolves.toBe(false);
  const enabled = { TRUSTY_SQUIRE_BROKER_CONCURRENCY: "enabled" };
  await expect(brokerAdmissionMode(dir, "account", enabled)).resolves.toBe("enabled");
  await expect(brokerForwardingEnabled(socket, dir, "account", enabled)).resolves.toBe(true);
  await expect(brokerForwardingEnabled(socket, dir, "other-account", enabled)).resolves.toBe(false);
  await abandonBrokerQualification(dir, "account", runId);
  await expect(brokerAdmissionMode(dir, "account", {})).resolves.toBe("single");
});
