// Read-only vault decryption health check.
//
// Decrypts every active credential with the current envelope + coercion
// and reports, per credential, whether it decrypts and which ciphertext
// format it carries (v2 JSON field-map vs the pre-v2 raw-value format that
// used to 500 reveal/use on JSON.parse). NEVER prints secret values — only
// the field NAMES (which are non-secret) and a format/status tag.
//
// Writes nothing: it replicates decryptFields' read path inline rather than
// calling vault.reveal (which would mark retrievals + write audit rows).
//
//   node apps/api/dist/scripts/vault-decrypt-check.bin.js
// AUTH_DATABASE_URL must point at the API auth DB.

import process from "node:process";
import { Buffer } from "node:buffer";
import {
  aadForDek,
  aadForValue,
  coerceFieldMap,
  decryptAesGcm,
  LocalKMS,
  type CredentialRecord,
} from "@trusty-squire/vault";
import { getApiPrismaClient } from "../services/api-prisma-client.js";
import { PrismaCredentialStore } from "../services/prisma-credential-store.js";

// Must match the fixed key the API wires in deps.ts — the LocalKMS blob
// is only decryptable with the same key it was sealed under.
const KMS = LocalKMS.withFixedKey(Buffer.alloc(32, 0x7f));

type Status = "ok" | "fail";
type Format = "v2-json" | "legacy-raw" | "unknown";

interface CheckResult {
  reference: string;
  account_id: string;
  status: Status;
  format: Format;
  field_names: string[];
  error?: string;
}

// Classifies the decrypted plaintext without exposing it: a JSON object is
// the v2 field map; anything else is the legacy raw-value format.
function classify(text: string): Format {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return "v2-json";
    }
    return "legacy-raw";
  } catch {
    return "legacy-raw";
  }
}

async function checkOne(rec: CredentialRecord): Promise<CheckResult> {
  try {
    const kek = await KMS.decrypt(rec.account_kek_blob);
    const dek = decryptAesGcm(kek, rec.encrypted_dek, aadForDek(rec.reference, rec.account_id));
    const plaintext = decryptAesGcm(dek, rec.ciphertext, aadForValue(rec.reference, rec.account_id));
    const text = plaintext.toString("utf8");
    kek.fill(0);
    dek.fill(0);
    plaintext.fill(0);
    const format = classify(text);
    const fields = coerceFieldMap(text);
    return {
      reference: rec.reference,
      account_id: rec.account_id,
      status: "ok",
      format,
      field_names: Object.keys(fields),
    };
  } catch (err) {
    return {
      reference: rec.reference,
      account_id: rec.account_id,
      status: "fail",
      format: "unknown",
      field_names: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function main(): Promise<void> {
  const databaseUrl = process.env.AUTH_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    console.error("[decrypt-check] AUTH_DATABASE_URL is not set; refusing to run.");
    process.exit(2);
  }
  const store = new PrismaCredentialStore(getApiPrismaClient(databaseUrl));
  const accountIds = await store.listAllAccountIds();

  let ok = 0;
  let fail = 0;
  let legacy = 0;
  for (const accountId of accountIds) {
    const records = await store.listByAccount(accountId);
    for (const rec of records) {
      const r = await checkOne(rec);
      if (r.status === "ok") {
        ok += 1;
        if (r.format === "legacy-raw") legacy += 1;
        console.warn(
          `[decrypt-check][ok] account=${r.account_id} format=${r.format} ` +
            `fields=[${r.field_names.join(",")}] ref=${r.reference}`,
        );
      } else {
        fail += 1;
        console.warn(
          `[decrypt-check][FAIL] account=${r.account_id} ref=${r.reference} error=${r.error}`,
        );
      }
    }
  }
  console.warn(
    `[decrypt-check][summary] accounts=${accountIds.length} ok=${ok} fail=${fail} ` +
      `legacy_raw=${legacy}`,
  );
}
