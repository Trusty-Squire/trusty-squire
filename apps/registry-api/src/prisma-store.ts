// Prisma-backed ManifestStore. Used by the CLI + (eventually) the
// production server. Imported lazily so tests + the in-memory dev
// loop don't pay the @prisma/client startup cost.

import { PrismaClient, type Prisma } from "@prisma/client";
import type { AdapterManifest } from "@trusty-squire/adapter-sdk";
import {
  type InsertManifestInput,
  type ManifestStore,
  ManifestConflictError,
} from "./store.js";
import type { ManifestRecord } from "./types.js";

export class PrismaManifestStore implements ManifestStore {
  private constructor(private readonly client: PrismaClient) {}

  static async fromEnv(): Promise<PrismaManifestStore> {
    const client = new PrismaClient();
    await client.$connect();
    return new PrismaManifestStore(client);
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }

  async insert(input: InsertManifestInput): Promise<void> {
    try {
      await this.client.adapterManifestRecord.create({
        data: {
          service: input.service,
          version: input.version,
          manifest_json: input.manifest as unknown as Prisma.InputJsonValue,
          signature: input.signature,
          signed_at: input.signed_at,
          signed_by: input.signed_by,
        },
      });
    } catch (err) {
      // Prisma's P2002 = unique constraint violation. Translate to
      // our domain error.
      if (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: unknown }).code === "P2002"
      ) {
        throw new ManifestConflictError(input.service, input.version);
      }
      throw err;
    }
  }

  async get(service: string, version: string): Promise<ManifestRecord | null> {
    const row = await this.client.adapterManifestRecord.findUnique({
      where: { service_version: { service, version } },
    });
    return row === null ? null : toRecord(row);
  }

  async listVersions(service: string): Promise<ManifestRecord[]> {
    const rows = await this.client.adapterManifestRecord.findMany({
      where: { service },
      orderBy: { created_at: "desc" },
    });
    return rows.map(toRecord);
  }

  async listLatestByService(): Promise<ManifestRecord[]> {
    // Postgres's DISTINCT ON would be ideal here; Prisma raw query
    // for now to keep the surface small. A naive groupBy + lookup
    // would be 1+N queries — fine for v0 directory size, not great
    // long-term.
    const rows = await this.client.adapterManifestRecord.findMany({
      where: { disabled_at: null },
      orderBy: [{ service: "asc" }, { created_at: "desc" }],
    });
    const seen = new Set<string>();
    const out: ManifestRecord[] = [];
    for (const row of rows) {
      if (seen.has(row.service)) continue;
      seen.add(row.service);
      out.push(toRecord(row));
    }
    return out;
  }

  async disable(service: string, version: string, reason: string): Promise<void> {
    await this.client.adapterManifestRecord.update({
      where: { service_version: { service, version } },
      data: { disabled_at: new Date(), disabled_reason: reason },
    });
  }
}

function toRecord(row: {
  service: string;
  version: string;
  manifest_json: Prisma.JsonValue;
  signature: string;
  signed_at: Date;
  signed_by: string;
  disabled_at: Date | null;
  disabled_reason: string | null;
  created_at: Date;
}): ManifestRecord {
  return {
    service: row.service,
    version: row.version,
    manifest: row.manifest_json as unknown as AdapterManifest,
    signature: row.signature,
    signed_at: row.signed_at,
    signed_by: row.signed_by,
    disabled_at: row.disabled_at,
    disabled_reason: row.disabled_reason,
    created_at: row.created_at,
  };
}
