// Regression for connect's identity-neutral ceremony open.
//
// The ceremony's `open` previously sent a bare launch request. When the
// shared browser was already live under some identity — notably a proxied
// operator session — the bare request was refused `incompatible_runtime`
// while other sessions were live, or recycled the shared Chrome underneath
// them when none were, killing connect either way. Adoption is now a
// behavior OF the ceremony open (Contract B carries no separate flag): a
// `ceremony` open reuses whatever identity is live, a plain one does not.
//
// `deriveOpenToolArgs` is the pure rule; `BrokerRuntime.liveProxyUrl` is the
// broker's one narrow answer to "what identity is live right now".

import { describe, expect, it } from "vitest";
import { deriveOpenToolArgs } from "../broker/operator.js";
import { BrokerRuntime } from "../broker/runtime.js";

describe("deriveOpenToolArgs", () => {
  it("adopts the live proxy for a ceremony open with no explicit proxy", () => {
    expect(
      deriveOpenToolArgs(
        { serviceUrl: "https://example.com/install/confirm", ceremony: true },
        "http://proxy.internal:8080",
      ),
    ).toEqual({
      service_url: "https://example.com/install/confirm",
      proxy: "http://proxy.internal:8080",
    });
  });

  it("an explicit proxy always wins over adoption", () => {
    expect(
      deriveOpenToolArgs(
        {
          serviceUrl: "https://example.com/install/confirm",
          ceremony: true,
          proxy: "http://explicit:1",
        },
        "http://proxy.internal:8080",
      ),
    ).toEqual({ service_url: "https://example.com/install/confirm", proxy: "http://explicit:1" });
  });

  it("a plain (non-ceremony) open stays bare even when an identity is live", () => {
    // The operator's own open path keeps its exact pre-existing semantics.
    expect(
      deriveOpenToolArgs({ serviceUrl: "https://example.com/install/confirm" }, "http://p:1"),
    ).toEqual({ service_url: "https://example.com/install/confirm" });
  });

  it("with nothing live the request stays bare", () => {
    expect(
      deriveOpenToolArgs(
        { serviceUrl: "https://example.com/install/confirm", ceremony: true },
        undefined,
      ),
    ).toEqual({ service_url: "https://example.com/install/confirm" });
  });
});

describe("BrokerRuntime.liveProxyUrl", () => {
  it("reflects the identity the shared browser is live under", () => {
    const runtime = new BrokerRuntime();
    const internals = runtime as unknown as {
      runtimeIdentity: { settings: { profileDir: string; proxyUrl?: string } | null };
    };
    expect(runtime.liveProxyUrl()).toBeUndefined();
    internals.runtimeIdentity.settings = { profileDir: "/p", proxyUrl: "http://p:1" };
    expect(runtime.liveProxyUrl()).toBe("http://p:1");
    internals.runtimeIdentity.settings = { profileDir: "/p" };
    expect(runtime.liveProxyUrl()).toBeUndefined();
  });
});
