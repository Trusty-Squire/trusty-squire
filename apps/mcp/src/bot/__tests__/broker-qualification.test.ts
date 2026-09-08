import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  abandonBrokerQualification,
  beginBrokerQualification,
  brokerAdmissionMode,
  brokerForwardingEnabled,
  completeBrokerQualification,
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

it("enables broker forwarding only for a live qualification run or completed evidence", async () => {
  const dir = await profile();
  const runId = await beginBrokerQualification(dir, "account");
  const socket = join(dir, "broker.sock");
  await expect(brokerForwardingEnabled(socket, dir, "account", {})).resolves.toBe(false);
  await expect(
    brokerForwardingEnabled(socket, dir, "account", {
      TRUSTY_SQUIRE_BROKER_QUALIFICATION_RUN_ID: runId,
    }),
  ).resolves.toBe(true);
  await completeBrokerQualification(dir, "account", runId, join(dir, "evidence.json"), [
    "one.example",
    "two.example",
    "three.example",
  ]);
  await expect(brokerAdmissionMode(dir, "account", {})).resolves.toBe("qualified");
  await expect(brokerForwardingEnabled(socket, dir, "other-account", {})).resolves.toBe(false);
  await abandonBrokerQualification(dir, "account", runId);
  await expect(brokerAdmissionMode(dir, "account", {})).resolves.toBe("qualified");
});
