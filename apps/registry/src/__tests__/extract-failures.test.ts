import { describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import {
  InMemoryExtractFailureStore,
  MAX_HTML_BYTES,
  UPLOAD_RATE_LIMIT_PER_HOUR,
} from "../extract-failure-store.js";

describe("extract-failure routes", () => {
  it("uploads, lists, and fetches snapshots scoped to the account header", async () => {
    const server = await buildServer({
      extractFailureStore: new InMemoryExtractFailureStore(),
    });

    const upload = await server.inject({
      method: "POST",
      url: "/v1/extract-failures",
      headers: { "x-account-id": "acct-a" },
      payload: {
        service: "Railway",
        mcp_version: "0.6.14-rc.8",
        url: "https://railway.com/account/tokens",
        title: "Tokens",
        step_label: "post-verify round 2/5: extract",
        extract_reason: "API key visible in modal",
        candidates: ["copy input: abc123"],
        html: "<main><input value=\"abc123\"></main>",
        screenshot_jpeg_base64: Buffer.from("jpeg-bytes").toString("base64"),
      },
    });

    expect(upload.statusCode).toBe(201);
    const id = upload.json().id;
    expect(typeof id).toBe("string");

    const mine = await server.inject({
      method: "GET",
      url: "/v1/extract-failures",
      headers: { "x-account-id": "acct-a" },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().snapshots).toHaveLength(1);
    expect(mine.json().snapshots[0]).toMatchObject({
      id,
      service: "Railway",
      screenshot_bytes: "jpeg-bytes".length,
    });

    const other = await server.inject({
      method: "GET",
      url: "/v1/extract-failures",
      headers: { "x-account-id": "acct-b" },
    });
    expect(other.statusCode).toBe(200);
    expect(other.json().snapshots).toHaveLength(0);

    const detail = await server.inject({
      method: "GET",
      url: `/v1/extract-failures/${id}`,
      headers: { "x-account-id": "acct-a" },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id,
      html: "<main><input value=\"abc123\"></main>",
      candidates: ["copy input: abc123"],
      screenshot_jpeg_base64: Buffer.from("jpeg-bytes").toString("base64"),
    });

    const blocked = await server.inject({
      method: "GET",
      url: `/v1/extract-failures/${id}`,
      headers: { "x-account-id": "acct-b" },
    });
    expect(blocked.statusCode).toBe(404);

    await server.close();
  });

  it("rejects invalid bodies and oversized html", async () => {
    const server = await buildServer({
      extractFailureStore: new InMemoryExtractFailureStore(),
    });

    const invalid = await server.inject({
      method: "POST",
      url: "/v1/extract-failures",
      headers: { "x-account-id": "acct-a" },
      payload: { service: "" },
    });
    expect(invalid.statusCode).toBe(400);

    const oversized = await server.inject({
      method: "POST",
      url: "/v1/extract-failures",
      headers: { "x-account-id": "acct-a" },
      payload: {
        service: "Railway",
        mcp_version: "0.6.14-rc.8",
        url: "https://railway.com",
        title: "Tokens",
        step_label: "extract",
        extract_reason: "visible token",
        candidates: [],
        html: "x".repeat(MAX_HTML_BYTES + 1),
      },
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({
      error: "payload_too_large",
      field: "html",
    });

    await server.close();
  });

  it("rate-limits uploads per account", async () => {
    const server = await buildServer({
      extractFailureStore: new InMemoryExtractFailureStore(),
    });

    const payload = {
      service: "Railway",
      mcp_version: "0.6.14-rc.8",
      url: "https://railway.com",
      title: "Tokens",
      step_label: "extract",
      extract_reason: "visible token",
      candidates: [],
      html: "<main>token</main>",
    };

    for (let i = 0; i < UPLOAD_RATE_LIMIT_PER_HOUR; i += 1) {
      const res = await server.inject({
        method: "POST",
        url: "/v1/extract-failures",
        headers: { "x-account-id": "acct-a" },
        payload,
      });
      expect(res.statusCode).toBe(201);
    }

    const limited = await server.inject({
      method: "POST",
      url: "/v1/extract-failures",
      headers: { "x-account-id": "acct-a" },
      payload,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();

    await server.close();
  });
});
