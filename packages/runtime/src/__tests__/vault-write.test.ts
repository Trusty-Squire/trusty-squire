// Vault-write tests — exercise executeOneStep on a CRED_EXTRACTED run
// and verify per-credential storage, side-effect appending, plaintext
// erasure, and partial-failure handling.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineAdapter, type AdapterManifest } from "@trusty-squire/adapter-sdk";
import { InMemoryAdapterRegistry } from "../adapter-registry.js";
import { executeOneStep } from "../executor.js";
import { InMemoryRunStore } from "../run-store.js";
import { transition } from "../state-machine.js";
import type { ExtractedCredential, Run, RunContext } from "../types.js";
import { MockVault } from "./_test-vault.js";
import { makeInboxHarness } from "./_test-inbox.js";
import type { InboxService } from "@trusty-squire/inbox";

const NOW = "2026-05-10T08:00:00.000Z";

function baseContext(): RunContext {
  return {
    email_alias: "demo@inbox.trustysquire.ai",
    project_name: "Demo",
    user_display_name: null,
    generated: {},
    steps: {},
    vault: {},
  };
}

function makeManifest(): AdapterManifest {
  return defineAdapter({
    service: "test-svc",
    version: "0.1.0",
    schema_version: 1,
    authored_by: { org: "T", contact: "t@example.com" },
    audit: { reviewer: "t@example.com", reviewed_at: NOW },
    signature: "TEST",
    metadata: { display_name: "Test", category: "test", homepage: "https://example.com" },
    plans: [{ id: "free", display_name: "Free", monthly_cents: 0, recurrence: "none" }],
    default_plan: "free",
    capabilities: {
      payment: { max_authorize_cents: 0, recurrence: "none" },
      email: { receive_from: [] },
      network: { allowed_domains: [] },
      vault_writes: [
        { kind: "api_key", reference_template: "v://x", rotation_required: false },
      ],
    },
    signup: { steps: [] },
    cancel: { steps: [] },
    rotate: { steps: [] },
  });
}

// Lift a run to CRED_EXTRACTED with the given credentials list, bypassing
// the executor (we're testing the vault-write step in isolation).
async function setupRunAtCredExtracted(
  store: InMemoryRunStore,
  credentials: ExtractedCredential[],
): Promise<Run> {
  const { run } = await store.createRun({
    account_id: "01HACCOUNTAAAAAAAAAAAAAAAA",
    service: "test-svc",
    plan: "free",
    project_name: "Demo",
    mandate_id: "01HMANDATEAAAAAAAAAAAAAAAA",
    adapter_id: "test-svc",
    adapter_version: "0.1.0",
    context: baseContext(),
  });

  let state = await store.applyTransition(
    run.id,
    transition(run, { kind: "mandate_validated", needs_approval: false }, NOW),
  );
  state = await store.applyTransition(
    state.id,
    transition(
      state,
      {
        kind: "step_succeeded",
        step: {
          index: 0,
          step_id: "noop",
          type: "http_request",
          attempt: 1,
          tier: 1,
          started_at: NOW,
          completed_at: NOW,
          status: "success",
          request: null,
          response: null,
          error: null,
          fixture_uri: null,
        },
        new_side_effects: [],
      },
      NOW,
    ),
  );
  state = await store.applyTransition(
    state.id,
    transition(
      state,
      { kind: "all_steps_complete", credentials_extracted: true, credentials },
      NOW,
    ),
  );
  return state;
}

