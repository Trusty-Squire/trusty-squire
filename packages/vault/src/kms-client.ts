// KMSClient — abstraction over the master key.
//
// Production: AWS KMS (the production wrapper lives in a deploy-only
// module so this package stays AWS-SDK-free in dev). LocalKMS uses a
// static AES-256-GCM key from the LOCAL_KMS_KEY env var (32-byte hex,
// 64 chars). When the env is unset we generate a random key on startup
// and warn loudly — fine for local dev, would lose all stored
// credentials on next startup.

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

export class LocalKMS implements KMSClient {
  private readonly key: Buffer;
  private readonly source: "env" | "ephemeral";

  // Private — use LocalKMS.fromEnv() so the side-effects (warnings,
  // env parsing) happen in one documented place.
  private constructor(key: Buffer, source: "env" | "ephemeral") {
    this.key = key;
    this.source = source;
    this.warn();
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): LocalKMS {
    const raw = env.LOCAL_KMS_KEY;
    if (raw !== undefined && raw.length > 0) {
      if (raw.length !== HEX_KEY_LEN || !/^[0-9a-fA-F]+$/.test(raw)) {
        throw new LocalKMSConfigError(
          `LOCAL_KMS_KEY must be ${HEX_KEY_LEN} hex chars (32 bytes); generate one with ` +
            `\`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"\``,
        );
      }
      return new LocalKMS(Buffer.from(raw, "hex"), "env");
    }
    return new LocalKMS(crypto.getRandomValues(Buffer.alloc(32)), "ephemeral");
  }

  // Used by tests that want a stable key without round-tripping through
  // the env. Not exported via the public package barrel.
  static withFixedKey(key: Buffer): LocalKMS {
    if (key.length !== 32) {
      throw new LocalKMSConfigError(`fixed key must be 32 bytes, got ${key.length}`);
    }
    return new LocalKMS(key, "env");
  }

  async encrypt(plaintext: Buffer): Promise<Buffer> {
    return encryptAesGcm(this.key, plaintext);
  }

  async decrypt(ciphertext: Buffer): Promise<Buffer> {
    return decryptAesGcm(this.key, ciphertext);
  }

  private warn(): void {
    const banner =
      this.source === "ephemeral"
        ? "[vault] Using LocalKMS with EPHEMERAL key (LOCAL_KMS_KEY unset). " +
          "Stored credentials will be unrecoverable on next process start. " +
          "DO NOT USE IN PRODUCTION."
        : "[vault] Using LocalKMS with key from LOCAL_KMS_KEY. DO NOT USE IN PRODUCTION.";
    console.warn(banner);
  }
}
