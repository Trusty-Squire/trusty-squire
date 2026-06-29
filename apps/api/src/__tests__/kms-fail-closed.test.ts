// P0 regression guard: production must NOT encrypt the vault with the hardcoded
// dev key (deps.ts once used `LocalKMS.withFixedKey(0x7f)` unconditionally — a
// constant in this open-source repo, so every prod secret was decryptable by
// anyone with the repo + the DB). Prod now fails closed without LOCAL_KMS_KEY.

import { describe, it, expect, afterEach } from "vitest";
import { buildInMemoryDeps } from "../services/deps.js";

const prevNodeEnv = process.env.NODE_ENV;
const prevKmsKey = process.env.LOCAL_KMS_KEY;

afterEach(() => {
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
  if (prevKmsKey === undefined) delete process.env.LOCAL_KMS_KEY;
  else process.env.LOCAL_KMS_KEY = prevKmsKey;
});

describe("KMS fail-closed in production", () => {
  it("refuses to boot in production without LOCAL_KMS_KEY", () => {
    process.env.NODE_ENV = "production";
    delete process.env.LOCAL_KMS_KEY;
    expect(() => buildInMemoryDeps({ sessionSecret: "test-secret" })).toThrow(
      /LOCAL_KMS_KEY must be set in production/,
    );
  });

  it("boots in production with a real LOCAL_KMS_KEY", () => {
    process.env.NODE_ENV = "production";
    process.env.LOCAL_KMS_KEY = "a".repeat(64); // 32 bytes hex
    expect(() => buildInMemoryDeps({ sessionSecret: "test-secret" })).not.toThrow();
  });

  it("uses the deterministic dev key outside production (no env required)", () => {
    process.env.NODE_ENV = "test";
    delete process.env.LOCAL_KMS_KEY;
    expect(() => buildInMemoryDeps({ sessionSecret: "test-secret" })).not.toThrow();
  });
});
