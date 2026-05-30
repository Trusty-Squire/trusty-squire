// KEK re-wrap migration for master-key rotation.
//
// The master key (LocalKMS) wraps each credential's per-credential KEK
// into `account_kek_blob` — and nothing else (ciphertext + encrypted_dek
// live under the DEK/KEK, untouched by the master key). Rotating the
// master key therefore means re-encrypting `account_kek_blob` for every
// row: decrypt the KEK under the keyring (finds the legacy key), then
// re-encrypt it under the current key.
//
// Prerequisite: the server must already run with both keys in the keyring
// (LOCAL_KMS_KEY = new current, LOCAL_KMS_LEGACY_KEYS = old) BEFORE this
// runs, so old blobs still decrypt. After this completes and verifies,
// drop LOCAL_KMS_LEGACY_KEYS.
//
// DEFAULTS TO A DRY RUN. Every row is round-trip verified (the re-wrapped
// blob must decrypt back to the exact same KEK) BEFORE anything is
// written. Idempotent: re-running re-wraps current→current harmlessly.
//
//   node apps/api/dist/scripts/rewrap-kek.bin.js            # dry run
//   node apps/api/dist/scripts/rewrap-kek.bin.js --apply    # mutate
// AUTH_DATABASE_URL + LOCAL_KMS_KEY (+ LOCAL_KMS_LEGACY_KEYS) must be set.

import process from "node:process";
import { Buffer } from "node:buffer";
import { LocalKMS, type CredentialRecord } from "@trusty-squire/vault";
import { getApiPrismaClient } from "../services/api-prisma-client.js";
import { PrismaCredentialStore } from "../services/prisma-credential-store.js";

interface RewrapResult {
  reference: string;
  account_id: string;
  status: "rewrapped" | "would-rewrap" | "fail";
  error?: string;
  newBlob?: Buffer;
}

// Re-wraps one credential's KEK under the current key, verifying the new
// blob decrypts back to the identical KEK before returning it. No DB I/O —
// the caller persists only on --apply.
async function rewrapOne(kms: LocalKMS, rec: CredentialRecord, apply: boolean): Promise<RewrapResult> {
  try {
    const kek = await kms.decrypt(rec.account_kek_blob);
    const newBlob = await kms.encrypt(kek);
    const check = await kms.decrypt(newBlob);
    const ok = check.equals(kek);
    kek.fill(0);
    check.fill(0);
    if (!ok) {
      return { reference: rec.reference, account_id: rec.account_id, status: "fail", error: "re-wrapped blob did not round-trip to the same KEK" };
    }
    return {
      reference: rec.reference,
      account_id: rec.account_id,
      status: apply ? "rewrapped" : "would-rewrap",
      newBlob,
    };
  } catch (err) {
    return {
      reference: rec.reference,
      account_id: rec.account_id,
      status: "fail",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function main(argv: string[]): Promise<void> {
  const apply = argv.includes("--apply");
  const databaseUrl = process.env.AUTH_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    console.error("[rewrap-kek] AUTH_DATABASE_URL is not set; refusing to run.");
    process.exit(2);
  }
  if (process.env.LOCAL_KMS_KEY === undefined || process.env.LOCAL_KMS_KEY.length === 0) {
    console.error("[rewrap-kek] LOCAL_KMS_KEY is not set; refusing to run (would re-wrap onto an ephemeral key).");
    process.exit(2);
  }

  const kms = LocalKMS.fromEnv();
  const store = new PrismaCredentialStore(getApiPrismaClient(databaseUrl));
  const accountIds = await store.listAllAccountIds();

  let done = 0;
  let failed = 0;
  for (const accountId of accountIds) {
    const records = await store.listByAccount(accountId);
    for (const rec of records) {
      const r = await rewrapOne(kms, rec, apply);
      if (r.status === "fail") {
        failed += 1;
        console.warn(`[rewrap-kek][FAIL] account=${r.account_id} ref=${r.reference} error=${r.error}`);
        continue;
      }
      if (apply && r.newBlob !== undefined) {
        await store.rewrapAccountKek(r.reference, r.newBlob);
      }
      done += 1;
      console.warn(`[rewrap-kek][${r.status}] account=${r.account_id} ref=${r.reference}`);
    }
  }

  const mode = apply ? "APPLY" : "DRY-RUN";
  console.warn(`[rewrap-kek][summary] mode=${mode} ${apply ? "rewrapped" : "would_rewrap"}=${done} failed=${failed}`);
  if (!apply) {
    console.warn("[rewrap-kek][dry-run] no changes written. Re-run with --apply to re-wrap.");
  }
  if (failed > 0) {
    console.error("[rewrap-kek] some credentials failed to re-wrap — investigate before dropping LOCAL_KMS_LEGACY_KEYS.");
    process.exit(1);
  }
}
