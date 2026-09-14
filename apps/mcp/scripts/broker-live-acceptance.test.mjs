import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  validateAcceptanceManifest,
  acceptanceSessionOrder,
  validateClosureReceipt,
  validateConfiguredNativeConnectionEvidence,
} from "./broker-live-acceptance.mjs";

const service = (provider, host) => ({
  provider,
  providerAccountId: `${provider}-account`,
  url: `https://${host}/keys`,
  driver: `${provider}.mjs`,
  authPattern: "account",
  provisionPattern: "run-label",
  driverEvidence: {},
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
  configuredNativeEvidence: "configured-native-evidence.json",
  services: [
    service("resend", "resend.test"),
    service("neon", "neon.test"),
    service("resend", "resend.test"),
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

  it("accepts concurrent Resend and Neon with a queued duplicate provider", () => {
    expect(validateAcceptanceManifest(manifest())).toMatchObject({
      release: { version: "1.2.3" },
      credential_policy: "force_fresh",
      services: [{ provider: "resend" }, { provider: "neon" }, { provider: "resend" }],
    });
  });

  it("preserves one profile and requires a single conflicting active provider", () => {
    const config = manifest();
    expect(acceptanceSessionOrder(config)).toEqual({ active: [0, 1], queued: 2, release: 0 });
    config.services[2].profileDir = "/another/profile";
    expect(() => validateAcceptanceManifest(config)).toThrow(/single enrolled/);
    delete config.services[2].profileDir;
    config.services[2].allowedHosts = ["neon.test"];
    expect(() => validateAcceptanceManifest(config)).toThrow(/exactly one active/);
  });

  it("accepts the published single-profile manifest", () => {
    const example = JSON.parse(
      readFileSync(new URL("./broker-live-acceptance.example.json", import.meta.url), "utf8"),
    );
    expect(acceptanceSessionOrder(validateAcceptanceManifest(example))).toEqual({
      active: [0, 1],
      queued: 2,
      release: 0,
    });
  });

  it("rejects native version drift and unreviewed provider probes", () => {
    const drift = manifest();
    drift.nativeLaunch.expectedVersion = "1.2.2";
    expect(() => validateAcceptanceManifest(drift)).toThrow(/must equal the release/);

    const arbitrary = manifest();
    arbitrary.services[2].provider = "xata";
    expect(() => validateAcceptanceManifest(arbitrary)).toThrow(/cover Resend and Neon/);
  });

  it("keeps configured-host connection evidence distinct from installed-command initialization", () => {
    expect(
      validateConfiguredNativeConnectionEvidence(
        {
          kind: "configured-native-host-mcp-connection",
          release_version: "1.2.3",
          host_name: "Codex",
          connection_id: "connection-1",
          observed_at: "2026-09-09T12:00:00Z",
          initialize: { server_version: "1.2.3" },
          tools_list: { names: ["operate_start", "list_credentials"] },
          read_only_probe: { name: "list_credentials", outcome: "completed" },
        },
        "1.2.3",
      ),
    ).toMatchObject({ connection_id: "connection-1" });
    expect(() =>
      validateConfiguredNativeConnectionEvidence(
        { kind: "installed-command-mcp-initialization", release_version: "1.2.3" },
        "1.2.3",
      ),
    ).toThrow(/Configured native-host/);
  });

  it("rejects a service without an explicit old valid credential control", () => {
    const missing = manifest();
    delete missing.services[0].oldCredentialControl;
    expect(() => validateAcceptanceManifest(missing)).toThrow(/old valid credential/);
  });
});
