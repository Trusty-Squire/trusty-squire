// PR-6 — http-proxy hardening: secret substitution + SSRF address
// blocking + the executor's URL / DNS-pin / response guards. These are
// the security surface; exercised in isolation (no real sockets).

import { describe, expect, it } from "vitest";
import {
  HttpProxyExecutor,
  ProxyError,
  isBlockedAddress,
  jsonEscapeSecret,
  substituteSecret,
  type DispatchInput,
  type DispatchResult,
} from "../services/http-proxy.js";

// ProxyError carries the machine code on `.code`; its message is prose.
// These helpers assert the code, not the message.
function syncCode(fn: () => unknown): string {
  try {
    fn();
    return "(no throw)";
  } catch (e) {
    return e instanceof ProxyError ? e.code : `(${String(e)})`;
  }
}
async function asyncCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "(no throw)";
  } catch (e) {
    return e instanceof ProxyError ? e.code : `(${String(e)})`;
  }
}

describe("substituteSecret", () => {
  const base = { method: "POST", url: "https://api.openai.com/v1/x" };

  it("injects ${SECRET} into a header value", () => {
    const out = substituteSecret(
      { ...base, headers: { authorization: "Bearer ${SECRET}" } },
      "sk-123",
    );
    expect(out.headers!.authorization).toBe("Bearer sk-123");
  });

  it("injects ${SECRET} into the body", () => {
    const out = substituteSecret({ ...base, body: "key=${SECRET}" }, "sk-123");
    expect(out.body).toBe("key=sk-123");
  });

  it("${SECRET_JSON} JSON-escapes a secret with quotes/backslashes", () => {
    const secret = 'a"b\\c';
    const out = substituteSecret({ ...base, body: '{"k":"${SECRET_JSON}"}' }, secret);
    expect(out.body).toBe('{"k":"a\\"b\\\\c"}');
    expect(JSON.parse(out.body!)).toEqual({ k: secret });
  });

  it("rejects ${SECRET} in the url", () => {
    expect(() =>
      substituteSecret({ method: "GET", url: "https://x.com/${SECRET}" }, "s"),
    ).toThrow(ProxyError);
  });

  it("rejects ${SECRET} in the method", () => {
    expect(syncCode(() => substituteSecret({ method: "${SECRET}", url: "https://x.com" }, "s"))).toBe(
      "secret_in_method",
    );
  });

  it("rejects ${SECRET} in a header key", () => {
    expect(
      syncCode(() => substituteSecret({ ...base, headers: { "x-${SECRET}": "v" } }, "s")),
    ).toBe("secret_in_header_key");
  });

  it("rejects a secret containing CR/LF/NUL (header injection)", () => {
    expect(
      syncCode(() =>
        substituteSecret({ ...base, headers: { authorization: "Bearer ${SECRET}" } }, "a\r\nevil: 1"),
      ),
    ).toBe("secret_unsafe_chars");
  });

  it("rejects a resolved header value over 8KB", () => {
    expect(
      syncCode(() => substituteSecret({ ...base, headers: { authorization: "${SECRET}" } }, "x".repeat(9000))),
    ).toBe("header_too_large");
  });

  it("does not re-scan replacement text (single pass)", () => {
    // Secret literally contains the token; must not recurse.
    const out = substituteSecret({ ...base, body: "${SECRET}" }, "${SECRET}");
    expect(out.body).toBe("${SECRET}");
  });
});

describe("jsonEscapeSecret", () => {
  it("escapes quotes + backslashes without surrounding quotes", () => {
    expect(jsonEscapeSecret('a"b')).toBe('a\\"b');
  });
});

