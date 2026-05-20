// Tests for each MCP tool's handler against a mock ApiClient.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiCallError, type ApiClient } from "../api-client.js";
import {
  cancelTool,
  checkProvisionStatusTool,
  getCredentialTool,
  getUsageTool,
  listCredentialsTool,
  listServicesTool,
  listSubscriptionsTool,
  provisionTool,
  rotateCredentialTool,
  TOOLS,
  waitForApprovalTool,
} from "../tools/index.js";
import { waitForApprovalImpl } from "../tools/wait-for-approval.js";

// ── Minimal mock ApiClient that satisfies the surface our tools touch.

function makeMockApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    createRun: vi.fn(),
    getRun: vi.fn(),
    getCredential: vi.fn(),
    listCredentials: vi.fn(),
    listSubscriptions: vi.fn(),
    cancelSubscription: vi.fn(),
    getUsage: vi.fn(),
    listServices: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

describe("provision", () => {
  it("returns status=active when the API decision is silent", async () => {
    const api = makeMockApi({
      listServices: vi.fn().mockResolvedValue({
        adapters: [{ service: "resend", category: "email" }],
      }),
      createRun: vi.fn().mockResolvedValue({
        decision: "silent",
        run: { id: "run-1", state: "PROVISIONING" },
      }),
    } as unknown as ApiClient);
    const parsed = provisionTool.inputSchema.parse({
      service: "resend",
      project_name: "demo",
    });
    const res = (await provisionTool.handler(parsed, api)) as { status: string };
    expect(res.status).toBe("active");
  });

  it("returns status=pending_approval with the approval_url when needs_approval", async () => {
    const api = makeMockApi({
      listServices: vi.fn().mockResolvedValue({ adapters: [] }),
      createRun: vi.fn().mockResolvedValue({
        decision: "needs_approval",
        run: { id: "run-2", state: "PENDING_APPROVAL" },
        approval_url: "https://app.test/approve/abc",
        reasons: ["above_silent_max"],
        required_confidence: "high",
      }),
    } as unknown as ApiClient);
    const parsed = provisionTool.inputSchema.parse({
      service: "stripe",
      project_name: "demo",
      category: "payments",
      cost_cents: 5000,
      recurrence: "monthly",
    });
    const res = (await provisionTool.handler(parsed, api)) as {
      status: string;
      approval_url: string;
    };
    expect(res.status).toBe("pending_approval");
    expect(res.approval_url).toBe("https://app.test/approve/abc");
  });

  it("category is auto-resolved from the registry when omitted", async () => {
    const createRun = vi.fn().mockResolvedValue({
      decision: "silent",
      run: { id: "x", state: "PROVISIONING" },
    });
    const api = makeMockApi({
      listServices: vi.fn().mockResolvedValue({
        adapters: [{ service: "resend", category: "email" }],
      }),
      createRun,
    } as unknown as ApiClient);
    const parsed = provisionTool.inputSchema.parse({
      service: "resend",
      project_name: "demo",
    });
    await provisionTool.handler(parsed, api);
    const arg = (createRun.mock.calls[0] as [{ category: string }])[0];
    expect(arg.category).toBe("email");
  });
});

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
    expect(res.credentials[0].reference).toBe("vault://acct/c1");
    expect(listCredentials).toHaveBeenCalledOnce();
  });

  it("requires a paired session", async () => {
    await expect(listCredentialsTool.handler({}, null)).rejects.toThrow(
      /paired/,
    );
  });
});

describe("list_services", () => {
  it("returns ranked-by-default registry results", async () => {
    const api = makeMockApi({
      listServices: vi.fn().mockResolvedValue({
        adapters: [
          {
            service: "resend",
            latest_version: "0.1.0",
            display_name: "Resend",
            category: "email",
            homepage: "https://resend.com",
            description: null,
          },
          {
            service: "postmark",
            latest_version: "0.1.0",
            display_name: "Postmark",
            category: "email",
            homepage: "https://postmarkapp.com",
            description: null,
          },
        ],
      }),
    } as unknown as ApiClient);
    const parsed = listServicesTool.inputSchema.parse({});
    const res = (await listServicesTool.handler(parsed, api)) as {
      services: Array<{ service: string }>;
    };
    expect(res.services.map((s) => s.service)).toEqual(["resend", "postmark"]);
  });

  it("query filters the directory by substring", async () => {
    const api = makeMockApi({
      listServices: vi.fn().mockResolvedValue({
        adapters: [
          { service: "resend", display_name: "Resend", category: "email", latest_version: "0.1.0", homepage: "", description: null },
          { service: "postmark", display_name: "Postmark", category: "email", latest_version: "0.1.0", homepage: "", description: null },
        ],
      }),
    } as unknown as ApiClient);
    const parsed = listServicesTool.inputSchema.parse({ query: "post" });
    const res = (await listServicesTool.handler(parsed, api)) as {
      services: Array<{ service: string }>;
    };
    expect(res.services).toHaveLength(1);
    expect(res.services[0]?.service).toBe("postmark");
  });
});

