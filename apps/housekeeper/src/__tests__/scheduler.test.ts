import { describe, it, expect } from "vitest";
import { runVerify, type VerifyDeps } from "../scheduler.js";
import { loadConfig } from "../config.js";
import { parseArgs } from "../cli.js";
import type { RunnerResult } from "../codex-runner.js";
import type {
  PostOutcomeInput,
  VerifierOutcomeResponse,
  VerifyQueueItem,
} from "../registry-client.js";
import type { SkillRef } from "../types.js";

const config = loadConfig({ REGISTRY_ADMIN_BEARER: "tok", HOUSEKEEPER_MAX_SKILLS_PER_RUN: "10" } as NodeJS.ProcessEnv);

function qItem(skill_id: string, service: string): VerifyQueueItem {
  return { skill_id, service, status: "pending-review", consecutive_verifier_failures: 0 };
}

interface FakeOpts {
  queue: VerifyQueueItem[];
  url?: (id: string) => string | null;
  outcome: (skill: SkillRef) => RunnerResult;
  resp?: (input: PostOutcomeInput) => VerifierOutcomeResponse;
  postThrows?: boolean;
}

function makeDeps(opts: FakeOpts): { deps: VerifyDeps; posts: PostOutcomeInput[]; logs: string[] } {
  const posts: PostOutcomeInput[] = [];
  const logs: string[] = [];
  const deps: VerifyDeps = {
    client: {
      fetchQueue: async () => opts.queue,
      fetchSkillSignupUrl: async (id: string) =>
        opts.url ? opts.url(id) : `https://${id}.example/signup`,
      postOutcome: async (input: PostOutcomeInput): Promise<VerifierOutcomeResponse> => {
        posts.push(input);
        if (opts.postThrows) throw new Error("registry 500");
        const base: VerifierOutcomeResponse = {
          transition: "none",
          status: "pending-review",
          consecutive_verifier_failures: 0,
        };
        return opts.resp ? opts.resp(input) : base;
      },
    },
    runVerify: async (skill: SkillRef) => opts.outcome(skill),
    log: (m: string) => logs.push(m),
  };
  return { deps, posts, logs };
}

const live = parseArgs([]);
const dry = parseArgs(["--dry"]);

describe("runVerify — mechanical promote/demote mapping", () => {
  it("posts a success and counts a promotion", async () => {
    const { deps, posts } = makeDeps({
      queue: [qItem("sk_a", "alpha")],
      outcome: () => ({ kind: "result", outcome: { ok: true } }),
      resp: () => ({ transition: "promoted", status: "active", consecutive_verifier_failures: 0 }),
    });
    const s = await runVerify(config, live, deps);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ skill_id: "sk_a", kind: "success" });
    expect(s).toMatchObject({ attempted: 1, succeeded: 1, promoted: 1 });
  });

  it("posts a REAL failure and counts a demotion", async () => {
    const { deps, posts } = makeDeps({
      queue: [qItem("sk_b", "bravo")],
      outcome: () => ({ kind: "result", outcome: { ok: false, failure_kind: "no_credentials" } }),
      resp: () => ({ transition: "demoted", status: "demoted", consecutive_verifier_failures: 3 }),
    });
    const s = await runVerify(config, live, deps);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ kind: "failure", failure_kind: "no_credentials" });
    expect(s).toMatchObject({ failures_reported: 1, demoted: 1 });
  });

  it("does NOT post a transient failure (no demote)", async () => {
    const { deps, posts } = makeDeps({
      queue: [qItem("sk_c", "charlie")],
      outcome: () => ({ kind: "result", outcome: { ok: false, failure_kind: "login_wall" } }),
    });
    const s = await runVerify(config, live, deps);
    expect(posts).toHaveLength(0);
    expect(s).toMatchObject({ transient_skipped: 1, failures_reported: 0 });
  });

  it("does NOT post an infra error (codex couldn't run)", async () => {
    const { deps, posts } = makeDeps({
      queue: [qItem("sk_d", "delta")],
      outcome: () => ({ kind: "infra_error", detail: "codex exited 137" }),
    });
    const s = await runVerify(config, live, deps);
    expect(posts).toHaveLength(0);
    expect(s).toMatchObject({ infra_skipped: 1 });
  });

  it("skips a skill with no signup_url", async () => {
    const { deps, posts } = makeDeps({
      queue: [qItem("sk_e", "echo")],
      url: () => null,
      outcome: () => ({ kind: "result", outcome: { ok: true } }),
    });
    const s = await runVerify(config, live, deps);
    expect(posts).toHaveLength(0);
    expect(s).toMatchObject({ no_url_skipped: 1, succeeded: 0 });
  });

  it("dry run posts NOTHING but still counts outcomes", async () => {
    const { deps, posts } = makeDeps({
      queue: [qItem("sk_f", "foxtrot"), qItem("sk_g", "golf")],
      outcome: (skill) =>
        skill.service === "foxtrot"
          ? { kind: "result", outcome: { ok: true } }
          : { kind: "result", outcome: { ok: false, failure_kind: "step_failed" } },
    });
    const s = await runVerify(config, dry, deps);
    expect(posts).toHaveLength(0);
    expect(s).toMatchObject({ succeeded: 1, failures_reported: 1, promoted: 0, demoted: 0 });
  });

  it("a per-skill error becomes an infra-skip and does not abort the pass", async () => {
    const { deps, posts } = makeDeps({
      queue: [qItem("sk_h", "hotel"), qItem("sk_i", "india")],
      outcome: () => ({ kind: "result", outcome: { ok: true } }),
      postThrows: true,
    });
    const s = await runVerify(config, live, deps);
    expect(posts).toHaveLength(2); // both attempted
    expect(s).toMatchObject({ attempted: 2, infra_skipped: 2, promoted: 0 });
  });

  it("requires REGISTRY_ADMIN_BEARER", async () => {
    const noBearer = loadConfig({} as NodeJS.ProcessEnv);
    await expect(runVerify(noBearer, live, makeDeps({ queue: [], outcome: () => ({ kind: "result", outcome: { ok: true } }) }).deps)).rejects.toThrow(/REGISTRY_ADMIN_BEARER/);
  });
});
