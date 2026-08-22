import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialSlotConflictError, type CredentialRecord } from "@trusty-squire/vault";
import { ulid } from "ulid";
import { getApiPrismaClient, type ApiPrismaClient } from "../../services/api-prisma-client.js";
import { PrismaCredentialStore } from "../../services/prisma-credential-store.js";
import { PrismaVaultAuditStore } from "../../services/prisma-vault-audit-store.js";
import { ensureActiveCredentialSlotIndex, runDedup } from "../dedup-credentials.js";

const databaseUrl = process.env.CREDENTIAL_SLOT_TEST_DATABASE_URL;
const runDatabaseTests = databaseUrl !== undefined && databaseUrl.length > 0;

describe.skipIf(!runDatabaseTests)("active credential slot index rollout", () => {
  const root = fileURLToPath(new URL("../../../../../", import.meta.url));
  const schema = `credential_slot_${process.pid}_${Date.now()}`;
  const scopedUrl = new URL(databaseUrl!);
  scopedUrl.searchParams.set("schema", schema);
  let prisma: ApiPrismaClient | undefined;
  let store: PrismaCredentialStore;

  beforeAll(() => {
    const prismaBin = join(root, "apps/api/node_modules/.bin/prisma");
    const prismaSchema = join(root, "apps/api/prisma/schema.prisma");
    const prismaEnv = { ...process.env, AUTH_DATABASE_URL: scopedUrl.toString() };
    execFileSync(prismaBin, ["generate", "--schema", prismaSchema], {
      cwd: root,
      env: prismaEnv,
      stdio: "pipe",
    });
    execFileSync(prismaBin, ["db", "push", "--schema", prismaSchema, "--skip-generate"], {
      cwd: root,
      env: prismaEnv,
      stdio: "pipe",
    });
    prisma = getApiPrismaClient(scopedUrl.toString());
    store = new PrismaCredentialStore(prisma);
  });

  afterAll(async () => {
    await prisma?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });

  it("deduplicates legacy rows, creates online, and rejects concurrent writers", async () => {
    const old = credential("legacy_old", "shared", new Date("2026-01-01T00:00:00Z"));
    const recent = credential("legacy_recent", "shared", new Date("2026-02-01T00:00:00Z"));
    await store.insert(old);
    await store.insert(recent);

    const dedup = await runDedup(
      store,
      new PrismaVaultAuditStore(prisma!),
      true,
      () => new Date("2026-03-01T00:00:00Z"),
    );
    expect(dedup.rowsCollapsed).toBe(1);
    await expect(ensureActiveCredentialSlotIndex(prisma!)).resolves.toBe("created");
    await expect(ensureActiveCredentialSlotIndex(prisma!)).resolves.toBe("already_present");
    expect((await store.listByAccount("acct_slot")).map((row) => row.reference)).toEqual([
      recent.reference,
    ]);

    const attempts = await Promise.allSettled([
      store.insert(credential("race_a", "race", new Date("2026-04-01T00:00:00Z"))),
      store.insert(credential("race_b", "race", new Date("2026-04-01T00:00:01Z"))),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(CredentialSlotConflictError) });
  });
});

function credential(reference: string, label: string, createdAt: Date): CredentialRecord {
  return {
    id: ulid(),
    reference: `vault://acct_slot/subscription/${reference}`,
    account_id: "acct_slot",
    subscription_id: "subscription",
    type: "api_key",
    env_var_suggestion: null,
    label,
    field_names: ["value"],
    allowed_hosts: ["api.openai.com"],
    ciphertext: Buffer.from("ciphertext"),
    encrypted_dek: Buffer.from("encrypted-dek"),
    account_kek_blob: Buffer.from("account-kek"),
    algorithm: "AES-256-GCM",
    metadata: { service: "OpenAI" },
    rotated_at: null,
    retrieval_count: 0,
    last_retrieved_at: null,
    deleted_at: null,
    created_at: createdAt,
  };
}
