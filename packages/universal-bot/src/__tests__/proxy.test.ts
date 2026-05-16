// Covers residential-proxy support (TODOS.md S1): parseProxyUrl turns a
// UNIVERSAL_BOT_PROXY_URL into Playwright's proxy shape, and
// shouldRouteThroughProxy is the datacenter gate that keeps the ~80% of
// residential users on a direct connection (zero proxy cost).

import { describe, expect, it } from "vitest";
import { parseProxyUrl, shouldRouteThroughProxy } from "../browser.js";

describe("parseProxyUrl", () => {
  it("splits credentials out of an http proxy URL", () => {
    expect(parseProxyUrl("http://user:pass@proxy.example.com:8080")).toEqual({
      server: "http://proxy.example.com:8080",
      username: "user",
      password: "pass",
    });
  });

  it("handles a credential-less proxy URL", () => {
    expect(parseProxyUrl("http://proxy.example.com:3128")).toEqual({
      server: "http://proxy.example.com:3128",
    });
  });

  it("supports socks5", () => {
    expect(parseProxyUrl("socks5://10.0.0.1:1080")).toEqual({
      server: "socks5://10.0.0.1:1080",
    });
  });

  it("percent-decodes credentials", () => {
    // Residential providers embed session IDs with reserved characters
    // in the username — they arrive percent-encoded in the URL.
    expect(
      parseProxyUrl("http://user%40acct:p%3Ass@proxy.example.com:8080"),
    ).toEqual({
      server: "http://proxy.example.com:8080",
      username: "user@acct",
      password: "p:ss",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseProxyUrl("  http://proxy.example.com:8080  ")).toEqual({
      server: "http://proxy.example.com:8080",
    });
  });

  it("throws on a URL with no host", () => {
    // A bare "host:port" parses as a scheme with an empty host.
    expect(() => parseProxyUrl("proxy.example.com:8080")).toThrow();
    expect(() => parseProxyUrl("not a proxy url")).toThrow();
  });
});

describe("shouldRouteThroughProxy", () => {
  it("routes datacenter egress through the proxy", () => {
    expect(shouldRouteThroughProxy("datacenter", false)).toBe(true);
  });

  it("leaves residential egress direct (no proxy cost)", () => {
    expect(shouldRouteThroughProxy("residential", false)).toBe(false);
  });

  it("leaves unknown egress direct unless forced", () => {
    expect(shouldRouteThroughProxy("unknown", false)).toBe(false);
    expect(shouldRouteThroughProxy("unknown", true)).toBe(true);
  });

  it("force-always overrides the gate for every ASN class", () => {
    expect(shouldRouteThroughProxy("residential", true)).toBe(true);
    expect(shouldRouteThroughProxy("datacenter", true)).toBe(true);
  });
});
