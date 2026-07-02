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

import { issueMachineToken } from "../api-client.js";

describe("issueMachineToken timeout (no more indefinite connect hang)", () => {
  it("aborts and throws install_timeout when the API never responds", async () => {
    // A fetch that never resolves but rejects on abort — the stalled-API case.
    const hangingFetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      })) as unknown as typeof fetch;
    await expect(
      issueMachineToken("https://x.invalid", hangingFetch, undefined, 20),
    ).rejects.toMatchObject({ code: "install_timeout" });
  });
});
