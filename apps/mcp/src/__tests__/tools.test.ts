// Tests for the surviving MCP tools.
//
// The native-provision cluster (provision/cancel/get_usage/list_services/
// list_subscriptions/rotate_credential/wait_for_approval) was sunset in
// 0.8 along with the runtime + mandate-validator packages. What's left:
// the interactive provisioning driver, vault tools, and extract-failure
// diagnostic pair.

import { describe, expect, it, vi } from "vitest";
import { ApiCallError, type ApiClient } from "../api-client.js";
import {
  auditLogTool,
  listAppAccessTool,
  listCredentialsTool,
  listPaymentCardsTool,
  revokeAppAccessTool,
  buildToolRegistry,
  findTool,
  TOOLS,
} from "../tools/index.js";
import * as OperatorSurface from "../tools/provision-drive.js";
import {
  operateLoginTool,
  operateRecipeRunTool,
  operateRecipeSaveTool,
  operateFinishTool,
  provisionStartTool,
} from "../tools/provision-drive.js";

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

  it("filters by service case-insensitively (string) and skips null-service rows", async () => {
    const listCredentials = vi.fn().mockResolvedValue({
      credentials: [
        { reference: "vault://acct/exa", service: "Exa", label: "default" },
        { reference: "vault://acct/groq", service: "groq", label: "default" },
        { reference: "vault://acct/misc", service: null, label: "misc" },
      ],
    });
    const api = makeMockApi({ listCredentials } as unknown as ApiClient);
    const parsed = listCredentialsTool.inputSchema.parse({ service: "EXA" });
    const res = (await listCredentialsTool.handler(parsed, api)) as {
      credentials: { reference: string }[];
    };
    expect(res.credentials).toEqual([
      { reference: "vault://acct/exa", service: "Exa", label: "default" },
    ]);
  });

  it("filters by an array of services (any match, case-insensitive)", async () => {
    const listCredentials = vi.fn().mockResolvedValue({
      credentials: [
        { reference: "vault://acct/exa", service: "Exa", label: "default" },
        { reference: "vault://acct/groq", service: "groq", label: "default" },
        { reference: "vault://acct/other", service: "Resend", label: "default" },
      ],
    });
    const api = makeMockApi({ listCredentials } as unknown as ApiClient);
    const parsed = listCredentialsTool.inputSchema.parse({ service: ["GROQ", "exa"] });
    const res = (await listCredentialsTool.handler(parsed, api)) as {
      credentials: { reference: string }[];
    };
    expect(res.credentials.map((c) => c.reference)).toEqual([
      "vault://acct/exa",
      "vault://acct/groq",
    ]);
  });

  it("fields=summary returns only the compact summary projection", async () => {
    const listCredentials = vi.fn().mockResolvedValue({
      credentials: [
        {
          id: "c1",
          reference: "vault://acct/c1",
          service: "Exa",
          label: "default",
          field_names: ["api_key"],
          key_name: "EXA_API_KEY",
          type: "api_key",
          allowed_hosts: ["api.exa.ai"],
          auth_strategy: "api_key",
          signin_url: null,
          login_hosts: [],
          created_at: "2026-09-11T00:00:00.000Z",
          last_retrieved_at: null,
          retrieval_count: 0,
        },
      ],
    });
    const api = makeMockApi({ listCredentials } as unknown as ApiClient);
    const parsed = listCredentialsTool.inputSchema.parse({ fields: "summary" });
    const res = (await listCredentialsTool.handler(parsed, api)) as {
      credentials: Record<string, unknown>[];
    };
    expect(res.credentials).toHaveLength(1);
    // Exactly the summary shape — no key_name, type, auth_strategy, ids, etc.
    expect(Object.keys(res.credentials[0]!).sort()).toEqual([
      "allowed_hosts",
      "created_at",
      "field_names",
      "label",
      "reference",
      "service",
      "stale",
    ]);
    // stale is a boolean even when the API omits the field.
    expect(res.credentials[0]!.stale).toBe(false);
  });

  it("requires an active session", async () => {
    await expect(listCredentialsTool.handler({}, null)).rejects.toThrow(/Trusty Squire session/);
  });
});

describe("list_payment_cards", () => {
  it("returns only saved card IDs and labels", async () => {
    const listPaymentCards = vi
      .fn()
      .mockResolvedValue([{ id: "card_1", label: "Personal", brand: "Mastercard DBS" }]);
    const api = makeMockApi({ listPaymentCards } as unknown as ApiClient);

    await expect(listPaymentCardsTool.handler({}, api)).resolves.toEqual({
      cards: [{ id: "card_1", label: "Personal" }],
    });
  });
});

