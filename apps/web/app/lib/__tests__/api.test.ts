import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiPost } from "../api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiPost errors", () => {
  it("falls back to HTTP <status> when an HTTP/2 non-JSON error has no statusText", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 })),
    );
    const failure = await apiPost("/v1/x", {}).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).message).toBe("HTTP 502");
  });
});
