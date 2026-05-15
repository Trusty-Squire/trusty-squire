// Account-scoped ledger pagination.
//
// /v1/ledger and /v1/subscriptions used to call findRunsInState(state,
// 100), which returns the first 100 runs ACROSS ALL ACCOUNTS, then
// filtered by account_id in JS. With >100 total runs an account could
// see a truncated — or entirely empty — ledger. The fix adds an
// account-scoped paginated query to the RunStore.

import { describe, expect, it } from "vitest";
import {
  InMemoryRunStore,
  type CreateRunInput,
  type RunContext,
  type RunState,
} from "@trusty-squire/runtime";

function emptyContext(projectName: string): RunContext {
  return {
    email_alias: `${projectName}@test.local`,
    project_name: projectName,
    user_display_name: null,
    generated: {},
    steps: {},
    vault: {},
  };
}

function runInput(accountId: string, projectName: string): CreateRunInput {
  return {
    account_id: accountId,
    service: "resend",
    plan: "free",
    project_name: projectName,
    mandate_id: "mandate-1",
    adapter_id: "adapter-1",
    adapter_version: "1.0.0",
    context: emptyContext(projectName),
  };
}

// Seed `count` runs for `accountId` and drive each to `state`. The
// `tag` keeps project names unique across calls — the run idempotency
// key is (account, service, project_name), so a repeated project name
// would re-find an existing run instead of creating a new one.
async function seedRuns(
  store: InMemoryRunStore,
  accountId: string,
  count: number,
  state: Extract<RunState, "COMPLETE" | "FAILED">,
  tag = "r",
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const { run } = await store.createRun(
      runInput(accountId, `project-${accountId}-${tag}-${i}`),
    );
    await store.applyTransition(run.id, {
      next_state: state,
      patch: {
        state,
        state_entered_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      },
      event: {
        run_id: run.id,
        account_id: accountId,
        type: state === "COMPLETE" ? "vault_write_succeeded" : "step_failed",
        from_state: run.state,
        to_state: state,
        payload: {},
      },
    });
  }
}

describe("InMemoryRunStore.findRunsByAccount", () => {
  it("returns only the requested account's runs even past the 100-run mark", async () => {
    const store = new InMemoryRunStore();
    // 120 runs for account A, 50 for account B — interleaved enough that
    // a global "first 100" slice would not surface all of A's runs.
    await seedRuns(store, "acct-B", 50, "COMPLETE");
    await seedRuns(store, "acct-A", 120, "COMPLETE");

    const firstPage = await store.findRunsByAccount("acct-A", "COMPLETE", 100, 0);
    expect(firstPage).toHaveLength(100);
    expect(firstPage.every((r) => r.account_id === "acct-A")).toBe(true);

    const secondPage = await store.findRunsByAccount("acct-A", "COMPLETE", 100, 100);
    expect(secondPage).toHaveLength(20);
    expect(secondPage.every((r) => r.account_id === "acct-A")).toBe(true);

    // No overlap between pages.
    const firstIds = new Set(firstPage.map((r) => r.id));
    expect(secondPage.some((r) => firstIds.has(r.id))).toBe(false);
  });

  it("filters by state", async () => {
    const store = new InMemoryRunStore();
    await seedRuns(store, "acct-A", 5, "COMPLETE", "ok");
    await seedRuns(store, "acct-A", 3, "FAILED", "bad");

    const complete = await store.findRunsByAccount("acct-A", "COMPLETE", 100, 0);
    const failed = await store.findRunsByAccount("acct-A", "FAILED", 100, 0);
    expect(complete).toHaveLength(5);
    expect(failed).toHaveLength(3);
  });

  it("returns an empty page for an account with no runs", async () => {
    const store = new InMemoryRunStore();
    await seedRuns(store, "acct-A", 10, "COMPLETE");
    const none = await store.findRunsByAccount("acct-unknown", "COMPLETE", 100, 0);
    expect(none).toHaveLength(0);
  });
});
