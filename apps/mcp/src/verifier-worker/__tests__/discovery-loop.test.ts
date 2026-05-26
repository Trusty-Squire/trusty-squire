// Discovery-loop tests — closed-loop Phase 6.
//
// The loop talks to the same registry client the verifier uses
// (`fetchDiscoveryCandidates`) and invokes an INJECTED bot runner.
// Tests stub both ends to verify orchestration without touching the
// network or the universal bot.

import { describe, expect, it } from "vitest";
import { runDiscoveryBatch, type DiscoveryBotRunner } from "../discovery-loop.js";

interface StubCandidate {
  service: string;
  distinct_failures: number;
  top_error_kind: string;
  most_recent_at: string;
}

function makeClient(candidates: StubCandidate[]): unknown {
  return {
    fetchDiscoveryCandidates: async () => candidates,
  };
}

describe("runDiscoveryBatch", () => {
  it("invokes runUniversalBot once per candidate, counts outcomes", async () => {
    const seen: string[] = [];
    const bot: DiscoveryBotRunner = async ({ service }) => {
      seen.push(service);
      if (service === "perplexity") return { kind: "ok", reason: "wrote staging skill" };
      if (service === "koyeb") return { kind: "blocked", reason: "billing wall" };
      return { kind: "failed", reason: "no_credentials" };
    };
    const summary = await runDiscoveryBatch({
      client: makeClient([
        { service: "perplexity", distinct_failures: 5, top_error_kind: "no_credentials", most_recent_at: "2026-05-26T00:00:00Z" },
        { service: "koyeb", distinct_failures: 3, top_error_kind: "oauth_onboarding_failed", most_recent_at: "2026-05-26T01:00:00Z" },
        { service: "untriaged", distinct_failures: 4, top_error_kind: "captcha_blocked", most_recent_at: "2026-05-26T02:00:00Z" },
      ]) as never,
      runUniversalBot: bot,
      log: () => undefined,
    });
    expect(seen).toEqual(["perplexity", "koyeb", "untriaged"]);
    expect(summary).toEqual({
      attempted: 3,
      succeeded: 1,
      failed: 1,
      blocked: 1,
    });
  });

  it("processes the rest of the queue when one candidate throws", async () => {
    let calls = 0;
    const bot: DiscoveryBotRunner = async ({ service }) => {
      calls += 1;
      if (service === "boom") throw new Error("crashed");
      return { kind: "ok", reason: "ok" };
    };
    const summary = await runDiscoveryBatch({
      client: makeClient([
        { service: "first", distinct_failures: 3, top_error_kind: "x", most_recent_at: "2026-05-26T00:00:00Z" },
        { service: "boom", distinct_failures: 3, top_error_kind: "x", most_recent_at: "2026-05-26T00:00:00Z" },
        { service: "third", distinct_failures: 3, top_error_kind: "x", most_recent_at: "2026-05-26T00:00:00Z" },
      ]) as never,
      runUniversalBot: bot,
      log: () => undefined,
    });
    expect(calls).toBe(3);
    expect(summary.attempted).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it("does nothing when the queue is empty", async () => {
    let called = 0;
    const summary = await runDiscoveryBatch({
      client: makeClient([]) as never,
      runUniversalBot: async () => {
        called += 1;
        return { kind: "ok", reason: "ok" };
      },
      log: () => undefined,
    });
    expect(called).toBe(0);
    expect(summary.attempted).toBe(0);
  });

  it("forwards limit/sinceDays/minDistinct to the client", async () => {
    let receivedOpts: Record<string, unknown> | undefined;
    const client = {
      fetchDiscoveryCandidates: async (opts: Record<string, unknown>) => {
        receivedOpts = opts;
        return [];
      },
    };
    await runDiscoveryBatch({
      client: client as never,
      runUniversalBot: async () => ({ kind: "ok", reason: "x" }),
      limit: 7,
      sinceDays: 30,
      minDistinct: 5,
      log: () => undefined,
    });
    expect(receivedOpts).toEqual({ limit: 7, sinceDays: 30, minDistinct: 5 });
  });
});
