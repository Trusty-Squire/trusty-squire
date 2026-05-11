// RegistryClient tests — fetch is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdapterDisabledError,
  AdapterNotFoundError,
  RegistryClient,
  RegistryUnavailableError,
} from "../index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const MANIFEST = { service: "demo", version: "0.1.0" };

describe("RegistryClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("200 → returns the manifest field", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ manifest: MANIFEST, signature: "sig" }));
    const client = new RegistryClient({
      baseUrl: "http://test/",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const m = await client.load("demo", "0.1.0");
    expect(m).toEqual(MANIFEST);
    const url = (fetchMock.mock.calls[0] as [string])[0];
    expect(url).toBe("http://test/adapters/demo/0.1.0");
  });

  it("second call within TTL is served from cache (no extra fetch)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ manifest: MANIFEST, signature: "sig" }));
    const client = new RegistryClient({
      baseUrl: "http://test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.load("demo", "0.1.0");
    await client.load("demo", "0.1.0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("404 → AdapterNotFoundError", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false }, 404));
    const client = new RegistryClient({
      baseUrl: "http://test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.load("nope", "0.1.0")).rejects.toThrow(AdapterNotFoundError);
  });

  it("410 → AdapterDisabledError with reason", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: false, disabled_reason: "kill-switch" }, 410),
    );
    const client = new RegistryClient({
      baseUrl: "http://test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.load("demo", "0.1.0")).rejects.toThrow(AdapterDisabledError);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: false, disabled_reason: "kill-switch" }, 410),
    );
    try {
      await client.load("demo", "0.1.0");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterDisabledError);
      if (err instanceof AdapterDisabledError) {
        expect(err.reason).toBe("kill-switch");
      }
    }
  });

  it("network error → RegistryUnavailableError", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("DNS failure"));
    const client = new RegistryClient({
      baseUrl: "http://test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.load("demo", "0.1.0")).rejects.toThrow(RegistryUnavailableError);
  });

  it("5xx response → RegistryUnavailableError", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false }, 502));
    const client = new RegistryClient({
      baseUrl: "http://test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.load("demo", "0.1.0")).rejects.toThrow(RegistryUnavailableError);
  });

  it("invalidate() clears the cache for a single (service, version)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ manifest: MANIFEST }))
      .mockResolvedValueOnce(jsonResponse({ manifest: { ...MANIFEST, version: "0.1.0" } }));
    const client = new RegistryClient({
      baseUrl: "http://test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.load("demo", "0.1.0");
    client.invalidate("demo", "0.1.0");
    await client.load("demo", "0.1.0");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
