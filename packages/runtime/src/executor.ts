// Runtime executor — drives runs through the state machine one step
// at a time. Stateless across calls: load the run, pick a transition,
// commit it, return.
//
// In production this is invoked by a worker (BullMQ job per run).
// Tests call it directly.

import { ulid } from "ulid";
import type {
  AdapterCapabilities,
  AdapterManifest,
  ClickLinkInEmailStepDef,
  DelayStepDef,
  FlowDef,
  HttpRequestStepDef,
  StepDef,
  TotpGenerateStepDef,
  VaultWriteCapability,
  WaitForEmailStepDef,
  WaitForEmailWithCodeStepDef,
} from "@trusty-squire/adapter-sdk";
import type { InboxService } from "@trusty-squire/inbox";
import type { AdapterRegistry } from "./adapter-registry.js";
import { compensate, type CompensateOptions } from "./compensator.js";
import type { RunStore } from "./run-store.js";
import { transition } from "./state-machine.js";
import {
  executeHttpRequest,
  type StepExecutorContext as HttpStepExecutorContext,
  type StepResult as HttpStepResult,
} from "./step-executors/http-request.js";
import { executeWaitForEmail } from "./step-executors/wait-for-email.js";
import { executeWaitForEmailWithCode } from "./step-executors/wait-for-email-with-code.js";
import { executeClickLinkInEmail } from "./step-executors/click-link-in-email.js";
import { executeTotpGenerate } from "./step-executors/totp-generate.js";
import { executeDelay } from "./step-executors/delay.js";
import type {
  ExtractedCredential,
  Run,
  SideEffect,
  StepError,
  StepRecord,
  Transition,
} from "./types.js";
import type { VaultClient } from "./vault-client.js";

export interface ExecutorConfig {
  runStore: RunStore;
  registry: AdapterRegistry;
  vault: VaultClient;
  inbox: InboxService;
  // Optional injectables — tests use these to control fetch / clock /
  // sleep; production omits them for real fetch + Date.now + setTimeout.
  fetch?: typeof fetch;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  compensateOptions?: CompensateOptions;
}

// Shape every executor produces so the dispatcher can normalise into
// a step_succeeded / step_failed transition.
type DispatchResult =
  | {
      kind: "success";
      step: StepRecord;
      new_side_effects: readonly SideEffect[];
      generated_updates?: Record<string, string>;
    }
  | { kind: "failure"; step: StepRecord; error: StepError };

export class ExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutorError";
  }
}

// Single-step entry point. Picks up a run, dispatches by state, commits
// the resulting transition, returns the post-transition Run.
//
// States not driven by the executor (CREATED / PENDING_APPROVAL / etc.)
// return the run unchanged — those advance via external calls (mandate
// validation in chunk 4, approval webhook in chunk 10).
export async function executeOneStep(config: ExecutorConfig, runId: string): Promise<Run> {
  const run = await config.runStore.loadRun(runId);

  switch (run.state) {
    case "PROVISIONING":
    case "ADAPTER_EXECUTING":
      return executeAdapterStep(config, run);
    case "TIER_ESCALATING":
      return performTierEscalation(config, run);
    case "CRED_EXTRACTED":
      return executeVaultWrite(config, run);
    case "COMPENSATING":
      return runCompensation(config, run);
    case "CREATED":
    case "MANDATE_VALIDATED":
    case "PENDING_APPROVAL":
    case "VAULT_WRITTEN":
    case "COMPLETE":
    case "FAILED":
    case "REJECTED":
      return run;
  }
}

// ── Adapter step ─────────────────────────────────────────────

async function executeAdapterStep(config: ExecutorConfig, run: Run): Promise<Run> {
  const manifest = await config.registry.load(run.adapter_id, run.adapter_version);

  // Chunk 3 only drives the signup flow. cancel/rotate flow selection
  // is a chunk 8+ concern (driven by the request kind, which the Run
  // type doesn't yet record).
  const flow = manifest.signup;

  const nextIndex = findNextStepIndex(flow, run.steps);
  if (nextIndex === null) {
    const credentials = extractCredentials(manifest, run);
    return commit(config, run.id, run, {
      kind: "all_steps_complete",
      credentials_extracted: credentials.length > 0,
      ...(credentials.length > 0 ? { credentials } : {}),
    });
  }

  const stepDef = flow.steps[nextIndex];
  if (stepDef === undefined) {
    throw new ExecutorError(`step at index ${nextIndex} missing from flow`);
  }

  if (run.current_tier !== 1) {
    throw new ExecutorError(
      `tier ${run.current_tier} dispatch not implemented in chunk 3`,
    );
  }

  const attempt = computeAttemptNumber(run.steps, stepDef.id);
  const result = await dispatchStep(stepDef, run, {
    config,
    manifest,
    index: nextIndex,
    attempt,
  });
  const t: Transition =
    result.kind === "success"
      ? {
          kind: "step_succeeded",
          step: result.step,
          new_side_effects: [...result.new_side_effects],
          ...(result.generated_updates !== undefined
            ? { generated_updates: result.generated_updates }
            : {}),
        }
      : { kind: "step_failed", step: result.step, error: result.error };
  return commit(config, run.id, run, t);
}

