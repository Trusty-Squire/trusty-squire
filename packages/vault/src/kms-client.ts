// KMSClient — abstraction over the master key that wraps each
// credential's KEK (the only thing the master key ever encrypts).
//
// Production today: LocalKMS keyed from the LOCAL_KMS_KEY env var (a Fly
// secret), NOT hardcoded. A managed cloud KMS can drop in behind this
// same interface later (it's the right seam — encrypt/decrypt over opaque
// blobs).
//
// LocalKMS is a small KEYRING: one CURRENT key used for encrypt, and an
// ordered list of decrypt keys (current + any legacy). Because the wrap is
// AES-256-GCM (authenticated), decrypt tries each key and accepts the one
// that authenticates — this is what makes zero-downtime master-key
// rotation possible: add the new key as current, keep the old as legacy,
// re-wrap every blob, then drop the legacy key. See LOCAL_KMS_LEGACY_KEYS.

import { Buffer } from "node:buffer";
import { decryptAesGcm, encryptAesGcm } from "./encryption.js";

export interface KMSClient {
  // Encrypts a small blob (the per-credential KEK) under the master key.
  // Returns an opaque blob whose framing is the implementation's choice;
  // the vault never inspects it.
  encrypt(plaintext: Buffer): Promise<Buffer>;
  decrypt(ciphertext: Buffer): Promise<Buffer>;
}

const HEX_KEY_LEN = 64; // 32 bytes hex-encoded

export class LocalKMSConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalKMSConfigError";
  }
}

function parseHexKey(raw: string, label: string): Buffer {
  if (raw.length !== HEX_KEY_LEN || !/^[0-9a-fA-F]+$/.test(raw)) {
    throw new LocalKMSConfigError(
      `${label} must be ${HEX_KEY_LEN} hex chars (32 bytes); generate one with ` +
        `\`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"\``,
    );
  }
  return Buffer.from(raw, "hex");
}

export class LocalKMS implements KMSClient {
  // encryptKey is always decryptKeys[0]; the rest are legacy keys kept
  // only so existing blobs still decrypt during a rotation window.
  private readonly encryptKey: Buffer;
  private readonly decryptKeys: readonly Buffer[];
  private readonly source: "env" | "ephemeral";

  // Private — use LocalKMS.fromEnv() so the side-effects (warnings,
  // env parsing) happen in one documented place.
  private constructor(decryptKeys: Buffer[], source: "env" | "ephemeral") {
    if (decryptKeys.length === 0) {
      throw new LocalKMSConfigError("LocalKMS requires at least one key");
    }
    this.encryptKey = decryptKeys[0]!;
    this.decryptKeys = decryptKeys;
    this.source = source;
    this.warn();
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): LocalKMS {
    const raw = env.LOCAL_KMS_KEY;
    // Legacy keys: comma-separated 64-hex entries, tried after the current
    // key on decrypt. Transient — set during a master-key rotation, unset
    // once every blob has been re-wrapped onto the current key.
    const legacy = (env.LOCAL_KMS_LEGACY_KEYS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s, i) => parseHexKey(s, `LOCAL_KMS_LEGACY_KEYS[${i}]`));

    if (raw !== undefined && raw.length > 0) {
      return new LocalKMS([parseHexKey(raw, "LOCAL_KMS_KEY"), ...legacy], "env");
    }
    // No key configured: generate an ephemeral one so dev/CI works, but
    // warn loudly — these credentials are unrecoverable on next restart.
    return new LocalKMS([Buffer.from(crypto.getRandomValues(new Uint8Array(32)))], "ephemeral");
  }

  // Test-only: a deterministic single-key keyring without env round-trip.
  // Not exported via the public package barrel; never use in production.
  static withFixedKey(key: Buffer): LocalKMS {
    if (key.length !== 32) {
      throw new LocalKMSConfigError(`fixed key must be 32 bytes, got ${key.length}`);
    }
    return new LocalKMS([key], "env");
  }

  async encrypt(plaintext: Buffer): Promise<Buffer> {
    return encryptAesGcm(this.encryptKey, plaintext);
  }

  // Try each key; GCM authentication makes a wrong key throw, so the first
  // that succeeds is the right one. This is the rotation seam: a blob
  // wrapped under a now-legacy key still decrypts until it's re-wrapped.
  async decrypt(ciphertext: Buffer): Promise<Buffer> {
    let lastErr: unknown;
    for (const key of this.decryptKeys) {
      try {
        return decryptAesGcm(key, ciphertext);
      } catch (err) {
        lastErr = err;
      }
    }
    throw new LocalKMSConfigError(
      `KEK blob did not authenticate under any of ${this.decryptKeys.length} configured key(s) — ` +
        `wrong LOCAL_KMS_KEY / missing LOCAL_KMS_LEGACY_KEYS? (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`,
    );
  }

  private warn(): void {
    if (this.source === "ephemeral") {
      console.warn(
        "[vault] LocalKMS using an EPHEMERAL key (LOCAL_KMS_KEY unset). " +
          "Stored credentials will be UNRECOVERABLE on next process start. " +
          "DO NOT USE IN PRODUCTION.",
      );
      return;
    }
    const legacyCount = this.decryptKeys.length - 1;
    console.warn(
      `[vault] LocalKMS keyed from LOCAL_KMS_KEY` +
        (legacyCount > 0 ? ` (+${legacyCount} legacy key(s) for rotation)` : ""),
    );
  }
}
