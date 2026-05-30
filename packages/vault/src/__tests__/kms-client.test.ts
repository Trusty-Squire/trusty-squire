// LocalKMS keyring — the master-key rotation seam. Verifies encrypt uses
// the current key, decrypt accepts current + legacy keys, unknown keys are
// rejected, and a full legacy→re-wrap→current-only rotation round-trips.

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { LocalKMS, LocalKMSConfigError } from "../kms-client.js";

const hex = (b: number) => Buffer.alloc(32, b).toString("hex");
const KEY_A = hex(0x11);
const KEY_B = hex(0x22);
const KEY_C = hex(0x33);

describe("LocalKMS keyring", () => {
  it("round-trips under a single current key", async () => {
    const kms = LocalKMS.fromEnv({ LOCAL_KMS_KEY: KEY_A });
    const pt = Buffer.from("a-per-credential-kek");
    const blob = await kms.encrypt(pt);
    expect((await kms.decrypt(blob)).equals(pt)).toBe(true);
  });

  it("decrypts a blob sealed under a legacy key, but encrypts under current", async () => {
    const legacyOnly = LocalKMS.fromEnv({ LOCAL_KMS_KEY: KEY_B });
    const pt = Buffer.from("kek-sealed-under-old-key");
    const oldBlob = await legacyOnly.encrypt(pt);

    // Current = A, legacy = B. Must decrypt the old (B) blob...
    const rotating = LocalKMS.fromEnv({ LOCAL_KMS_KEY: KEY_A, LOCAL_KMS_LEGACY_KEYS: KEY_B });
    expect((await rotating.decrypt(oldBlob)).equals(pt)).toBe(true);

    // ...and a freshly encrypted blob must use the CURRENT key (A), so a
    // current-A-only keyring can read it while a B-only keyring cannot.
    const newBlob = await rotating.encrypt(pt);
    const currentOnly = LocalKMS.fromEnv({ LOCAL_KMS_KEY: KEY_A });
    expect((await currentOnly.decrypt(newBlob)).equals(pt)).toBe(true);
    await expect(legacyOnly.decrypt(newBlob)).rejects.toBeInstanceOf(LocalKMSConfigError);
  });

  it("full rotation: re-wrap an old blob, then a current-only keyring reads new but not old", async () => {
    const bOnly = LocalKMS.fromEnv({ LOCAL_KMS_KEY: KEY_B });
    const pt = Buffer.from("rotate-me");
    const oldBlob = await bOnly.encrypt(pt);

    // Migration-window keyring: current A, legacy B.
    const rotating = LocalKMS.fromEnv({ LOCAL_KMS_KEY: KEY_A, LOCAL_KMS_LEGACY_KEYS: KEY_B });
    const reWrapped = await rotating.encrypt(await rotating.decrypt(oldBlob));

    // After dropping the legacy key: only the re-wrapped blob survives.
    const aOnly = LocalKMS.fromEnv({ LOCAL_KMS_KEY: KEY_A });
    expect((await aOnly.decrypt(reWrapped)).equals(pt)).toBe(true);
    await expect(aOnly.decrypt(oldBlob)).rejects.toBeInstanceOf(LocalKMSConfigError);
  });

  it("rejects a blob that authenticates under no configured key", async () => {
    const sealed = await LocalKMS.fromEnv({ LOCAL_KMS_KEY: KEY_C }).encrypt(Buffer.from("x"));
    const other = LocalKMS.fromEnv({ LOCAL_KMS_KEY: KEY_A, LOCAL_KMS_LEGACY_KEYS: KEY_B });
    await expect(other.decrypt(sealed)).rejects.toBeInstanceOf(LocalKMSConfigError);
  });

  it("parses multiple comma-separated legacy keys", async () => {
    const cOnly = LocalKMS.fromEnv({ LOCAL_KMS_KEY: KEY_C });
    const blob = await cOnly.encrypt(Buffer.from("multi"));
    const kms = LocalKMS.fromEnv({ LOCAL_KMS_KEY: KEY_A, LOCAL_KMS_LEGACY_KEYS: `${KEY_B}, ${KEY_C}` });
    expect((await kms.decrypt(blob)).toString()).toBe("multi");
  });

  it("rejects a malformed LOCAL_KMS_KEY", () => {
    expect(() => LocalKMS.fromEnv({ LOCAL_KMS_KEY: "not-hex" })).toThrow(LocalKMSConfigError);
  });

  it("falls back to an ephemeral key when LOCAL_KMS_KEY is unset", async () => {
    const kms = LocalKMS.fromEnv({});
    const pt = Buffer.from("dev-mode");
    expect((await kms.decrypt(await kms.encrypt(pt))).equals(pt)).toBe(true);
  });
});
