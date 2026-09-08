import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { profilePathIdentity } from "../profile.js";

const FILE = "trusty-squire-broker-qualification.json";

interface QualificationRecord {
  version: 1;
  accountId: string;
  state: "qualifying" | "qualified";
  runId?: string;
  completedAt?: string;
  evidencePath?: string;
  serviceHosts?: string[];
}

export type BrokerAdmissionMode = "single" | "qualifying" | "qualified";

export function brokerQualificationPath(profileDir: string): string {
  return join(profilePathIdentity(profileDir), FILE);
}

async function readQualification(profileDir: string): Promise<QualificationRecord | null> {
  try {
    const record = JSON.parse(await readFile(brokerQualificationPath(profileDir), "utf8")) as QualificationRecord;
    if (
      record.version !== 1 ||
      typeof record.accountId !== "string" ||
      !["qualifying", "qualified"].includes(record.state) ||
      (record.runId !== undefined && typeof record.runId !== "string") ||
      (record.completedAt !== undefined && typeof record.completedAt !== "string") ||
      (record.evidencePath !== undefined && typeof record.evidencePath !== "string") ||
      (record.serviceHosts !== undefined &&
        (!Array.isArray(record.serviceHosts) || !record.serviceHosts.every((host) => typeof host === "string")))
    )
      return null;
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export async function brokerAdmissionMode(
  profileDir: string,
  accountId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrokerAdmissionMode> {
  if (typeof accountId !== "string" || accountId.length === 0) return "single";
  const record = await readQualification(profileDir);
  if (record === null || record.accountId !== accountId) return "single";
  if (record.state === "qualified") return "qualified";
  return record.runId !== undefined && record.runId === env.TRUSTY_SQUIRE_BROKER_QUALIFICATION_RUN_ID
    ? "qualifying"
    : "single";
}

export async function brokerForwardingEnabled(
  socketPath: string | undefined,
  profileDir: string,
  accountId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return socketPath !== undefined && (await brokerAdmissionMode(profileDir, accountId, env)) !== "single";
}

export async function beginBrokerQualification(profileDir: string, accountId: string): Promise<string> {
  const runId = randomUUID();
  await writeFile(
    brokerQualificationPath(profileDir),
    JSON.stringify({ version: 1, accountId, state: "qualifying", runId } satisfies QualificationRecord),
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return runId;
}

export async function completeBrokerQualification(
  profileDir: string,
  accountId: string,
  runId: string,
  evidencePath: string,
  serviceHosts: readonly string[],
): Promise<void> {
  const record = await readQualification(profileDir);
  if (
    record?.state !== "qualifying" ||
    record.accountId !== accountId ||
    record.runId !== runId ||
    new Set(serviceHosts).size !== 3
  )
    throw new Error("Real-auth qualification record is not owned by this harness run");
  await writeFile(
    brokerQualificationPath(profileDir),
    JSON.stringify({
      version: 1,
      accountId,
      state: "qualified",
      completedAt: new Date().toISOString(),
      evidencePath,
      serviceHosts: [...serviceHosts],
    } satisfies QualificationRecord),
    { encoding: "utf8", mode: 0o600 },
  );
}

export async function abandonBrokerQualification(
  profileDir: string,
  accountId: string,
  runId: string,
): Promise<void> {
  const record = await readQualification(profileDir);
  if (record?.state === "qualifying" && record.accountId === accountId && record.runId === runId)
    await unlink(brokerQualificationPath(profileDir));
}
