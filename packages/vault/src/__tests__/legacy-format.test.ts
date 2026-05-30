// Regression: credentials stored before vault v2 hold the RAW secret
// string as ciphertext (single-value era), not JSON.stringify(fields).
// v2's decryptFields used to JSON.parse that and throw, 500ing reveal +
// use_credential for every pre-v2 credential. These tests pin the
// backward-compatible coercion both at the unit level (coerceFieldMap)
// and end-to-end (a hand-built legacy record reveals as { value }).

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { CredentialVault, coerceFieldMap } from "../credential-vault.js";
import {
  aadForDek,
  aadForValue,
  encryptAesGcm,
  generateKey,
} from "../encryption.js";
import { InMemoryCredentialStore, InMemoryVaultAuditStore } from "../in-memory-stores.js";
import { LocalKMS } from "../kms-client.js";
import type { CredentialRecord } from "../types.js";

const NOW = new Date("2026-05-30T12:00:00.000Z");
const ACCOUNT = "01HACCOUNTAAAAAAAAAAAAAAAA";
const REF = "vault://01HACCOUNTAAAAAAAAAAAAAAAA/01HSUB/01HLEGACY";

describe("coerceFieldMap", () => {
  it("returns a v2 single-value field map unchanged", () => {
    expect(coerceFieldMap(JSON.stringify({ value: "sk-1" }))).toEqual({ value: "sk-1" });
  });

  it("returns a v2 multi-field map unchanged", () => {
    expect(
      coerceFieldMap(JSON.stringify({ access_key_id: "AK", secret_access_key: "SK" })),
    ).toEqual({ access_key_id: "AK", secret_access_key: "SK" });
  });

  it("coerces a legacy raw secret string to { value }", () => {
    expect(coerceFieldMap("sk-proj-rawlegacyvalue")).toEqual({ value: "sk-proj-rawlegacyvalue" });
  });

  it("coerces a numeric-looking legacy secret (valid JSON scalar) to { value }", () => {
    expect(coerceFieldMap("1234567890")).toEqual({ value: "1234567890" });
  });

  it("coerces a JSON array (not a field map) to { value }", () => {
    expect(coerceFieldMap("[1,2,3]")).toEqual({ value: "[1,2,3]" });
  });

  it("drops non-string field values from a v2 map", () => {
    expect(coerceFieldMap(JSON.stringify({ value: "x", n: 5 }))).toEqual({ value: "x" });
  });
});

// Builds a credential record exactly as the PRE-v2 code did: ciphertext is
// the raw secret bytes (not JSON), wrapped in the same DEK/KEK/KMS envelope
// the current code uses. Mirrors the old encryptValue path.
async function makeLegacyRecord(
  kms: LocalKMS,
  rawValue: string,
): Promise<CredentialRecord> {
  const kek = generateKey();
  const dek = generateKey();
  const ciphertext = encryptAesGcm(dek, Buffer.from(rawValue, "utf8"), aadForValue(REF, ACCOUNT));
  const encryptedDek = encryptAesGcm(kek, dek, aadForDek(REF, ACCOUNT));
  const accountKekBlob = await kms.encrypt(kek);
  return {
    id: "01HLEGACYID0000000000000000",
    reference: REF,
    account_id: ACCOUNT,
    subscription_id: "01HSUB",
    label: "default",
    type: "api_key",
    env_var_suggestion: null,
    field_names: ["value"],
    allowed_hosts: [],
    ciphertext,
    encrypted_dek: encryptedDek,
    account_kek_blob: accountKekBlob,
    algorithm: "AES-256-GCM",
    metadata: { service: "IPInfo" },
    rotated_at: null,
    retrieval_count: 0,
    last_retrieved_at: null,
    deleted_at: null,
    created_at: NOW,
  };
}

describe("legacy raw-value credential", () => {
  it("reveals as { value } instead of 500ing on JSON.parse", async () => {
    const store = new InMemoryCredentialStore();
    const audit = new InMemoryVaultAuditStore(() => NOW);
    const kms = LocalKMS.withFixedKey(Buffer.alloc(32, 0x42));
    const vault = new CredentialVault({ store, audit, kms, now: () => NOW });

    await store.insert(await makeLegacyRecord(kms, "sk-proj-LEGACYrawvalue"));

    const fields = await vault.reveal(REF, ACCOUNT);
    expect(fields).toEqual({ value: "sk-proj-LEGACYrawvalue" });
  });
});