// Approval detection is system-owned: progress notifications surface the link
// while inject_card waits, and a bounded wait preserves the same approval.
describe("revoke_app_access", () => {
  it("revokes a grant by id via the egress DELETE route", async () => {
    const revokeEgressGrant = vi.fn().mockResolvedValue({ revoked: true, grant_id: "g_abc" });
    const api = makeMockApi({ revokeEgressGrant } as unknown as ApiClient);
    const parsed = revokeAppAccessTool.inputSchema.parse({ grant_id: "g_abc" });
    const res = (await revokeAppAccessTool.handler(parsed, api)) as { revoked: boolean };
    expect(res.revoked).toBe(true);
    expect(revokeEgressGrant).toHaveBeenCalledWith("g_abc");
  });

  it("requires grant_id", () => {
    expect(() => revokeAppAccessTool.inputSchema.parse({})).toThrow();
  });

  it("requires an active session", async () => {
    await expect(revokeAppAccessTool.handler({ grant_id: "g" }, null)).rejects.toThrow(
      /Trusty Squire session/,
    );
  });

  it("is marked destructive", () => {
    expect(revokeAppAccessTool.annotations?.destructiveHint).toBe(true);
  });
});

describe("list_app_access", () => {
  it("lists this account's egress grants", async () => {
    const listEgressGrants = vi.fn().mockResolvedValue({
      grants: [{ grant_id: "g1", credential_ref: "vault://a/c", revoked_at: null }],
    });
    const api = makeMockApi({ listEgressGrants } as unknown as ApiClient);
    const parsed = listAppAccessTool.inputSchema.parse({});
    const res = (await listAppAccessTool.handler(parsed, api)) as { grants: unknown[] };
    expect(res.grants).toHaveLength(1);
    expect(listEgressGrants).toHaveBeenCalledOnce();
  });
});

describe("audit_log", () => {
  it("reads the account audit ledger with optional filters", async () => {
    const listAudit = vi.fn().mockResolvedValue({
      events: [{ id: "e1", type: "proxy_executed", emitted_at: "now" }],
      next_before: null,
    });
    const api = makeMockApi({ listAudit } as unknown as ApiClient);
    const parsed = auditLogTool.inputSchema.parse({ limit: 10, type: "proxy_executed" });
    const res = (await auditLogTool.handler(parsed, api)) as { view: string; events: unknown[] };
    // Default is the shaped security ledger; an egress row with no recorded
    // status can't be shown to have succeeded, so it surfaces as an anomaly.
    expect(res.view).toBe("ledger");
    expect(res.events).toHaveLength(1);
    expect(listAudit).toHaveBeenCalledWith(expect.objectContaining({ type: "proxy_executed" }));
  });

  it("view:raw passes the legacy filters straight through", async () => {
    const listAudit = vi.fn().mockResolvedValue({
      events: [{ id: "e1", type: "proxy_executed", emitted_at: "now" }],
      next_before: null,
    });
    const api = makeMockApi({ listAudit } as unknown as ApiClient);
    const parsed = auditLogTool.inputSchema.parse({
      view: "raw",
      limit: 10,
      type: "proxy_executed",
    });
    const res = (await auditLogTool.handler(parsed, api)) as { events: unknown[] };
    expect(res.events).toHaveLength(1);
    expect(listAudit).toHaveBeenCalledWith({ limit: 10, type: "proxy_executed" });
  });

  it("rejects an out-of-range limit", () => {
    expect(() => auditLogTool.inputSchema.parse({ limit: 9999 })).toThrow();
  });

  it("requires an active session", async () => {
    await expect(auditLogTool.handler({}, null)).rejects.toThrow(/Trusty Squire session/);
  });

  it("is read-only", () => {
    expect(auditLogTool.annotations?.readOnlyHint).toBe(true);
  });
});

