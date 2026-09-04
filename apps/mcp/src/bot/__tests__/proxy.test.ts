// Covers explicit per-session proxy behavior: it is deliberate operator
// routing, never subject to host ASN classification or a direct fallback.

import { describe, expect, it } from "vitest";
import {
  canSelfLaunchWithProxy,
  parseProxyUrl,
  persistentProxyOptions,
  proxyHasCredentials,
  resolveExplicitProxy,
} from "../browser.js";

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
    expect(parseProxyUrl("http://user%40acct:p%3Ass@proxy.example.com:8080")).toEqual({
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

  it("does not expose malformed proxy credentials in errors", () => {
    const credential = "secret-proxy-password";
    let thrown: unknown;
    try {
      parseProxyUrl(`http://${credential}@`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain(credential);
  });
});

describe("explicit per-session proxy", () => {
  it("honors a proxy despite unknown host ASN and routes credentials to Playwright", async () => {
    // No ASN input exists in this resolution path: an explicit session proxy
    // must work even when host classification is unknown.
    const proxy = await resolveExplicitProxy(
      "http://country-us:user-secret@proxy.example.com:8080",
      async () => true,
    );

    expect(proxy).toEqual({
      server: "http://proxy.example.com:8080",
      username: "country-us",
      password: "user-secret",
    });
    expect(proxyHasCredentials(proxy)).toBe(true);
    expect(canSelfLaunchWithProxy(proxy)).toBe(false);
    expect(persistentProxyOptions(proxy)).toEqual({ proxy });
  });

  it("fails loudly for a malformed explicit proxy instead of choosing direct egress", async () => {
    await expect(resolveExplicitProxy("not a proxy url", async () => true)).rejects.toThrow(
      "refusing direct egress",
    );
  });

  it("fails loudly when the explicit proxy is unreachable instead of choosing direct egress", async () => {
    await expect(
      resolveExplicitProxy("socks5://proxy.example.com:1080", async () => false),
    ).rejects.toThrow("unreachable; refusing direct egress");
  });
});