interface DispatchInputs {
  config: ExecutorConfig;
  manifest: AdapterManifest;
  index: number;
  attempt: number;
}

async function dispatchStep(
  stepDef: StepDef,
  run: Run,
  inputs: DispatchInputs,
): Promise<DispatchResult> {
  const baseCtx = {
    index: inputs.index,
    attempt: inputs.attempt,
    tier: run.current_tier,
    ...(inputs.config.now !== undefined ? { now: inputs.config.now } : {}),
  };

  switch (stepDef.type) {
    case "http_request": {
      const ctx: HttpStepExecutorContext = {
        ...baseCtx,
        capabilities: inputs.manifest.capabilities,
        ...(inputs.config.fetch !== undefined ? { fetch: inputs.config.fetch } : {}),
      };
      const r: HttpStepResult = await executeHttpRequest(
        stepDef as HttpRequestStepDef,
        run,
        ctx,
      );
      return r;
    }

    case "wait_for_email":
      return executeWaitForEmail(stepDef as WaitForEmailStepDef, run, {
        ...baseCtx,
        inbox: inputs.config.inbox,
      });

    case "wait_for_email_with_code":
      return executeWaitForEmailWithCode(
        stepDef as WaitForEmailWithCodeStepDef,
        run,
        { ...baseCtx, inbox: inputs.config.inbox },
      );

    case "click_link_in_email":
      return executeClickLinkInEmail(stepDef as ClickLinkInEmailStepDef, run, {
        ...baseCtx,
        inbox: inputs.config.inbox,
        capabilities: inputs.manifest.capabilities,
        ...(inputs.config.fetch !== undefined ? { fetch: inputs.config.fetch } : {}),
      });

    case "totp_generate":
      return executeTotpGenerate(stepDef as TotpGenerateStepDef, run, {
        ...baseCtx,
        vault: inputs.config.vault,
      });

    case "delay":
      return executeDelay(stepDef as DelayStepDef, run, {
        ...baseCtx,
        ...(inputs.config.sleep !== undefined ? { sleep: inputs.config.sleep } : {}),
      });

    case "wait_for_webhook":
    case "branch":
    case "custom_hook":
      throw new ExecutorError(
        `step type '${stepDef.type}' not yet implemented in v0`,
      );
  }
}

// ── Tier escalation ──────────────────────────────────────────

async function performTierEscalation(config: ExecutorConfig, run: Run): Promise<Run> {
  if (run.current_tier >= 3) {
    throw new ExecutorError("already at tier 3; no further escalation");
  }
  const next = (run.current_tier + 1) as 2 | 3;
  // The state machine validates that next > current_tier. The next
  // executeOneStep call after this will hit the tier-gate and throw
  // "tier N dispatch not implemented" — that's the chunk-3 stop point.
  return commit(config, run.id, run, { kind: "tier_escalation_started", new_tier: next });
}

// ── Compensation ─────────────────────────────────────────────

function runCompensation(config: ExecutorConfig, run: Run): Promise<Run> {
  return compensate(config.runStore, config.vault, run.id, {
    ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
    ...(config.now !== undefined ? { now: config.now } : {}),
    ...config.compensateOptions,
  });
}

// ── Vault write ──────────────────────────────────────────────

