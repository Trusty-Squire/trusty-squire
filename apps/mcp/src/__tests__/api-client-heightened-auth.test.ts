import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api-client.js";

describe("ApiClient heightened-auth notification", () => {
  it("posts attempt-bound challenge identity with the machine session token", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response(
        JSON.stringify({
          sent: true,
          deduped: false,
          attempt_id: "attempt-1",
          challenge_revision: "revision-1",
          delivery: { channel: "telegram", status: "sent" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new ApiClient({
      apiBaseUrl: "https://api.test",
      registryBaseUrl: "https://registry.test",
      agentSessionToken: "machine-session",
      fetch: fetchImpl,
    });
    const controller = new AbortController();

    await expect(
      client.notifyHeightenedAuth(
        {
          service: "Resend",
          attempt_id: "attempt-1",
          challenge_revision: "revision-1",
          digit: "28",
          observed_at: "2026-09-10T12:00:00.000Z",
          expires_at: null,
          window_seconds: 120,
        },
        controller.signal,
      ),
    ).resolves.toMatchObject({ sent: true, delivery: { channel: "telegram" } });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = calls[0]!;
    expect(url).toBe("https://api.test/v1/notify/heightened-auth");
    expect(init).toMatchObject({
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: "Bearer machine-session" },
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      service: "Resend",
      attempt_id: "attempt-1",
      challenge_revision: "revision-1",
      digit: "28",
    });
  });
});