describe("list_subscriptions / cancel / get_usage / rotate_credential", () => {
  it("list_subscriptions proxies to the API", async () => {
    const listSubscriptions = vi.fn().mockResolvedValue({ subscriptions: [{ id: "s1" }] });
    const api = makeMockApi({ listSubscriptions } as unknown as ApiClient);
    const parsed = listSubscriptionsTool.inputSchema.parse({});
    const res = (await listSubscriptionsTool.handler(parsed, api)) as {
      subscriptions: unknown[];
    };
    expect(res.subscriptions).toHaveLength(1);
  });

  it("cancel proxies to the API", async () => {
    const cancelSubscription = vi.fn().mockResolvedValue({ ok: true });
    const api = makeMockApi({ cancelSubscription } as unknown as ApiClient);
    const parsed = cancelTool.inputSchema.parse({ subscription_id: "s1" });
    await cancelTool.handler(parsed, api);
    expect(cancelSubscription).toHaveBeenCalledWith("s1");
  });

  it("get_usage proxies to the API", async () => {
    const getUsage = vi.fn().mockResolvedValue({
      monthly: { spent_cents: 0, budget_cents: 1000, remaining_cents: 1000 },
      daily: { spent_cents: 0, silent_max_cents: 500 },
      mandate_id: "m1",
    });
    const api = makeMockApi({ getUsage } as unknown as ApiClient);
    const parsed = getUsageTool.inputSchema.parse({});
    const res = (await getUsageTool.handler(parsed, api)) as {
      monthly: { budget_cents: number };
    };
    expect(res.monthly.budget_cents).toBe(1000);
  });

  it("rotate_credential returns the v0 stub response", async () => {
    const api = makeMockApi({} as unknown as ApiClient);
    const parsed = rotateCredentialTool.inputSchema.parse({ reference: "vault://x" });
    const res = (await rotateCredentialTool.handler(parsed, api)) as { status: string };
    expect(res.status).toBe("not_implemented");
  });
});

describe("wait_for_approval", () => {
  it("returns granted once state leaves PENDING_APPROVAL", async () => {
    const states = ["PENDING_APPROVAL", "PENDING_APPROVAL", "PROVISIONING"];
    const api = makeMockApi({
      getRun: vi.fn(async () => ({
        id: "r1",
        state: states.shift() ?? "PROVISIONING",
        service: "x",
        plan: "free",
        project_name: "p",
        subscription_id: null,
        failure_reason: null,
        created_at: "",
        completed_at: null,
      })),
    } as unknown as ApiClient);

    const sleep = vi.fn(async () => {});
    const res = await waitForApprovalImpl(
      { run_id: "r1", timeout_seconds: 30, poll_interval_seconds: 1 },
      api,
      { sleep },
    );
    expect(res.status).toBe("granted");
    expect(res.run_state).toBe("PROVISIONING");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("returns timeout when the deadline passes", async () => {
    const api = makeMockApi({
      getRun: vi.fn(async () => ({
        id: "r1",
        state: "PENDING_APPROVAL",
        service: "x",
        plan: "free",
        project_name: "p",
        subscription_id: null,
        failure_reason: null,
        created_at: "",
        completed_at: null,
      })),
    } as unknown as ApiClient);

    let virtualNow = 0;
    const sleep = vi.fn(async (ms: number) => {
      virtualNow += ms;
    });
    const res = await waitForApprovalImpl(
      { run_id: "r1", timeout_seconds: 1, poll_interval_seconds: 1 },
      api,
      { sleep, now: () => virtualNow },
    );
    expect(res.status).toBe("timeout");
  });

  it("returns denied when state goes REJECTED", async () => {
    const api = makeMockApi({
      getRun: vi.fn(async () => ({
        id: "r1",
        state: "REJECTED",
        service: "x",
        plan: "free",
        project_name: "p",
        subscription_id: null,
        failure_reason: "approval_denied",
        created_at: "",
        completed_at: null,
      })),
    } as unknown as ApiClient);
    const res = await waitForApprovalImpl(
      { run_id: "r1", timeout_seconds: 30, poll_interval_seconds: 1 },
      api,
      { sleep: async () => {} },
    );
    expect(res.status).toBe("denied");
    expect(res.reason).toBe("approval_denied");
  });
});

describe("TOOLS registry", () => {
  it("exposes 4 tools — the native-provision cluster is unregistered", () => {
    expect(TOOLS).toHaveLength(4);
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "check_provision_status",
      "get_credential",
      "list_credentials",
      "provision_any_service",
    ]);
  });

  it("includes the async provision pair (start + status poll)", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("provision_any_service");
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
      expect(t.description.length).toBeGreaterThan(100);
    }
  });

  it("provision's description tells the agent NOT to redirect users to manual signup", () => {
    expect(provisionTool.description).toMatch(/DO NOT instruct the user to sign up manually/);
  });

  it("waitForApprovalTool input schema accepts default poll/timeout", () => {
    expect(() => waitForApprovalTool.inputSchema.parse({ run_id: "r1" })).not.toThrow();
  });
});

describe("ApiCallError surface", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves status + code so the agent can decide how to handle", () => {
    const err = new ApiCallError(403, "wrong_account", "denied");
    expect(err.status).toBe(403);
    expect(err.code).toBe("wrong_account");
  });
});