async function executeVaultWrite(config: ExecutorConfig, run: Run): Promise<Run> {
  if (run.credentials === null || run.credentials.length === 0) {
    // Defensive — chunk 5 reaches this state only when the executor
    // populated credentials at all_steps_complete. Direct CRED_EXTRACTED
    // entry without credentials shouldn't happen, but if it does, fail
    // fast rather than write an empty subscription.
    return commit(config, run.id, run, {
      kind: "vault_write_failed",
      reason: "no_credentials_in_run",
    });
  }

  // Subscription id is generated up-front so each vault entry's metadata
  // can reference it. The Subscription Prisma row gets created by the
  // persistence chunk later — for chunk 5 we just thread the id through.
  const subscriptionId = ulid();
  const newSideEffects: SideEffect[] = [];
  const writtenSoFar: SideEffect[] = [];

  for (const cred of run.credentials) {
    try {
      const entry = await config.vault.store({
        account_id: run.account_id,
        subscription_id: subscriptionId,
        type: cred.type,
        value: cred.value,
        env_var_suggestion: cred.env_var_suggestion,
        metadata: { run_id: run.id, adapter: run.adapter_id },
      });
      const effect: SideEffect = {
        id: ulid(),
        type: "vault_entry",
        reference: entry.reference,
        reversible: true,
        reverse_action: { kind: "vault_delete", reference_template: entry.reference },
        emitted_at: nowOf(config),
      };
      newSideEffects.push(effect);
      writtenSoFar.push(effect);
    } catch (err) {
      // Per spec: "Per credential. Partial failures stay partial; the
      // run fails to FAILED with partial state recorded."
      return commit(config, run.id, run, {
        kind: "vault_write_failed",
        reason: "vault_store_threw",
        ...(writtenSoFar.length > 0 ? { partial_side_effects: writtenSoFar } : {}),
        detail: {
          message: err instanceof Error ? err.message : String(err),
          written_count: writtenSoFar.length,
          total_count: run.credentials.length,
        },
      });
    }
  }

  return commit(config, run.id, run, {
    kind: "vault_write_succeeded",
    subscription_id: subscriptionId,
    new_side_effects: newSideEffects,
  });
}

// ── Commit helper ────────────────────────────────────────────

async function commit(
  config: ExecutorConfig,
  runId: string,
  run: Run,
  t: Transition,
): Promise<Run> {
  const result = transition(run, t, nowOf(config));
  return config.runStore.applyTransition(runId, result);
}

function nowOf(config: ExecutorConfig): string {
  return config.now !== undefined ? config.now() : new Date().toISOString();
}

// ── Credential extraction ────────────────────────────────────

// Walk the manifest's declared vault writes. For each, find a step
// whose extracted values include a key matching the vault_write's kind
// (convention: extract name === vault_write.kind). The matching value
// becomes the ExtractedCredential's plaintext.
//
// If the manifest declares N vault writes but only M values were
// extracted, returns M credentials — the executor surfaces this gap
// via credentials_extracted: false and the state machine routes to
// COMPENSATING. Adapter authors can rely on "all-or-nothing" by
// declaring matching extract names.
export function extractCredentials(
  manifest: AdapterManifest,
  run: Run,
): ExtractedCredential[] {
  const declarations = manifest.capabilities.vault_writes;
  if (declarations.length === 0) return [];

  const credentials: ExtractedCredential[] = [];
  for (const decl of declarations) {
    const value = findExtractedValue(run, decl.kind);
    if (value === null) continue;
    credentials.push({
      type: typeFromCapability(decl),
      value,
      env_var_suggestion: null,
      reference: null,
    });
  }
  return credentials;
}

function findExtractedValue(run: Run, name: string): string | null {
  for (const step of run.steps) {
    if (step.status !== "success") continue;
    const response = step.response as { extracted?: Record<string, unknown> } | null;
    const extracted = response?.extracted;
    if (extracted === undefined) continue;
    const value = extracted[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

// VaultWriteCapability.kind is a closed enum that aligns 1:1 with
// CredentialType — so the cast is safe but we go through this helper
// to keep the conversion explicit and audit-friendly.
function typeFromCapability(decl: VaultWriteCapability): ExtractedCredential["type"] {
  return decl.kind;
}

// ── Step bookkeeping ─────────────────────────────────────────

// Linear-progression next-step lookup. The first step in the flow
// without a successful StepRecord at that index is "next." Branch
// steps would change this — they're chunk-8 territory.
export function findNextStepIndex(flow: FlowDef, steps: StepRecord[]): number | null {
  for (let i = 0; i < flow.steps.length; i++) {
    const recorded = steps.find((s) => s.index === i);
    if (recorded === undefined || recorded.status !== "success") return i;
  }
  return null;
}

function computeAttemptNumber(steps: StepRecord[], stepId: string): number {
  const last = steps.filter((s) => s.step_id === stepId).pop();
  return last === undefined ? 1 : last.attempt + 1;
}

// Re-export for downstream callers / tests
export type { AdapterCapabilities };
