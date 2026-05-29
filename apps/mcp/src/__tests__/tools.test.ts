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
  getCredentialTool,
  listCredentialsTool,
  provisionTool,
  TOOLS,
} from "../tools/index.js";

function makeMockApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getCredential: vi.fn(),
    listCredentials: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

describe("get_credential", () => {
  it("passes the purpose through to the API", async () => {
    const getCredential = vi.fn().mockResolvedValue({
      value: "secret",
      reference: "vault://x",
      retrieved_at: "now",
    });
    const api = makeMockApi({ getCredential } as unknown as ApiClient);
    const parsed = getCredentialTool.inputSchema.parse({
      reference: "vault://x",
      purpose: "send-email",
    });
    const res = (await getCredentialTool.handler(parsed, api)) as { value: string };
    expect(res.value).toBe("secret");
    expect(getCredential).toHaveBeenCalledWith("vault://x", "send-email");
  });

  it("surfaces ApiCallError on 401", async () => {
    const api = makeMockApi({
      getCredential: vi.fn().mockRejectedValue(new ApiCallError(401, "unauth", "401")),
    } as unknown as ApiClient);
    const parsed = getCredentialTool.inputSchema.parse({
      reference: "vault://x",
      purpose: "p",
    });
    await expect(getCredentialTool.handler(parsed, api)).rejects.toMatchObject({
      status: 401,
      code: "unauth",
    });
  });
});

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
    // 6 surviving post-0.8 tools + 6 credential-lifecycle tools (PR-8).
    expect(TOOLS).toHaveLength(12);
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "check_provision_status",
      "delete_credential",
      "get_credential",
      "get_extract_failure",
      "list_credentials",
      "list_extract_failures",
      "poll_credential_access",
      "provision",
      "request_credential",
      "rotate_credential",
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
