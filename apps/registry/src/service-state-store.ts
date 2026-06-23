// ServiceState — memory-overhaul Phase 3. The canonical per-service status,
// split into a PROJECTION (recomputed from the ProvisionEvent firehose, via
// the same buildCompatHealth the on-read /health route uses — so the
// materialized status can't drift) and a MUTABLE OVERLAY (machine-written
// diagnosis + human/heal classification a pure projection can't hold, written
// by the heal pass / OpenIssue in Phase 4).
//
// The projection is a pure function of the recent event slice, so it's
// convergent under concurrent inserts: a later green after a blocking run in
// the same batch wins because recomputeFrom reads the full committed set, not
// "this event". recomputeFrom updates ONLY projection fields and never
// clobbers the overlay.

import {
  buildCompatHealth,
  type CompatScoreOptions,
} from "./compat-score.js";
import type { ProvisionEventRecord } from "./provision-event-store.js";

// The projection fields recomputeFrom owns. Pure derivation of the event slice.
export interface ServiceStateProjection {
  service: string;
  status: string; // CompatState: skill-active | working | struggling | hard-block
  confidence: number; // signed compat_score
  successful_count: number;
  failed_count: number;
  last_attempt_at: Date | null;
  last_green_at: Date | null; // most recent SUCCESS occurred_at
  last_failure_kind: string | null;
}

// The full row = projection + the heal-written overlay.
export interface ServiceStateRecord extends ServiceStateProjection {
  current_diagnosis: string | null;
  diagnosis_evidence: string | null;
  wall_classification: string | null;
  projection_updated_at: Date;
}

// Pure: derive the projection for one service from its recent event slice +
// active-skill flag. Reuses buildCompatHealth so status == the on-read score.
export function projectServiceState(
  service: string,
  attempts: readonly ProvisionEventRecord[],
  hasActiveSkill: boolean,
  opts: CompatScoreOptions = {},
): ServiceStateProjection {
  const health = buildCompatHealth(attempts, hasActiveSkill, opts);
  // last_green = the most recent SUCCESS, derived from the slice (not "this
  // event") so concurrent inserts converge. last_failure_kind = the most
  // recent FAILURE's kind (what the operator is fighting right now).
  let lastGreen: Date | null = null;
  let lastFailureKind: string | null = null;
  let lastFailureAt = -Infinity;
  for (const a of attempts) {
    if (a.status === "success") {
      if (lastGreen === null || a.occurred_at > lastGreen) lastGreen = a.occurred_at;
    } else if (a.occurred_at.getTime() > lastFailureAt) {
      lastFailureAt = a.occurred_at.getTime();
      lastFailureKind = a.failure_kind;
    }
  }
  return {
    service,
    status: health.state,
    confidence: health.compat_score,
    successful_count: health.successful_count,
    failed_count: health.failed_count,
    last_attempt_at:
      health.last_attempt_at !== null ? new Date(health.last_attempt_at) : null,
    last_green_at: lastGreen,
    last_failure_kind: lastFailureKind,
  };
}

// The overlay fields the heal pass / OpenIssue write (Phase 4). All optional —
// a partial patch leaves the others untouched.
export interface ServiceStateOverlayPatch {
  current_diagnosis?: string | null;
  diagnosis_evidence?: string | null;
  wall_classification?: string | null;
}

export interface ServiceStateStore {
  /** Recompute + upsert the PROJECTION half from an event slice. Never
   *  touches the overlay. Idempotent + convergent. */
  recomputeFrom(projection: ServiceStateProjection): Promise<void>;
  /** Patch the mutable OVERLAY half (heal pass / OpenIssue). Never touches
   *  the projection. Creates a bare row if the service has no state yet. */
  patchOverlay(service: string, patch: ServiceStateOverlayPatch): Promise<void>;
  get(service: string): Promise<ServiceStateRecord | null>;
  list(): Promise<ServiceStateRecord[]>;
}

export class InMemoryServiceStateStore implements ServiceStateStore {
  private readonly rows = new Map<string, ServiceStateRecord>();

  async recomputeFrom(p: ServiceStateProjection): Promise<void> {
    const prior = this.rows.get(p.service);
    this.rows.set(p.service, {
      ...p,
      // Preserve the overlay across a projection recompute.
      current_diagnosis: prior?.current_diagnosis ?? null,
      diagnosis_evidence: prior?.diagnosis_evidence ?? null,
      wall_classification: prior?.wall_classification ?? null,
      projection_updated_at: new Date(),
    });
  }

  async patchOverlay(
    service: string,
    patch: ServiceStateOverlayPatch,
  ): Promise<void> {
    const prior = this.rows.get(service);
    if (prior === undefined) {
      // No projection yet — create a bare row carrying only the overlay.
      this.rows.set(service, {
        service,
        status: "struggling",
        confidence: 0,
        successful_count: 0,
        failed_count: 0,
        last_attempt_at: null,
        last_green_at: null,
        last_failure_kind: null,
        current_diagnosis: patch.current_diagnosis ?? null,
        diagnosis_evidence: patch.diagnosis_evidence ?? null,
        wall_classification: patch.wall_classification ?? null,
        projection_updated_at: new Date(),
      });
      return;
    }
    this.rows.set(service, {
      ...prior,
      ...(patch.current_diagnosis !== undefined
        ? { current_diagnosis: patch.current_diagnosis }
        : {}),
      ...(patch.diagnosis_evidence !== undefined
        ? { diagnosis_evidence: patch.diagnosis_evidence }
        : {}),
      ...(patch.wall_classification !== undefined
        ? { wall_classification: patch.wall_classification }
        : {}),
    });
  }

  async get(service: string): Promise<ServiceStateRecord | null> {
    return this.rows.get(service) ?? null;
  }

  async list(): Promise<ServiceStateRecord[]> {
    return [...this.rows.values()];
  }
}