describe("TOOLS registry", () => {
  it("accepts a launch-only authenticated proxy on operate_start", () => {
    expect(
      provisionStartTool.inputSchema.parse({
        service_url: "https://service.example.com",
        proxy: "http://user:pass@proxy.example.com:8080",
      }),
    ).toMatchObject({ proxy: "http://user:pass@proxy.example.com:8080" });
  });

  it("rejects password-only HTTP proxy credentials before operate_start launches", () => {
    const result = provisionStartTool.inputSchema.safeParse({
      service_url: "https://service.example.com",
      proxy: "http://:token@proxy.example.com:8080",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          message:
            "Password-only HTTP/HTTPS proxy credentials are unsupported; include a non-empty username or use an unauthenticated proxy",
        }),
      ]);
    }
  });

  it("accepts unauthenticated SOCKS5 on operate_start", () => {
    expect(
      provisionStartTool.inputSchema.parse({
        service_url: "https://service.example.com",
        proxy: "socks5://proxy.example.com:1080",
      }),
    ).toMatchObject({ proxy: "socks5://proxy.example.com:1080" });
  });

  it("rejects authenticated SOCKS5 before operate_start launches", () => {
    const result = provisionStartTool.inputSchema.safeParse({
      service_url: "https://service.example.com",
      proxy: "socks5://user:pass@proxy.example.com:1080",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          message:
            "Authenticated SOCKS5 is unsupported by the browser engine; use HTTP/HTTPS with credentials or unauthenticated SOCKS5",
        }),
      ]);
    }
  });

  it("rejects malformed proxy credential encoding before operate_start launches", () => {
    const result = provisionStartTool.inputSchema.safeParse({
      service_url: "https://service.example.com",
      proxy: "http://user%ZZ:pass@proxy.example.com:8080",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          message: "proxy credentials contain invalid percent encoding",
        }),
      ]);
    }
  });

  it("exposes exactly the named flat target plus unchanged vault and recipe tools", () => {
    const target = [
      "operate_start",
      "operate_finish",
      "operate_observe",
      "operate_screenshot",
      "operate_network",
      "operate_navigate",
      "operate_click",
      "operate_type",
      "operate_select",
      "operate_press",
      "operate_scroll",
      "operate_wait",
      "operate_login",
      "operate_fill_credential",
      "operate_extract",
      "inject_card",
      "list_credentials",
      "list_payment_cards",
    ];
    const unchanged = [
      "audit_log",
      "delete_credential",
      "edit_credential",
      "fetch_credential",
      "grant_app_access",
      "list_app_access",
      "revoke_app_access",
      "store_credential",
      "use_credential",
      "operate_recipe_run",
      "operate_recipe_save",
    ];
    expect(target).toHaveLength(18);
    expect(TOOLS.map((tool) => tool.name).sort()).toEqual([...target, ...unchanged].sort());
    const assertNoKind = (schema: unknown): void => {
      if (typeof schema !== "object" || schema === null) return;
      if (!Array.isArray(schema)) expect(Object.keys(schema)).not.toContain("kind");
      for (const child of Object.values(schema)) assertNoKind(child);
    };
    for (const name of target) assertNoKind(findTool(name)!.jsonInputSchema);
  });

  it("drops every legacy payment orchestration alias", () => {
    expect(TOOLS.map((t) => t.name)).not.toContain("operate_payment_await");
    expect(findTool("operate_payment_await")).toBeNull();
    expect(findTool("operate_payment_status")).toBeNull();
    expect(findTool("operate_pay")).toBeNull();
  });

  it("adds the two-stage extract diagnostics profile only when explicitly enabled", async () => {
    for (const disabled of [undefined, "", "0", "false", "off"]) {
      const tools = buildToolRegistry(
        disabled === undefined ? {} : { TRUSTY_SQUIRE_DIAGNOSTICS: disabled },
      );
      expect(tools).toHaveLength(29);
      expect(tools.map((tool) => tool.name)).not.toEqual(
        expect.arrayContaining(["list_extract_failures", "get_extract_failure"]),
      );
    }

    const tools = buildToolRegistry({ TRUSTY_SQUIRE_DIAGNOSTICS: "1" });
    expect(tools).toHaveLength(31);
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["list_extract_failures", "get_extract_failure"]),
    );

    const list = tools.find((tool) => tool.name === "list_extract_failures")!;
    const detail = tools.find((tool) => tool.name === "get_extract_failure")!;
    const listExtractFailures = vi.fn().mockResolvedValue({
      snapshots: [{ id: "extract_1", service: "railway" }],
    });
    const getExtractFailure = vi.fn().mockResolvedValue({
      id: "extract_1",
      html: "<button>Copy token</button>",
      screenshot_jpeg_base64: "jpeg-bytes",
    });
    const api = makeMockApi({ listExtractFailures, getExtractFailure } as unknown as ApiClient);

    const listed = (await list.handler(list.inputSchema.parse({ limit: 5 }), api)) as {
      snapshots: { id: string }[];
    };
    const fetched = (await detail.handler(
      detail.inputSchema.parse({ id: listed.snapshots[0]!.id }),
      api,
    )) as Record<string, unknown>;

    expect(listExtractFailures).toHaveBeenCalledWith(5);
    expect(getExtractFailure).toHaveBeenCalledWith("extract_1");
    expect(fetched).toMatchObject({
      id: "extract_1",
      html: "<button>Copy token</button>",
      screenshot_omitted: true,
    });
    expect(fetched).not.toHaveProperty("screenshot_jpeg_base64");
  });

  it("does not expose the legacy async provision pair", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).not.toContain("provision");
    expect(names).not.toContain("check_provision_status");
  });

  it("exports only the registered operator tool definitions, without duplicates", () => {
    const exported = Object.values(OperatorSurface).filter(
      (value): value is (typeof TOOLS)[number] =>
        typeof value === "object" &&
        value !== null &&
        "name" in value &&
        "inputSchema" in value &&
        "handler" in value,
    );
    const names = exported.map((tool) => tool.name);
    expect(names.length).toBe(new Set(names).size);
    expect(names.sort()).toEqual(
      [
        "operate_start",
        "operate_finish",
        "operate_observe",
        "operate_screenshot",
        "operate_network",
        "operate_navigate",
        "operate_click",
        "operate_type",
        "operate_select",
        "operate_press",
        "operate_scroll",
        "operate_wait",
        "operate_login",
        "operate_fill_credential",
        "operate_extract",
        // Recipe tools are a separate preserved surface; no alias definitions remain.
        "operate_recipe_save",
        "operate_recipe_run",
      ].sort(),
    );
    expect(OperatorSurface.OPERATE_TOOLS.map((tool) => tool.name).sort()).toEqual(names);
  });

  it("does not register removed aliases or the action union", () => {
    for (const name of [
      "operate_act",
      "operate_observe_query",
      "operate_cart_add",
      "operate_form_select_many",
      "operate_captcha_gate",
      "operate_await_verification",
      "operate_prepare_login",
      "operate_store_login",
      "operate_seal_vault_credential",
    ]) {
      expect(findTool(name)).toBeNull();
    }
    expect(findTool("operate_login")).toBe(operateLoginTool);
  });

  it("exposes consolidated lifecycle/recipe schemas and drops their former standalone tool names", () => {
    const finishProperties = operateFinishTool.jsonInputSchema.properties as Record<
      string,
      unknown
    >;
    expect(finishProperties.outcome).toMatchObject({
      type: "string",
      enum: ["none", "credentials", "result"],
    });

    expect(operateRecipeRunTool.name).toBe("operate_recipe_run");
    expect(operateRecipeSaveTool.name).toBe("operate_recipe_save");
    const names = TOOLS.map((tool) => tool.name);
    expect(names).not.toEqual(
      expect.arrayContaining([
        "operate_prepare_login",
        "operate_store_login",
        "operate_seal_vault_credential",
        "operate_finish_task",
        "operate_use",
        "operate_remember",
      ]),
    );
  });

  it("every tool has a non-trivial description (helps the coding agent decide when to call)", () => {
    for (const t of TOOLS) {
      // >40 chars catches empty/one-word descriptions while allowing the
      // intentionally-terse credential tools (delete_credential,
      // poll_credential_access) whose verbatim copy is short by design.
      expect(t.description.length).toBeGreaterThan(40);
    }
  });

  it("documents DOM observation reconstruction on every operator entry point", () => {
    for (const name of ["operate_start", "operate_observe"]) {
      const description = TOOLS.find((tool) => tool.name === name)?.description ?? "";
      expect(description).toContain("browser-use-dom");
      expect(description).toContain("delta:true");
      expect(description).toContain("replaces the entire prior tree");
      expect(description).toContain("when omitted retain the prior tree");
      expect(description).toContain("removed");
      expect(description).toContain("reset the prior view");
      expect(description).toContain("Refs stay usable on the same document");
    }
    const start = TOOLS.find((tool) => tool.name === "operate_start")?.description ?? "";
    expect(start).toContain("browser-use-control-query");
    expect(start).toContain("safe_table");
    expect(start).toContain("[ref,role,facts?]");
    expect(start).not.toContain("observe_query");
    const observe = TOOLS.find((tool) => tool.name === "operate_observe")?.description ?? "";
    expect(observe).toContain("browser-use-control-query");
    expect(observe).toContain("safe_table");
    expect(observe).toContain("[ref,role,facts?]");
    expect(observe).not.toContain("observe_query");
  });
});

describe("ApiCallError surface", () => {
  it("preserves status + code so the agent can decide how to handle", () => {
    const err = new ApiCallError(403, "wrong_account", "denied");
    expect(err.status).toBe(403);
    expect(err.code).toBe("wrong_account");
  });
});
