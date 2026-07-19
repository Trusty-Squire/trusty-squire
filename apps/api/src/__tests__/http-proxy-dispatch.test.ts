// Regression: the REAL defaultDispatch path (no injected dispatch).
//
// use_credential 502'd on every call in prod because defaultDispatch's
// pinned `lookup` returned the legacy single-address form, while Node's
// Happy Eyeballs (autoSelectFamily, default true ≥ Node 20) calls a
// custom lookup with { all: true } and expects an array — tripping
// ERR_INVALID_IP_ADDRESS → ProxyError("upstream_error"). Every existing
// proxy test injects a fake dispatch, so the real socket path was never
// exercised. This test hits a real loopback server through the real
// dispatch, so the lookup-contract bug can't silently come back.

import { describe, it, expect } from "vitest";
import { createServer, type IncomingMessage } from "node:http";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { HttpProxyExecutor, substituteSecret } from "../services/http-proxy.js";

interface Captured {
  authorization: string;
  userAgent: string;
}

// Spin up a loopback server, run `body` against its port, tear down.
// The handler always returns 200 application/json {}; captured request
// metadata is exposed for assertions.
async function withServer(run: (port: number, captured: Captured) => Promise<void>): Promise<void> {
  const captured: Captured = { authorization: "", userAgent: "" };
  const server = createServer((req: IncomingMessage, res) => {
    captured.authorization = String(req.headers["authorization"] ?? "");
    captured.userAgent = String(req.headers["user-agent"] ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  try {
    await run(port, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// Real defaultDispatch + defaultLookup (no `dispatch` override).
// blockPrivate:false to allow loopback; allowInsecureHttp for http://.
function realProxy(): HttpProxyExecutor {
  return new HttpProxyExecutor({ blockPrivate: false, allowInsecureHttp: true });
}

describe("HttpProxyExecutor — real defaultDispatch", () => {
  it("connects to a pinned loopback address and returns the upstream response", async () => {
    await withServer(async (port) => {
      const res = await realProxy().execute({
        accountId: "acct-test",
        http: { method: "GET", url: `http://127.0.0.1:${port}/v4/x`, headers: { accept: "application/json" } },
        fields: {},
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
    });
  });

  // Regression: a gzipped upstream JSON body was read as UTF-8 (mangling 0x8b
  // → U+FFFD) and forwarded with a stale `content-encoding: gzip`, so the
  // client's JSON.parse died on the leading 0x1f. The proxy must decompress and
  // drop the encoding header, returning clean text.
  async function withEncodedServer(
    encoding: "gzip" | "br",
    payload: unknown,
    run: (port: number) => Promise<void>,
  ): Promise<void> {
    const json = Buffer.from(JSON.stringify(payload), "utf8");
    const body = encoding === "gzip" ? gzipSync(json) : brotliCompressSync(json);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": encoding });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    try {
      await run(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("decompresses a gzipped upstream body and drops content-encoding", async () => {
    await withEncodedServer("gzip", { ok: true, msg: "héllo €" }, async (port) => {
      const res = await realProxy().execute({
        accountId: "acct-test",
        http: { method: "GET", url: `http://127.0.0.1:${port}/v1/chat`, headers: {} },
        fields: {},
      });
      expect(res.status).toBe(200);
      // Body is clean JSON, not gzip bytes read as text (no leading 0x1f / U+FFFD).
      expect(res.body.charCodeAt(0)).not.toBe(0x1f);
      expect(res.body).not.toContain("�");
      expect(JSON.parse(res.body)).toEqual({ ok: true, msg: "héllo €" });
      // Stale encoding header removed (body is now plaintext).
      expect(res.headers["content-encoding"]).toBeUndefined();
    });
  });

  it("decompresses a brotli upstream body too", async () => {
    await withEncodedServer("br", { ok: true, n: 42 }, async (port) => {
      const res = await realProxy().execute({
        accountId: "acct-test",
        http: { method: "GET", url: `http://127.0.0.1:${port}/v1/chat`, headers: {} },
        fields: {},
      });
      expect(JSON.parse(res.body)).toEqual({ ok: true, n: 42 });
      expect(res.headers["content-encoding"]).toBeUndefined();
    });
  });

  it("forwards the substituted secret header to the upstream", async () => {
    await withServer(async (port, captured) => {
      await realProxy().execute({
        accountId: "acct-test",
        http: {
          method: "GET",
          url: `http://127.0.0.1:${port}/v4/x`,
          headers: { authorization: "Bearer ${SECRET.token}" },
        },
        fields: { token: "s3cr3t-value" },
      });
      expect(captured.authorization).toBe("Bearer s3cr3t-value");
    });
  });

  it("sends a default User-Agent when the caller provides none", async () => {
    await withServer(async (port, captured) => {
      await realProxy().execute({
        accountId: "acct-test",
        http: { method: "GET", url: `http://127.0.0.1:${port}/v4/x`, headers: {} },
        fields: {},
      });
      // node:https sends no UA by default; the proxy must add one so providers
      // like Zenodo don't 403 the header-less request as suspected scraping.
      expect(captured.userAgent).toContain("trusty-squire");
    });
  });

  it("lets the caller override the User-Agent without sending a duplicate", async () => {
    await withServer(async (port, captured) => {
      await realProxy().execute({
        accountId: "acct-test",
        http: {
          method: "GET",
          url: `http://127.0.0.1:${port}/v4/x`,
          headers: { "User-Agent": "caller/9.9" },
        },
        fields: {},
      });
      // Exactly the caller's UA — a comma-joined value would mean two were sent.
      expect(captured.userAgent).toBe("caller/9.9");
    });
  });
});

describe("substituteSecret — field names with spaces / hyphens", () => {
  it("resolves a spaced field name (e.g. 'Api key')", () => {
    const out = substituteSecret(
      { method: "GET", url: "https://x/y", headers: { authorization: "Bearer ${SECRET.Api key}" } },
      { "Api key": "tok-123", Client_id: "cid" },
    );
    expect(out.headers?.authorization).toBe("Bearer tok-123");
  });

  it("resolves a hyphenated field name and stops at the closing brace", () => {
    const out = substituteSecret(
      { method: "GET", url: "https://x/y", headers: { "x-key": "${SECRET.access-key}/${SECRET.Api key}" } },
      { "access-key": "abc", "Api key": "def" },
    );
    expect(out.headers?.["x-key"]).toBe("abc/def");
  });

  it("still errors on a genuinely missing field", () => {
    expect(() =>
      substituteSecret(
        { method: "GET", url: "https://x/y", headers: { a: "${SECRET.nope}" } },
        { "Api key": "x" },
      ),
    ).toThrow();
  });
});
