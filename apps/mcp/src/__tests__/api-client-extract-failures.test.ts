import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api-client.js";

describe("ApiClient extract-failure diagnostics", () => {
  it("sends x-account-id to registry diagnostic endpoints", async () => {
    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ snapshots: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = new ApiClient({
      apiBaseUrl: "https://api.test",
      registryBaseUrl: "https://registry.test",
      agentSessionToken: "agent-token",
      accountId: "acct-123",
      fetch: fetchImpl,
    });

    await client.listExtractFailures(5);

    expect(capturedUrl).toBe("https://registry.test/v1/extract-failures?limit=5");
    expect(capturedHeaders).toMatchObject({
      Authorization: "Bearer agent-token",
      "Content-Type": "application/json",
      "x-account-id": "acct-123",
    });
  });
});