describe("executeVaultWrite", () => {
  let vault: MockVault;
  let inbox: InboxService;
  beforeEach(() => {
    vault = new MockVault();
    inbox = makeInboxHarness().inbox;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Single credential → writes, transitions to COMPLETE, appends vault_entry side effect", async () => {
    const store = new InMemoryRunStore();
    const registry = new InMemoryAdapterRegistry();
    registry.register(makeManifest());
    const cred: ExtractedCredential = {
      type: "api_key",
      value: "sk_test_secret",
      env_var_suggestion: "TEST_API_KEY",
      reference: null,
    };
    const run = await setupRunAtCredExtracted(store, [cred]);

    const after = await executeOneStep({ runStore: store, registry, vault, inbox }, run.id);
    expect(after.state).toBe("COMPLETE");
    expect(after.subscription_id).not.toBeNull();
    expect(after.completed_at).not.toBeNull();
    expect(vault.stored).toHaveLength(1);
    expect(vault.stored[0]?.input.value).toBe("sk_test_secret");
    expect(vault.stored[0]?.input.env_var_suggestion).toBe("TEST_API_KEY");
    expect(after.side_effects).toHaveLength(1);
    expect(after.side_effects[0]?.type).toBe("vault_entry");
  });

  it("Multiple credentials → all written, all side effects appended", async () => {
    const store = new InMemoryRunStore();
    const registry = new InMemoryAdapterRegistry();
    registry.register(makeManifest());
    const creds: ExtractedCredential[] = [
      { type: "api_key", value: "sk_a", env_var_suggestion: "A", reference: null },
      { type: "oauth_token", value: "tok_b", env_var_suggestion: null, reference: null },
    ];
    const run = await setupRunAtCredExtracted(store, creds);

    const after = await executeOneStep({ runStore: store, registry, vault, inbox }, run.id);
    expect(after.state).toBe("COMPLETE");
    expect(vault.stored).toHaveLength(2);
    expect(after.side_effects).toHaveLength(2);
    expect(after.side_effects.every((s) => s.type === "vault_entry")).toBe(true);
  });

  it("vault.store throws on second credential → run goes FAILED, first stays in vault, partial side effect persisted", async () => {
    const store = new InMemoryRunStore();
    const registry = new InMemoryAdapterRegistry();
    registry.register(makeManifest());
    const creds: ExtractedCredential[] = [
      { type: "api_key", value: "sk_a", env_var_suggestion: null, reference: null },
      { type: "oauth_token", value: "tok_b", env_var_suggestion: null, reference: null },
    ];
    const run = await setupRunAtCredExtracted(store, creds);

    // Second store call throws.
    const failingVault = new MockVault({ throwOnStoreNumber: 2 });
    const after = await executeOneStep(
      { runStore: store, registry, vault: failingVault, inbox },
      run.id,
    );
    expect(after.state).toBe("FAILED");
    expect(after.failure_reason).toBe("vault_store_threw");
    // First write is still in vault — chunk-5 spec: partial failures stay partial.
    expect(failingVault.stored).toHaveLength(1);
    // The successful first write produced a side effect that's persisted.
    expect(after.side_effects).toHaveLength(1);
    expect(after.side_effects[0]?.type).toBe("vault_entry");
  });

  it("Credentials nulled in run record after successful write (no plaintext lingering)", async () => {
    const store = new InMemoryRunStore();
    const registry = new InMemoryAdapterRegistry();
    registry.register(makeManifest());
    const cred: ExtractedCredential = {
      type: "api_key",
      value: "sk_lingering",
      env_var_suggestion: null,
      reference: null,
    };
    const run = await setupRunAtCredExtracted(store, [cred]);

    const after = await executeOneStep({ runStore: store, registry, vault, inbox }, run.id);
    expect(after.state).toBe("COMPLETE");
    expect(after.credentials).toBeNull();
  });

  it("CRED_EXTRACTED with empty credentials → vault_write_failed → FAILED", async () => {
    const store = new InMemoryRunStore();
    const registry = new InMemoryAdapterRegistry();
    registry.register(makeManifest());
    const run = await setupRunAtCredExtracted(store, []);
    // setupRunAtCredExtracted always lifts to CRED_EXTRACTED with credentials
    // populated. We force the empty-creds edge case by manually clearing.
    // Simulate via an artificial second transition is overkill — use the
    // store's loadRun + applyTransition surface? Actually the patch above
    // wrote credentials=[] which is treated as null-ish at vault-write
    // time. Walk through executor.
    // (When credentials list is empty, executor commits vault_write_failed
    // with reason='no_credentials_in_run'.)
    //
    // Note: setupRunAtCredExtracted with [] passes credentials_extracted:
    // true via the transition payload but the array is empty; the all-steps
    // handler stores credentials: []. The executor's vault-write check
    // treats [] the same as null (length 0). FAILED.
    const after = await executeOneStep({ runStore: store, registry, vault, inbox }, run.id);
    expect(after.state).toBe("FAILED");
    expect(after.failure_reason).toBe("no_credentials_in_run");
    expect(vault.stored).toHaveLength(0);
  });
});
