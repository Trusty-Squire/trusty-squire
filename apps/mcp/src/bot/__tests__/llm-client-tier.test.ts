// Verifies pickLLMPair's tier resolution: explicit opts > env > cheap.
// The verifier-worker pattern is to set UNIVERSAL_BOT_LLM_TIER=free and
// otherwise let the existing call sites carry on unchanged.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickLLMPair } from "../llm-client.js";

const ENV_KEYS = [
  "TRUSTY_SQUIRE_MACHINE_TOKEN",
  "TRUSTY_SQUIRE_API_BASE",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "UNIVERSAL_BOT_LLM_TIER",
] as const;

describe("pickLLMPair — tier resolution (proxy path)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.TRUSTY_SQUIRE_MACHINE_TOKEN = "test-token";
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults to cheap tier and no premium fallback", () => {
    const pair = pickLLMPair();
    expect(pair.primary.name).toBe("trusty-squire-proxy:cheap");
    expect(pair.premium).toBeNull();
  });

  it("preferCheap=true keeps cheap primary but adds the premium parse-fallback", () => {
    const pair = pickLLMPair({ preferCheap: true });
    expect(pair.primary.name).toBe("trusty-squire-proxy:cheap");
    expect(pair.premium?.name).toBe("trusty-squire-proxy:premium");
  });

  it("explicit tier=free routes the primary AND auto-attaches premium fallback", () => {
    // Free models have weaker JSON adherence — a parse failure on
    // the free primary is exactly the case where premium retry is
    // worth the spend, so the pair includes premium even without
    // preferCheap set.
    const pair = pickLLMPair({ tier: "free" });
    expect(pair.primary.name).toBe("trusty-squire-proxy:free");
    expect(pair.premium?.name).toBe("trusty-squire-proxy:premium");
  });

  it("UNIVERSAL_BOT_LLM_TIER=free flips the default without explicit opts", () => {
    process.env.UNIVERSAL_BOT_LLM_TIER = "free";
    const pair = pickLLMPair();
    expect(pair.primary.name).toBe("trusty-squire-proxy:free");
    expect(pair.premium?.name).toBe("trusty-squire-proxy:premium");
  });

  it("explicit opts.tier beats the env knob", () => {
    process.env.UNIVERSAL_BOT_LLM_TIER = "free";
    const pair = pickLLMPair({ tier: "cheap" });
    expect(pair.primary.name).toBe("trusty-squire-proxy:cheap");
    expect(pair.premium).toBeNull();
  });

  it("an unrecognized UNIVERSAL_BOT_LLM_TIER value falls back to cheap", () => {
    process.env.UNIVERSAL_BOT_LLM_TIER = "ultra-mega";
    const pair = pickLLMPair();
    expect(pair.primary.name).toBe("trusty-squire-proxy:cheap");
  });
});
