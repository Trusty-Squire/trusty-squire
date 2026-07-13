import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const context = { params: Promise.resolve({ slug: "short-link" }) };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /g/[slug]", () => {
  it("marks redirect responses as noindex and nofollow", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ url: "https://browser.example/#secret" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const response = await GET(new Request("https://trustysquire.ai/g/short-link"), context);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://browser.example/#secret");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("marks error responses as noindex and nofollow", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

    const response = await GET(new Request("https://trustysquire.ai/g/short-link"), context);

    expect(response.status).toBe(404);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});