describe("isBlockedAddress", () => {
  const blocked = [
    "127.0.0.1",
    "169.254.169.254", // cloud metadata
    "10.1.2.3",
    "172.16.5.5",
    "172.31.255.255",
    "192.168.0.1",
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "64:ff9b::1", // NAT64
    "not-an-ip",
  ];
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => expect(isBlockedAddress(ip)).toBe(true));
  }

  const allowed = ["1.1.1.1", "8.8.8.8", "104.18.0.1", "2606:4700:4700::1111"];
  for (const ip of allowed) {
    it(`allows ${ip}`, () => expect(isBlockedAddress(ip)).toBe(false));
  }

  it("blocks 172.15/172.32 just outside the private /12", () => {
    expect(isBlockedAddress("172.15.0.1")).toBe(false);
    expect(isBlockedAddress("172.32.0.1")).toBe(false);
  });
});

describe("HttpProxyExecutor.execute guards", () => {
  function exec(opts: Partial<ConstructorParameters<typeof HttpProxyExecutor>[0]> = {}) {
    const dispatched: DispatchInput[] = [];
    const executor = new HttpProxyExecutor({
      lookup: async () => ({ address: "203.0.113.5", family: 4 }),
      dispatch: async (input): Promise<DispatchResult> => {
        dispatched.push(input);
        return {
          status: 200,
          headers: { "content-type": "application/json", "set-cookie": "a=b" },
          body: '{"ok":true}',
          truncated: false,
        };
      },
      ...opts,
    });
    return { executor, dispatched };
  }

  it("rejects http:// (https-only)", async () => {
    const { executor } = exec();
    expect(
      await asyncCode(
        executor.execute({ accountId: "a", http: { method: "GET", url: "http://x.com" }, secret: "s" }),
      ),
    ).toBe("not_https");
  });

  it("rejects a host that resolves to a blocked address", async () => {
    const { executor } = exec({ lookup: async () => ({ address: "169.254.169.254", family: 4 }) });
    expect(
      await asyncCode(
        executor.execute({ accountId: "a", http: { method: "GET", url: "https://metadata.evil/" }, secret: "s" }),
      ),
    ).toBe("blocked_address");
  });

  it("pins the resolved IP and preserves the Host header", async () => {
    const { executor, dispatched } = exec();
    await executor.execute({
      accountId: "a",
      http: { method: "GET", url: "https://api.openai.com/v1/models", headers: { authorization: "Bearer ${SECRET}" } },
      secret: "sk-9",
    });
    expect(dispatched[0]!.pinnedAddress).toBe("203.0.113.5");
    expect(dispatched[0]!.headers.host).toBe("api.openai.com");
    expect(dispatched[0]!.headers.authorization).toBe("Bearer sk-9");
  });

  it("strips Set-Cookie from the response", async () => {
    const { executor } = exec();
    const res = await executor.execute({
      accountId: "a",
      http: { method: "GET", url: "https://api.openai.com/" },
      secret: "s",
    });
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["content-type"]).toBe("application/json");
  });

  it("rejects a non-JSON/text response MIME", async () => {
    const executor = new HttpProxyExecutor({
      lookup: async () => ({ address: "203.0.113.5", family: 4 }),
      dispatch: async () => ({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: "binary",
        truncated: false,
      }),
    });
    expect(
      await asyncCode(
        executor.execute({ accountId: "a", http: { method: "GET", url: "https://x.com/" }, secret: "s" }),
      ),
    ).toBe("unsupported_response_type");
  });

  it("enforces a per-account concurrency cap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const executor = new HttpProxyExecutor({
      concurrencyPerAccount: 1,
      lookup: async () => ({ address: "203.0.113.5", family: 4 }),
      dispatch: async () => {
        await gate;
        return { status: 200, headers: { "content-type": "text/plain" }, body: "ok", truncated: false };
      },
    });
    const first = executor.execute({ accountId: "a", http: { method: "GET", url: "https://x.com/" }, secret: "s" });
    expect(
      await asyncCode(
        executor.execute({ accountId: "a", http: { method: "GET", url: "https://x.com/" }, secret: "s" }),
      ),
    ).toBe("concurrency_limit");
    release();
    await first;
  });
});
