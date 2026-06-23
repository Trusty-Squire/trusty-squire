// Prisma-backed ServiceState store (memory-overhaul Phase 3). The upsert in
// recomputeFrom writes ONLY the projection columns; patchOverlay writes ONLY
// the overlay columns — so the two halves never clobber each other.

import {
  createRegistryPrismaClient,
  type RegistryPrismaClient,
} from "./registry-prisma-client.js";
import type {
  ServiceStateOverlayPatch,
  ServiceStateProjection,
  ServiceStateRecord,
  ServiceStateStore,
} from "./service-state-store.js";

type Row = {
  service: string;
  status: string;
  confidence: number;
  successful_count: number;
  failed_count: number;
  last_attempt_at: Date | null;
  last_green_at: Date | null;
  last_failure_kind: string | null;
  current_diagnosis: string | null;
  diagnosis_evidence: string | null;
  wall_classification: string | null;
  projection_updated_at: Date;
};

function mapRow(r: Row): ServiceStateRecord {
  return { ...r };
}

export class PrismaServiceStateStore implements ServiceStateStore {
  private constructor(private readonly client: RegistryPrismaClient) {}

  static async fromEnv(): Promise<PrismaServiceStateStore> {
    const client = createRegistryPrismaClient();
    await client.$connect();
    return new PrismaServiceStateStore(client);
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }

  async recomputeFrom(p: ServiceStateProjection): Promise<void> {
    // Projection columns only — the overlay is untouched on update.
    const projectionCols = {
      status: p.status,
      confidence: p.confidence,
      successful_count: p.successful_count,
      failed_count: p.failed_count,
      last_attempt_at: p.last_attempt_at,
      last_green_at: p.last_green_at,
      last_failure_kind: p.last_failure_kind,
    };
    await this.client.serviceState.upsert({
      where: { service: p.service },
      create: { service: p.service, ...projectionCols },
      update: projectionCols,
    });
  }

  async patchOverlay(
    service: string,
    patch: ServiceStateOverlayPatch,
  ): Promise<void> {
    // Overlay columns only. On create (no projection yet) seed neutral
    // projection defaults so the row is valid; the next event recomputes them.
    const overlayCols = {
      ...(patch.current_diagnosis !== undefined
        ? { current_diagnosis: patch.current_diagnosis }
        : {}),
      ...(patch.diagnosis_evidence !== undefined
        ? { diagnosis_evidence: patch.diagnosis_evidence }
        : {}),
      ...(patch.wall_classification !== undefined
        ? { wall_classification: patch.wall_classification }
        : {}),
    };
    await this.client.serviceState.upsert({
      where: { service },
      create: { service, status: "struggling", confidence: 0, ...overlayCols },
      update: overlayCols,
    });
  }

  async get(service: string): Promise<ServiceStateRecord | null> {
    const r = await this.client.serviceState.findUnique({ where: { service } });
    return r === null ? null : mapRow(r as Row);
  }

  async list(): Promise<ServiceStateRecord[]> {
    const rows = await this.client.serviceState.findMany({
      orderBy: { service: "asc" },
    });
    return (rows as Row[]).map(mapRow);
  }
}
