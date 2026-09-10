import { readFileSync } from "node:fs";
import { BrokerAuthority } from "../src/bot/broker/authority.ts";
import { siteResources } from "../src/bot/broker/scheduler.ts";
import { describe, expect, it } from "vitest";
import {
  validateAcceptanceManifest,
  acceptanceProfileGroups,
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
    { ...service("resend", "resend.test"), profileDir: "/isolated/second-profile" },
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

  it("accepts three overlapping sessions spanning Resend and Neon", () => {
    expect(validateAcceptanceManifest(manifest())).toMatchObject({
      release: { version: "1.2.3" },
      credential_policy: "force_fresh",
      services: [{ provider: "resend" }, { provider: "neon" }, { provider: "resend" }],
    });
  });

  it("assigns repeated providers to separate browser identities while preserving shared-site exclusion", () => {
    const config = manifest();
    expect(acceptanceProfileGroups(config).map((group) => group.indices)).toEqual([[0, 1], [2]]);
    delete config.services[2].profileDir;
    expect(() => validateAcceptanceManifest(config)).toThrow(/separately enrolled/);
    config.services[2].profileDir = "/isolated/second-profile";
    config.services[1].allowedHosts = ["resend.test"];
    expect(() => validateAcceptanceManifest(config)).toThrow(/separately enrolled/);
  });

  it("admits three overlapping Resend/Neon sessions using their isolated broker cells", async () => {
    const config = manifest();
    config.services[0].url = "https://resend.com/api-keys";
    config.services[1].url = "https://console.neon.tech/app/settings/api-keys";
    config.services[2].url = config.services[0].url;
    const groups = acceptanceProfileGroups(config);
    const authorities = groups.map((_, index) => new BrokerAuthority("account", `cell-${index}`));
    const sessions = await Promise.all(
      config.services.map(async (service, index) => {
        const authority = authorities[groups.findIndex((group) => group.indices.includes(index))];
        const principal = {
          accountId: "account",
          agentId: `agent-${index}`,
          clientId: `client-${index}`,
        };
        const capability = await authority.open(
          principal,
          siteResources([service.url]),
          async () => ({
            targetId: `target-${index}`,
            invoke: async () => ({}),
            close: async () => true,
            orphan: async () => undefined,
          }),
        );
        return { authority, principal, capability };
      }),
    );
    expect(authorities.map((authority) => authority.inventory().active)).toEqual([2, 1]);
    expect(new Set(sessions.map((session) => session.capability.targetId)).size).toBe(3);
    await Promise.all(
      sessions.map(({ authority, principal, capability }) =>
        authority.close(principal, capability),
      ),
    );
  });

  it("accepts the published manifest example with isolated repeated-provider custody", () => {
    const example = JSON.parse(
      readFileSync(new URL("./broker-live-acceptance.example.json", import.meta.url), "utf8"),
    );
    expect(
      acceptanceProfileGroups(validateAcceptanceManifest(example)).map((group) => group.indices),
    ).toEqual([[0, 1], [2]]);
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
