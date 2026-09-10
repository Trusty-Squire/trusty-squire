import { describe, expect, it } from "vitest";
import { validateAcceptanceManifest, validateClosureReceipt } from "./broker-live-acceptance.mjs";

const service = (provider, host) => ({
  provider,
  providerAccountId: `${provider}-account`,
  url: `https://${host}/keys`,
  driver: `${provider}.mjs`,
  authPattern: "account",
  provisionPattern: "run-label",
  oldCredentialControl: {
    provider_credential_id: `${provider}-old-provider-id`,
    vault_reference: `vault://${provider}/old`,
  },
});

const manifest = () => ({
  schema_version: 1,
  release: { artifact: "isolated package", version: "1.2.3" },
  nativeLaunch: {
    command: "node",
    args: ["dist/bin.js", "server"],
    expectedVersion: "1.2.3",
  },
  credential_policy: "force_fresh",
  credential_cleanup_policy: "retain",
  profileDir: "/isolated/profile",
  configHome: "/isolated/config",
  accountId: "vault-account",
  services: [
    service("resend", "resend.test"),
    service("neon", "neon.test"),
    service("xata", "xata.test"),
  ],
});

describe("native + concurrency acceptance manifest", () => {
  it("requires the shared core closure receipt without inventing another owner", () => {
    expect(
      validateClosureReceipt(
        {
          session_id: "session-a",
          operation_id: "finish-a",
          execution: "completed",
          mutation: "not_dispatched",
          cleanup: "closed",
          closed: true,
        },
        "session-a",
      ),
    ).toMatchObject({ cleanup: "closed", closed: true });
    expect(() =>
      validateClosureReceipt(
        {
          session_id: "session-a",
          operation_id: "finish-a",
          execution: "completed",
          mutation: "not_dispatched",
          cleanup: "unknown",
          closed: true,
        },
        "session-a",
      ),
    ).toThrow(/contradicts/);
  });

  it("pins one artifact/version and requires old-key controls for all three providers", () => {
    expect(validateAcceptanceManifest(manifest())).toMatchObject({
      release: { version: "1.2.3" },
      credential_policy: "force_fresh",
      services: [{ provider: "resend" }, { provider: "neon" }, { provider: "xata" }],
    });
  });

  it("rejects native version drift and unreviewed provider probes", () => {
    const drift = manifest();
    drift.nativeLaunch.expectedVersion = "1.2.2";
    expect(() => validateAcceptanceManifest(drift)).toThrow(/must equal the release/);

    const arbitrary = manifest();
    arbitrary.services[2].provider = "driver-defined";
    expect(() => validateAcceptanceManifest(arbitrary)).toThrow(/No reviewed/);
  });

  it("rejects a service without an explicit old valid credential control", () => {
    const missing = manifest();
    delete missing.services[0].oldCredentialControl;
    expect(() => validateAcceptanceManifest(missing)).toThrow(/old valid credential/);
  });
});
