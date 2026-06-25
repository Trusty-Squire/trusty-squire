// Tests for the surviving MCP tools.
//
// The native-provision cluster (provision/cancel/get_usage/list_services/
// list_subscriptions/rotate_credential/wait_for_approval) was sunset in
// 0.8 along with the runtime + mandate-validator packages. What's left:
// the universal provision tool, its async status poll, the two vault
// reads, and the extract-failure diagnostic pair.

import { describe, expect, it, vi } from "vitest";
import { ApiCallError, type ApiClient } from "../api-client.js";
import {
  checkProvisionStatusTool,
  listCredentialsTool,
  provisionTool,
  TOOLS,
} from "../tools/index.js";

function makeMockApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listCredentials: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

describe("list_credentials", () => {
  it("returns the vault credential metadata list", async () => {
    const listCredentials = vi.fn().mockResolvedValue({
      credentials: [
        {
          id: "c1",
          reference: "vault://acct/c1",
          service: "Resend",
          key_name: "RESEND_API_KEY",
          type: "api_key",
          created_at: "now",
          last_retrieved_at: null,
          retrieval_count: 0,
        },
      ],
    });
    const api = makeMockApi({ listCredentials } as unknown as ApiClient);
    const parsed = listCredentialsTool.inputSchema.parse({});
    const res = (await listCredentialsTool.handler(parsed, api)) as {
      credentials: { reference: string }[];
    };
    expect(res.credentials).toHaveLength(1);
    expect(res.credentials[0]?.reference).toBe("vault://acct/c1");
    expect(listCredentials).toHaveBeenCalledOnce();
  });

  it("requires an active session", async () => {
    await expect(listCredentialsTool.handler({}, null)).rejects.toThrow(
      /Trusty Squire session/,
    );
  });
});

describe("TOOLS registry", () => {
  it("exposes the post-0.8 public surface incl. the credential lifecycle tools", () => {
    // 5 surviving post-0.8 tools + 2 credential write tools (store/use —
    // write-only sink; rotation = re-store, delete is web-only) + grant_app_access
    // (egress grants: a deployed app uses a vaulted credential via the proxy).
    // The read-back get_credential tool was removed: in the sink model an
    // agent never sees a raw secret value.
    // 8 base tools + the 7 default-on interactive provisioning tools
    // (provision_start/observe/act/captcha_gate/await_verification/extract/
    // finish — opt out with PROVISION_DRIVE_TOOLS=0).
    expect(TOOLS).toHaveLength(15);
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "check_provision_status",
      "get_extract_failure",
      "grant_app_access",
      "list_credentials",
      "list_extract_failures",
      "provision",
      "provision_act",
      "provision_await_verification",
      "provision_captcha_gate",
      "provision_extract",
      "provision_finish",
      "provision_observe",
      "provision_start",
      "store_credential",
      "use_credential",
    ]);
  });

  it("includes the async provision pair (start + status poll)", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("provision");
    expect(names).toContain("check_provision_status");
  });

  it("check_provision_status reports unknown_run for an unrecognized run_id", async () => {
    const res = (await checkProvisionStatusTool.handler(
      { run_id: "no-such-run" },
      null,
    )) as { status: string };
    expect(res.status).toBe("unknown_run");
  });

  it("every tool has a non-trivial description (helps the coding agent decide when to call)", () => {
    for (const t of TOOLS) {
      // >40 chars catches empty/one-word descriptions while allowing the
      // intentionally-terse credential tools (delete_credential,
      // poll_credential_access) whose verbatim copy is short by design.
      expect(t.description.length).toBeGreaterThan(40);
    }
  });

  it("provision's description tells the agent to poll check_provision_status (the long-running contract)", () => {
    expect(provisionTool.description).toMatch(/poll check_provision_status/);
  });
});

describe("ApiCallError surface", () => {
  it("preserves status + code so the agent can decide how to handle", () => {
    const err = new ApiCallError(403, "wrong_account", "denied");
    expect(err.status).toBe(403);
    expect(err.code).toBe("wrong_account");
  });
});
