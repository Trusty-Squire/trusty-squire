import { describe, expect, it } from "vitest";
import {
  ApiCallError,
  ApiClient,
  MissingTokenError,
  Squire,
  approvalFromWire,
  isFinalStatus,
} from "../src/index.js";
import { APPROVAL_WIRE, jsonResponse, recordingFetch } from "./fixtures.js";

// Field names that would mean a secret value or card data reached the app.
const FORBIDDEN_FIELDS = [
  "fields",
  "secret_value",
  "sealed_card",
  "blob",
  "jws",
  "pan",
  "cvc",
  "card_number",
  "expiry",
];

function keysDeep(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      keysDeep(item, into);
    }
  }
  return into;
}

describe("ApiClient", () => {
  it("sends the bearer token and agent name, and throws ApiCallError with the API code", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(404, { error: "approval_not_found" }));
    const client = new ApiClient({
      apiBaseUrl: "https://api.test",
      agentSessionToken: "tok_123",
      agentIdentity: "Beeline",
      fetch,
    });
    const error = await client.getApproval("abc").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiCallError);
    expect(error).toMatchObject({ status: 404, code: "approval_not_found" });
    expect(calls[0]).toMatchObject({
      url: "https://api.test/v1/approvals/abc",
      method: "GET",
      headers: { Authorization: "Bearer tok_123", "X-Squire-Agent-Identity": "Beeline" },
    });
  });

  it("copies only display fields from saved cards, never the sealed card", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(200, [
        { id: "c1", label: "Visa", last4: "4242", brand: "visa", blob: "sealed", created_at: "x" },
      ]),
    );
    const client = new ApiClient({ apiBaseUrl: "https://api.test", agentSessionToken: "t", fetch });
    const cards = await client.listPaymentCards();
    expect(cards).toEqual([{ id: "c1", label: "Visa", last4: "4242", brand: "visa" }]);
  });

  it("uses PUT and DELETE for the webhook registration", async () => {
    const { fetch, calls } = recordingFetch((call) =>
      call.method === "DELETE"
        ? new Response(null, { status: 204 })
        : jsonResponse(200, { url: "https://app.test/hook", secret: "whsec_x", created_at: "t" }),
    );
    const client = new ApiClient({ apiBaseUrl: "https://api.test", agentSessionToken: "t", fetch });
    await client.registerApprovalWebhook("https://app.test/hook");
    await client.deleteApprovalWebhook();
    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ["PUT", "https://api.test/v1/approval-webhook", { url: "https://app.test/hook" }],
      ["DELETE", "https://api.test/v1/approval-webhook", undefined],
    ]);
  });

  it("exposes no method that claims a revealed value or a payment card", () => {
    const methods = Object.getOwnPropertyNames(ApiClient.prototype);
    // The consuming reveal read and the payment relay stay inside the Squire MCP.
    expect(methods).not.toContain("getCredentialFetchApproval");
    expect(methods).not.toContain("getPaymentApproval");
    expect(methods).not.toContain("confirmPaymentApproval");
    expect(methods).not.toContain("createPaymentApproval");
    expect(methods).not.toContain("browserFillCredential");
    expect(methods).toContain("getCredentialFetchApprovalStatus");
  });
});

