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
import { HttpProxyExecutor, substituteSecret } from "../services/http-proxy.js";

interface Captured {
  authorization: string;
}

// Spin up a loopback server, run `body` against its port, tear down.
// The handler always returns 200 application/json {}; captured request
// metadata is exposed for assertions.
async function withServer(run: (port: number, captured: Captured) => Promise<void>): Promise<void> {
  const captured: Captured = { authorization: "" };
  const server = createServer((req: IncomingMessage, res) => {
    captured.authorization = String(req.headers["authorization"] ?? "");
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
