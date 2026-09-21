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

describe("HttpProxyExecutor.executeStream", () => {
  it("emits the first upstream chunk before later chunks arrive", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => {
        res.write("data: second\n\n");
        res.end();
      }, 200);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    try {
      const started = Date.now();
      const streamed = await realProxy().executeStream({
        accountId: "acct-test",
        http: { method: "GET", url: `http://127.0.0.1:${port}/v1/stream`, headers: {} },
        fields: {},
      });
      expect(streamed.headers["content-type"]).toBe("text/event-stream");
      expect(streamed.headers["content-length"]).toBeUndefined();

      const arrivals: Array<{ at: number; text: string }> = [];
      for await (const chunk of streamed.body) {
        arrivals.push({
          at: Date.now() - started,
          text: Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk),
        });
      }
      expect(arrivals.length).toBeGreaterThanOrEqual(1);
      expect(arrivals[0]!.text).toContain("data: first");
      expect(arrivals.at(-1)!.text).toContain("data: second");
      // The load-bearing property is ordering: the first event is observed on
      // its own, well before the second was even written. A wall-clock bound on
      // arrival[0] would flake on a loaded runner; the GAP cannot.
      expect(arrivals.at(-1)!.at - arrivals[0]!.at).toBeGreaterThanOrEqual(150);
      expect(streamed.headers["content-length"]).toBeUndefined();
      await expect(streamed.bodyComplete).resolves.toEqual({
        bytes: Buffer.byteLength("data: first\n\ndata: second\n\n", "utf8"),
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("forwards a body far larger than the buffered cap intact", async () => {
    const payload = "y".repeat(512 * 1024);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    // The buffered cap that use_credential lives under is 64 bytes here; the
    // streaming pass-through buffers nothing, so it must not be gated by it.
    const proxy = new HttpProxyExecutor({
      blockPrivate: false,
      allowInsecureHttp: true,
      maxResponseBytes: 64,
    });
    try {
      const streamed = await proxy.executeStream({
        accountId: "acct-test",
        http: { method: "GET", url: `http://127.0.0.1:${port}/big`, headers: {} },
        fields: {},
      });
      const chunks: Buffer[] = [];
      for await (const chunk of streamed.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      expect(Buffer.concat(chunks).toString("utf8")).toBe(payload);
      await expect(streamed.bodyComplete).resolves.toEqual({ bytes: payload.length });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports the teardown reason when the upstream body never finishes", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => res.destroy(), 30);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const proxy = new HttpProxyExecutor({ blockPrivate: false, allowInsecureHttp: true });
    try {
      const streamed = await proxy.executeStream({
        accountId: "acct-test",
        http: { method: "GET", url: `http://127.0.0.1:${port}/stream`, headers: {} },
        fields: {},
      });
      let delivered = 0;
      try {
        for await (const chunk of streamed.body) {
          delivered += (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))).length;
        }
      } catch {
        // the reset surfaces to the consumer too; the outcome is what matters
      }
      const outcome = await streamed.bodyComplete;
      expect(outcome.bytes).toBe(delivered);
      expect(outcome.error).toBeTypeOf("string");
      expect(outcome.error).not.toBe("");
      expect(outcome.clientClosed).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("attributes an upstream reset to the upstream even when the caller never read", async () => {
    // The inversion guard: `dest` is torn down here too, so a rule that reads
    // settled stream state could call this a caller cancel. The upstream failed
    // first, and that ordering is what decides it.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => res.destroy(), 30);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const proxy = new HttpProxyExecutor({ blockPrivate: false, allowInsecureHttp: true });
    try {
      const streamed = await proxy.executeStream({
        accountId: "acct-test",
        http: { method: "GET", url: `http://127.0.0.1:${port}/stream`, headers: {} },
        fields: {},
      });
      const outcome = await streamed.bodyComplete;
      expect(outcome.clientClosed).toBeUndefined();
      expect(outcome.error).toBeTypeOf("string");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports a body-phase stall as a timeout, not a generic upstream error", async () => {
    // Headers arrive, then the upstream goes quiet forever. The dispatch promise
    // has already settled by then, so the socket budget's ProxyError has to
    // reach the body reader for the caller to see 504 rather than 502.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"partial":');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const proxy = new HttpProxyExecutor({
      blockPrivate: false,
      allowInsecureHttp: true,
      headersTimeoutMs: 150,
      bodyTimeoutMs: 150,
    });
    try {
      await expect(
        proxy.execute({
          accountId: "acct-test",
          http: { method: "GET", url: `http://127.0.0.1:${port}/slow`, headers: {} },
          fields: {},
        }),
      ).rejects.toMatchObject({ code: "timeout" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("attributes a consumer-side teardown to the caller, not to the upstream", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      const timer = setInterval(() => res.write("data: more\n\n"), 20);
      res.on("close", () => clearInterval(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const proxy = new HttpProxyExecutor({ blockPrivate: false, allowInsecureHttp: true });
    try {
      const streamed = await proxy.executeStream({
        accountId: "acct-test",
        http: { method: "GET", url: `http://127.0.0.1:${port}/stream`, headers: {} },
        fields: {},
      });
      await new Promise<void>((resolve) => streamed.body.once("data", () => resolve()));
      streamed.body.destroy();
      const outcome = await streamed.bodyComplete;
      expect(outcome.clientClosed).toBe(true);
      expect(outcome.error).toBeUndefined();
      expect(outcome.bytes).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns an empty body for a bodyless response that still advertises gzip", async () => {
    // A CDN answers a conditional GET with 304 + content-encoding: gzip and no
    // bytes. Handing that empty stream to a decompressor fails with zlib's
    // "unexpected end of file"; there is nothing to decode.
    const server = createServer((_req, res) => {
      res.writeHead(304, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const proxy = new HttpProxyExecutor({ blockPrivate: false, allowInsecureHttp: true });
    const http = { method: "GET", url: `http://127.0.0.1:${port}/cached`, headers: {} };
    try {
      const buffered = await proxy.execute({ accountId: "acct-test", http, fields: {} });
      expect(buffered.status).toBe(304);
      expect(buffered.body).toBe("");

      const streamed = await proxy.executeStream({ accountId: "acct-test", http, fields: {} });
      expect(streamed.status).toBe(304);
      const chunks: Buffer[] = [];
      for await (const chunk of streamed.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      expect(Buffer.concat(chunks).toString("utf8")).toBe("");
      await expect(streamed.bodyComplete).resolves.toEqual({ bytes: 0 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("streams a compressed body past the buffered cap without truncating it", async () => {
    const payload = "z".repeat(512 * 1024);
    const body = gzipSync(Buffer.from(payload, "utf8"));
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    // The buffered cap is 64 bytes here. Streaming holds nothing, so a gzipped
    // body must not be cut off where the same bytes served plain are not.
    const proxy = new HttpProxyExecutor({
      blockPrivate: false,
      allowInsecureHttp: true,
      maxResponseBytes: 64,
    });
    try {
      const streamed = await proxy.executeStream({
        accountId: "acct-test",
        http: { method: "GET", url: `http://127.0.0.1:${port}/big.gz`, headers: {} },
        fields: {},
      });
      expect(streamed.headers["content-encoding"]).toBeUndefined();
      const chunks: Buffer[] = [];
      for await (const chunk of streamed.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      expect(Buffer.concat(chunks).toString("utf8")).toBe(payload);
      await expect(streamed.bodyComplete).resolves.toEqual({ bytes: payload.length });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("execute() bounds a compressed body's decompressed output", async () => {
    const bomb = gzipSync(Buffer.alloc(1024 * 1024, 0x61));
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      res.end(bomb);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const proxy = new HttpProxyExecutor({
      blockPrivate: false,
      allowInsecureHttp: true,
      maxResponseBytes: 4096,
    });
    try {
      await expect(
        proxy.execute({
          accountId: "acct-test",
          http: { method: "GET", url: `http://127.0.0.1:${port}/bomb`, headers: {} },
          fields: {},
        }),
      ).rejects.toMatchObject({ code: "response_too_large" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("execute() bounds the WIRE bytes of a compressed body, not just its output", async () => {
    // Concatenated empty gzip members: ~20 bytes each on the wire, zero bytes
    // out. Metering only the decoder's output would read this forever.
    const empty = gzipSync(Buffer.alloc(0));
    const wire = Buffer.concat(Array.from({ length: 4000 }, () => empty));
    expect(wire.length).toBeGreaterThan(8 * 1024);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      res.end(wire);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const proxy = new HttpProxyExecutor({
      blockPrivate: false,
      allowInsecureHttp: true,
      maxResponseBytes: 8 * 1024,
    });
    try {
      await expect(
        proxy.execute({
          accountId: "acct-test",
          http: { method: "GET", url: `http://127.0.0.1:${port}/padded`, headers: {} },
          fields: {},
        }),
      ).rejects.toMatchObject({ code: "response_too_large" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("execute() rejects an over-cap declared length before reading the body", async () => {
    // Headers promise more than the cap and then the body never arrives. Only a
    // pre-read check can answer; a mid-stream meter would wait forever.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "100000" });
      res.write("a");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const proxy = new HttpProxyExecutor({
      blockPrivate: false,
      allowInsecureHttp: true,
      maxResponseBytes: 1024,
      headersTimeoutMs: 2000,
      bodyTimeoutMs: 2000,
    });
    try {
      await expect(
        proxy.execute({
          accountId: "acct-test",
          http: { method: "GET", url: `http://127.0.0.1:${port}/promised`, headers: {} },
          fields: {},
        }),
      ).rejects.toMatchObject({ code: "response_too_large" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns an empty body for a chunked empty body that still advertises gzip", async () => {
    // No content-length: 0 to read off — the emptiness is only visible in the
    // bytes, which is exactly the framing the header enumeration cannot see.
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "transfer-encoding": "chunked",
      });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const proxy = new HttpProxyExecutor({ blockPrivate: false, allowInsecureHttp: true });
    const http = { method: "GET", url: `http://127.0.0.1:${port}/empty`, headers: {} };
    try {
      const buffered = await proxy.execute({ accountId: "acct-test", http, fields: {} });
      expect(buffered.status).toBe(200);
      expect(buffered.body).toBe("");

      const streamed = await proxy.executeStream({ accountId: "acct-test", http, fields: {} });
      const chunks: Buffer[] = [];
      for await (const chunk of streamed.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      expect(Buffer.concat(chunks).toString("utf8")).toBe("");
      await expect(streamed.bodyComplete).resolves.toEqual({ bytes: 0 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("passes a 204 through even though it carries no content-type", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const proxy = new HttpProxyExecutor({ blockPrivate: false, allowInsecureHttp: true });
    const http = { method: "DELETE", url: `http://127.0.0.1:${port}/resource/1`, headers: {} };
    try {
      const buffered = await proxy.execute({ accountId: "acct-test", http, fields: {} });
      expect(buffered.status).toBe(204);
      expect(buffered.body).toBe("");

      const streamed = await proxy.executeStream({ accountId: "acct-test", http, fields: {} });
      expect(streamed.status).toBe(204);
      await expect(streamed.bodyComplete).resolves.toEqual({ bytes: 0 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("execute() still rejects response_too_large when the cap trips mid-stream", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("a".repeat(40));
      res.write("b".repeat(40));
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const proxy = new HttpProxyExecutor({
      blockPrivate: false,
      allowInsecureHttp: true,
      maxResponseBytes: 50,
    });
    try {
      await expect(
        proxy.execute({
          accountId: "acct-test",
          http: { method: "GET", url: `http://127.0.0.1:${port}/big`, headers: {} },
          fields: {},
        }),
      ).rejects.toMatchObject({ code: "response_too_large" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
