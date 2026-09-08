import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  beginBrokerQualification,
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

it("enables broker forwarding for every socket-configured client", () => {
  expect(brokerForwardingEnabled(undefined)).toBe(false);
  expect(brokerForwardingEnabled("/private/broker.sock")).toBe(true);
});

it("records only extant qualification evidence without altering socket forwarding", async () => {
  const dir = await profile();
  const runId = await beginBrokerQualification(dir, "account");
  const socket = join(dir, "broker.sock");
  expect(brokerForwardingEnabled(socket)).toBe(true);
  const evidencePath = join(dir, "evidence.json");
  await expect(
    recordBrokerQualificationEvidence(dir, "account", runId, evidencePath, [
      "one.example",
      "two.example",
      "three.example",
    ]),
  ).rejects.toThrow("Qualification evidence is missing");
  await writeFile(evidencePath, JSON.stringify({ kind: "real-service-three-MCP-process-acceptance" }));
  await recordBrokerQualificationEvidence(dir, "account", runId, evidencePath, [
    "one.example",
    "two.example",
    "three.example",
  ]);
  expect(brokerForwardingEnabled(socket)).toBe(true);
});
