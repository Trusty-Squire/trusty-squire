// http-proxy hardening — multi-field secret substitution + SSRF address
// blocking + the executor's URL / DNS-pin / response guards. The
// security surface, exercised in isolation (no real sockets).

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

const ONE = { value: "sk-123" };

describe("substituteSecret (single + multi field)", () => {
  const base = { method: "POST", url: "https://api.openai.com/v1/x" };

  it("${SECRET} injects the sole / value field into a header", () => {
    const out = substituteSecret({ ...base, headers: { authorization: "Bearer ${SECRET}" } }, ONE);
    expect(out.headers!.authorization).toBe("Bearer sk-123");
  });

  it("${SECRET.field} injects a named field", () => {
    const out = substituteSecret(
      { ...base, headers: { "x-id": "${SECRET.access_key_id}", "x-key": "${SECRET.secret}" } },
      { access_key_id: "AKIA", secret: "shh" },
    );
    expect(out.headers!["x-id"]).toBe("AKIA");
    expect(out.headers!["x-key"]).toBe("shh");
  });

  it("${SECRET} on a multi-field credential is ambiguous", () => {
    expect(
      syncCode(() => substituteSecret({ ...base, headers: { a: "${SECRET}" } }, { x: "1", y: "2" })),
    ).toBe("secret_ambiguous");
  });

  it("missing field name is rejected", () => {
    expect(
      syncCode(() => substituteSecret({ ...base, headers: { a: "${SECRET.nope}" } }, ONE)),
    ).toBe("secret_field_missing");
  });

  it("${SECRET_JSON.field} JSON-escapes", () => {
    const out = substituteSecret({ ...base, body: '{"k":"${SECRET_JSON.value}"}' }, { value: 'a"b\\c' });
    expect(JSON.parse(out.body!)).toEqual({ k: 'a"b\\c' });
  });

  it("rejects placeholders in url / method / header-key", () => {
    expect(syncCode(() => substituteSecret({ method: "GET", url: "https://x/${SECRET}" }, ONE))).toBe("secret_in_url");
    expect(syncCode(() => substituteSecret({ method: "${SECRET}", url: "https://x" }, ONE))).toBe("secret_in_method");
    expect(syncCode(() => substituteSecret({ ...base, headers: { "x-${SECRET}": "v" } }, ONE))).toBe("secret_in_header_key");
  });

  it("rejects a field value with CR/LF/NUL", () => {
    expect(syncCode(() => substituteSecret({ ...base, headers: { a: "${SECRET}" } }, { value: "a\r\nevil:1" }))).toBe(
      "secret_unsafe_chars",
    );
  });

  it("rejects a resolved header over 8KB", () => {
    expect(syncCode(() => substituteSecret({ ...base, headers: { a: "${SECRET}" } }, { value: "x".repeat(9000) }))).toBe(
      "header_too_large",
    );
  });
});

describe("jsonEscapeSecret", () => {
  it("escapes quotes + backslashes without surrounding quotes", () => {
    expect(jsonEscapeSecret('a"b')).toBe('a\\"b');
  });
});

describe("isBlockedAddress", () => {
  const blocked = [
    "127.0.0.1", "169.254.169.254", "10.1.2.3", "172.16.5.5", "192.168.0.1",
    "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1",
    "64:ff9b::1", "not-an-ip",
  ];
  for (const ip of blocked) it(`blocks ${ip}`, () => expect(isBlockedAddress(ip)).toBe(true));
  for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) {
    it(`allows ${ip}`, () => expect(isBlockedAddress(ip)).toBe(false));
  }
});

describe("HttpProxyExecutor.execute guards", () => {
  function exec(opts: Partial<ConstructorParameters<typeof HttpProxyExecutor>[0]> = {}) {
    const dispatched: DispatchInput[] = [];
    const executor = new HttpProxyExecutor({
      lookup: async () => ({ address: "203.0.113.5", family: 4 }),
      dispatch: async (input): Promise<DispatchResult> => {
        dispatched.push(input);
        return { status: 200, headers: { "content-type": "application/json", "set-cookie": "a=b" }, body: '{"ok":true}', truncated: false };
      },
      ...opts,
    });
    return { executor, dispatched };
  }

  it("rejects http://", async () => {
    const { executor } = exec();
    expect(await asyncCode(executor.execute({ accountId: "a", http: { method: "GET", url: "http://x.com" }, fields: ONE }))).toBe("not_https");
  });

  it("rejects a host resolving to a blocked address", async () => {
    const { executor } = exec({ lookup: async () => ({ address: "169.254.169.254", family: 4 }) });
    expect(await asyncCode(executor.execute({ accountId: "a", http: { method: "GET", url: "https://metadata/" }, fields: ONE }))).toBe("blocked_address");
  });

  it("pins the resolved IP, preserves Host, injects the field", async () => {
    const { executor, dispatched } = exec();
    await executor.execute({
      accountId: "a",
      http: { method: "GET", url: "https://api.openai.com/v1/models", headers: { authorization: "Bearer ${SECRET}" } },
      fields: { value: "sk-9" },
    });
    expect(dispatched[0]!.pinnedAddress).toBe("203.0.113.5");
    expect(dispatched[0]!.headers.host).toBe("api.openai.com");
    expect(dispatched[0]!.headers.authorization).toBe("Bearer sk-9");
  });

  it("strips Set-Cookie", async () => {
    const { executor } = exec();
    const res = await executor.execute({ accountId: "a", http: { method: "GET", url: "https://api.openai.com/" }, fields: ONE });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects a non-JSON/text response MIME", async () => {
    const executor = new HttpProxyExecutor({
      lookup: async () => ({ address: "203.0.113.5", family: 4 }),
      dispatch: async () => ({ status: 200, headers: { "content-type": "application/octet-stream" }, body: "bin", truncated: false }),
    });
    expect(await asyncCode(executor.execute({ accountId: "a", http: { method: "GET", url: "https://x.com/" }, fields: ONE }))).toBe("unsupported_response_type");
  });

  it("enforces a per-account concurrency cap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const executor = new HttpProxyExecutor({
      concurrencyPerAccount: 1,
      lookup: async () => ({ address: "203.0.113.5", family: 4 }),
      dispatch: async () => { await gate; return { status: 200, headers: { "content-type": "text/plain" }, body: "ok", truncated: false }; },
    });
    const first = executor.execute({ accountId: "a", http: { method: "GET", url: "https://x.com/" }, fields: ONE });
    expect(await asyncCode(executor.execute({ accountId: "a", http: { method: "GET", url: "https://x.com/" }, fields: ONE }))).toBe("concurrency_limit");
    release();
    await first;
  });
});
