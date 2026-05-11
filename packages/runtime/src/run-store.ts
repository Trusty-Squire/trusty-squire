// RunStore — persistence interface for the orchestration runtime.
//
// The executor calls this through dependency injection. InMemoryRunStore
// is for tests and local dev; production wires Prisma in chunk 5+.
//
// applyTransition is atomic: the run patch and the audit event are
// persisted together or not at all. The Prisma implementation will
// wrap both writes in a transaction; the in-memory store performs them
// in a single synchronous block.

import { ulid } from "ulid";
import type {
  Run,
  RunContext,
  RunEvent,
  RunState,
  Tier,
  TransitionResult,
} from "./types.js";

export interface CreateRunInput {
  account_id: string;
  service: string;
  plan: string;
  project_name: string;
  user_facing_purpose?: string | null;
  mandate_id: string;
  adapter_id: string;
  adapter_version: string;
  current_tier?: Tier;
  // Optional pre-computed key. When omitted, the store derives a SHA-256
  // hash of (account_id, service, project_name).
  idempotency_key?: string;
  context: RunContext;
}

export interface RunStore {
  createRun(input: CreateRunInput): Promise<{ run: Run; created: boolean }>;
  loadRun(runId: string): Promise<Run>;
  applyTransition(runId: string, result: TransitionResult): Promise<Run>;
  loadEvents(runId: string): Promise<RunEvent[]>;
  findRunsInState(state: RunState, limit: number): Promise<Run[]>;
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run not found: ${runId}`);
    this.name = "RunNotFoundError";
  }
}

// Derived from (account_id, service, project_name). Stable across
// retries — the executor uses this to deduplicate run creations within
// the idempotency window (24h, enforced by callers).
export async function computeIdempotencyKey(
  account_id: string,
  service: string,
  project_name: string,
): Promise<string> {
  const data = new TextEncoder().encode(`${account_id}|${service}|${project_name}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Per-step header used by adapters that respect server-side idempotency
// (Stripe-style). Format intentionally readable for debugging audits.
export function computeStepIdempotencyKey(
  runId: string,
  stepId: string,
  attempt: number,
): string {
  return `${runId}.step.${stepId}.attempt.${attempt}`;
}

// ── In-memory implementation ─────────────────────────────────

export class InMemoryRunStore implements RunStore {
  // Idempotency window of 24h is documented but not enforced here —
  // tests don't exercise it and prod uses Prisma where the unique
  // constraint enforces idempotency forever.
  private readonly runs = new Map<string, Run>();
  private readonly events = new Map<string, RunEvent[]>();
  private readonly idempotencyIndex = new Map<string, string>();

  async createRun(input: CreateRunInput): Promise<{ run: Run; created: boolean }> {
    const key =
      input.idempotency_key ??
      (await computeIdempotencyKey(input.account_id, input.service, input.project_name));
    const indexKey = `${input.account_id}::${key}`;

    const existingId = this.idempotencyIndex.get(indexKey);
    if (existingId !== undefined) {
      const existing = this.runs.get(existingId);
      if (existing !== undefined) return { run: clone(existing), created: false };
    }

    const now = new Date().toISOString();
    const run: Run = {
      id: ulid(),
      account_id: input.account_id,
      idempotency_key: key,
      service: input.service,
      plan: input.plan,
      project_name: input.project_name,
      user_facing_purpose: input.user_facing_purpose ?? null,
      state: "CREATED",
      state_entered_at: now,
      retry_count: 0,
      mandate_id: input.mandate_id,
      delta_mandate_id: null,
      adapter_id: input.adapter_id,
      adapter_version: input.adapter_version,
      current_tier: input.current_tier ?? 1,
      steps: [],
      side_effects: [],
      context: input.context,
      subscription_id: null,
      credentials: null,
      failure_reason: null,
      failure_detail: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    };

    this.runs.set(run.id, run);
    this.events.set(run.id, []);
    this.idempotencyIndex.set(indexKey, run.id);
    return { run: clone(run), created: true };
  }

  async loadRun(runId: string): Promise<Run> {
    const run = this.runs.get(runId);
    if (run === undefined) throw new RunNotFoundError(runId);
    return clone(run);
  }

  async applyTransition(runId: string, result: TransitionResult): Promise<Run> {
    const run = this.runs.get(runId);
    if (run === undefined) throw new RunNotFoundError(runId);

    // Atomic block: patch + event commit together. If the test harness
    // throws mid-block, neither is observable — both writes happen
    // after the patch shape is finalised.
    const patched: Run = applyPatch(run, result);
    const event: RunEvent = {
      ...result.event,
      id: ulid(),
      emitted_at: new Date().toISOString(),
    };

    this.runs.set(runId, patched);
    const list = this.events.get(runId) ?? [];
    list.push(event);
    this.events.set(runId, list);

    return clone(patched);
  }

  async loadEvents(runId: string): Promise<RunEvent[]> {
    if (!this.runs.has(runId)) throw new RunNotFoundError(runId);
    const list = this.events.get(runId) ?? [];
    return list.map((e) => ({ ...e }));
  }

  async findRunsInState(state: RunState, limit: number): Promise<Run[]> {
    const out: Run[] = [];
    for (const r of this.runs.values()) {
      if (r.state === state) out.push(clone(r));
      if (out.length >= limit) break;
    }
    return out;
  }
}

// ── Helpers ──────────────────────────────────────────────────

function applyPatch(run: Run, result: TransitionResult): Run {
  const now = new Date().toISOString();
  // Splice context_generated_merge into run.context.generated rather
  // than overwriting whole fields. Leaves existing generated keys
  // intact while adding new ones.
  const { context_generated_merge, ...rest } = result.patch;
  const patched: Run = {
    ...run,
    ...rest,
    state: result.next_state,
    updated_at: now,
  };
  if (context_generated_merge !== undefined) {
    patched.context = {
      ...run.context,
      generated: { ...run.context.generated, ...context_generated_merge },
    };
  }
  return patched;
}

// Defensive clone so callers can't accidentally mutate the store's
// internal state. Cheap for the test fixtures we use.
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