describe("Squire", () => {
  it("refuses API calls without a token, but still builds for browser-only use", async () => {
    const squire = new Squire();
    await expect(squire.credentials.list()).rejects.toBeInstanceOf(MissingTokenError);
    expect(typeof squire.approvals.open).toBe("function");
  });

  it("returns a risky action as a pending camelCase approval card", async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(201, {
        approval_id: APPROVAL_WIRE.id,
        approval_url: APPROVAL_WIRE.approve_url,
        status: "pending",
        operation: "delete",
        approval: APPROVAL_WIRE,
      }),
    );
    const squire = new Squire({ token: "t", baseUrl: "https://api.test/", agentName: "Beeline", fetch });
    const { approval } = await squire.credentials.requestDelete({ service: "github" });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.test/v1/vault/mutation-approvals",
      body: { service: "github", operation: "delete" },
    });
    expect(approval).toEqual({
      id: APPROVAL_WIRE.id,
      kind: "credential_mutation",
      action: "delete",
      title: "Delete key: github / default",
      details: APPROVAL_WIRE.details,
      status: "pending",
      requestedBy: "Ruby",
      reason: null,
      createdAt: APPROVAL_WIRE.created_at,
      expiresAt: APPROVAL_WIRE.expires_at,
      approveUrl: APPROVAL_WIRE.approve_url,
    });
    for (const key of keysDeep(approval)) expect(FORBIDDEN_FIELDS).not.toContain(key);
  });

  it("maps card edits to the card mutation endpoint", async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(201, { approval: { ...APPROVAL_WIRE, kind: "card_mutation", action: "edit_card" } }),
    );
    const squire = new Squire({ token: "t", baseUrl: "https://api.test", fetch });
    const { approval } = await squire.cards.requestEdit({ cardId: "card_1" });
    expect(calls[0]?.body).toEqual({ operation: "edit_card", card_id: "card_1" });
    expect(approval.kind).toBe("card_mutation");
  });

  it("denies from the host app and reads the result back", async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(200, { approval: { ...APPROVAL_WIRE, status: "denied" } }),
    );
    const squire = new Squire({ token: "t", baseUrl: "https://api.test", fetch });
    const denied = await squire.approvals.deny(APPROVAL_WIRE.id);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `https://api.test/v1/approvals/${APPROVAL_WIRE.id}/deny`,
    });
    expect(denied.status).toBe("denied");
  });

  it("waits on the bounded status endpoint until the approval leaves pending", async () => {
    let reads = 0;
    const { fetch, calls } = recordingFetch(() => {
      reads += 1;
      return jsonResponse(200, {
        approval: { ...APPROVAL_WIRE, status: reads < 3 ? "pending" : "completed" },
      });
    });
    const squire = new Squire({ token: "t", baseUrl: "https://api.test", fetch });
    const settled = await squire.approvals.wait(APPROVAL_WIRE.id, { timeoutMs: 60_000 });
    expect(settled.status).toBe("completed");
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toMatch(/wait_for_decision=1&wait_ms=15000$/);
  });

  it("uses the vaulted key without ever receiving it", async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(200, { response: { status: 200, headers: {}, body: "{}", truncated: false } }),
    );
    const squire = new Squire({ token: "t", baseUrl: "https://api.test", fetch });
    await squire.credentials.use({
      service: "stripe",
      http: { method: "GET", url: "https://api.stripe.com/v1/balance", headers: { authorization: "Bearer ${SECRET}" } },
    });
    expect(calls[0]).toMatchObject({ url: "https://api.test/v1/vault/use", method: "POST" });
  });

  it("connects a user through the install handshake", async () => {
    const { fetch, calls } = recordingFetch((call) =>
      call.method === "POST"
        ? jsonResponse(200, { setup_code: "code1", confirm_url: "https://trustysquire.ai/c", expires_at: "x" })
        : jsonResponse(200, { status: "claimed", agent_session_token: "tok", account_id: "acct" }),
    );
    const squire = new Squire({ baseUrl: "https://api.test", fetch });
    const started = await squire.connect.start({ agentName: "Beeline" });
    const claimed = await squire.connect.poll(started.setup_code);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.test/v1/mcp/install/initiate",
      "https://api.test/v1/mcp/install/code1/status",
    ]);
    expect(claimed.agent_session_token).toBe("tok");
  });
});

describe("approval statuses", () => {
  it("treats approved and processing as not final", () => {
    expect(isFinalStatus("approved")).toBe(false);
    expect(isFinalStatus("processing")).toBe(false);
    expect(isFinalStatus("completed")).toBe(true);
    expect(isFinalStatus("denied")).toBe(true);
    expect(approvalFromWire(APPROVAL_WIRE).approveUrl).toBe(APPROVAL_WIRE.approve_url);
  });
});
