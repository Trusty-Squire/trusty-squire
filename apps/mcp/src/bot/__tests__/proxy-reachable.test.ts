import { describe, it, expect } from "vitest";
import { isProxyReachable, proxyDefaultPort } from "../browser.js";

describe("isProxyReachable", () => {
  it("returns false for a malformed server string", async () => {
    expect(await isProxyReachable("not a url")).toBe(false);
    expect(await isProxyReachable("")).toBe(false);
  });

  it("returns false for a refused/closed port (fast)", async () => {
    // 127.0.0.1:1 is reserved + never listening → connect refused → false.
    expect(await isProxyReachable("socks5://127.0.0.1:1", 2000)).toBe(false);
  });

  it("times out to false for an unroutable host within the budget", async () => {
    // 192.0.2.0/24 (TEST-NET-1) is guaranteed unroutable → connect timeout.
    const t0 = Date.now();
    expect(await isProxyReachable("socks5://192.0.2.1:1081", 1500)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(4000); // respects the timeout
  });
});

describe("proxyDefaultPort", () => {
  it("uses protocol-correct defaults for portless proxy URLs", () => {
    expect(proxyDefaultPort("http:")).toBe(80);
    expect(proxyDefaultPort("https:")).toBe(443);
    expect(proxyDefaultPort("socks5:")).toBe(1080);
  });
});
