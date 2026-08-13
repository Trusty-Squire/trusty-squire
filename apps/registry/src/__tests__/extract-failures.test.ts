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

  it("redacts credential-shaped strings on upload and diagnostic reads", async () => {
    const server = await buildServer({
      extractFailureStore: new InMemoryExtractFailureStore(),
    });
    const token = "sk-" + "a".repeat(44);

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
        extract_reason: `planner saw ${token}`,
        candidates: [`copy input: ${token}`],
        html: `<main><input value="${token}"></main>`,
      },
    });
    expect(upload.statusCode).toBe(201);
    const id = upload.json().id;

    const list = await server.inject({
      method: "GET",
      url: "/v1/extract-failures",
      headers: { "x-account-id": "acct-a" },
    });
    expect(JSON.stringify(list.json())).not.toContain(token);

    const detail = await server.inject({
      method: "GET",
      url: `/v1/extract-failures/${id}`,
      headers: { "x-account-id": "acct-a" },
    });
    expect(JSON.stringify(detail.json())).not.toContain(token);
    expect(detail.json().extract_reason).toContain("sk-REDACTED");
    expect(detail.json().candidates[0]).toContain("sk-REDACTED");
    expect(detail.json().html).toContain("sk-REDACTED");

    const html = await server.inject({
      method: "GET",
      url: `/v1/extract-failures/${id}/html`,
      headers: { "x-account-id": "acct-a" },
    });
    expect(html.body).not.toContain(token);
    expect(html.body).toContain("sk-REDACTED");

    await server.close();
  });

  it("redacts historical rows even if they were persisted before upload redaction", async () => {
    const store = new InMemoryExtractFailureStore();
    const token = "rnd_" + "b".repeat(32);
    const persisted = await store.upload("acct-a", {
      service: "Render",
      mcp_version: "0.6.14-rc.8",
      url: "https://dashboard.render.com",
      title: "API keys",
      step_label: "extract",
      extract_reason: `stored reason ${token}`,
      candidates: [`candidate ${token}`],
      html: `<main>${token}</main>`,
    });
    const server = await buildServer({ extractFailureStore: store });

    const list = await server.inject({
      method: "GET",
      url: "/v1/extract-failures",
      headers: { "x-account-id": "acct-a" },
    });
    expect(JSON.stringify(list.json())).not.toContain(token);

    const detail = await server.inject({
      method: "GET",
      url: `/v1/extract-failures/${persisted.id}`,
      headers: { "x-account-id": "acct-a" },
    });
    expect(JSON.stringify(detail.json())).not.toContain(token);

    await server.close();
  });

  it("redacts Deno deploy token-shaped diagnostic text", async () => {
    const server = await buildServer({
      extractFailureStore: new InMemoryExtractFailureStore(),
    });
    const token = "ddp_" + "c".repeat(36);

    const upload = await server.inject({
      method: "POST",
      url: "/v1/extract-failures",
      headers: { "x-account-id": "acct-a" },
      payload: {
        service: "deno-kv",
        mcp_version: "0.9.17-rc.3",
        url: "https://dash.deno.com/account",
        title: "Account Settings",
        step_label: "round-1-extract",
        extract_reason: `api_key='${token}'`,
        candidates: [token],
        html: `<main>${token}</main>`,
      },
    });
    expect(upload.statusCode).toBe(201);
    const id = upload.json().id;

    const detail = await server.inject({
      method: "GET",
      url: `/v1/extract-failures/${id}`,
      headers: { "x-account-id": "acct-a" },
    });
    expect(JSON.stringify(detail.json())).not.toContain(token);
    expect(detail.json().extract_reason).toContain("ddp_REDACTED");

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
