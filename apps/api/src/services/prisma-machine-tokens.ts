// Postgres-backed MachineTokenStore.
//
// Conforms to the same MachineTokenStore interface as the in-memory
// variant; tests still use in-memory because they don't want a real
// database. Production wires this when AUTH_DATABASE_URL is set.

import { randomBytes } from "node:crypto";
import type { ApiPrismaClient } from "./api-prisma-client.js";
import type {
  AsnFingerprint,
  MachineTokenRecord,
  MachineTokenStore,
} from "./machine-tokens.js";

const TOKEN_PREFIX = "tsm_";

export class PrismaMachineTokenStore implements MachineTokenStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async issue(now: Date, asn?: AsnFingerprint): Promise<MachineTokenRecord> {
    const random = randomBytes(32).toString("base64url");
    const token = `${TOKEN_PREFIX}${random}`;
    const row = await this.prisma.machineToken.create({
      data: {
        token,
        created_at: now,
        signup_count: 0,
        last_used_at: null,
        paired_account_id: null,
        asn_class: asn?.class ?? null,
        asn_number: asn?.number ?? null,
        asn_org: asn?.org ?? null,
        asn_country: asn?.country ?? null,
      },
    });
    return this.toRecord(row);
  }

  async find(token: string): Promise<MachineTokenRecord | null> {
    const row = await this.prisma.machineToken.findUnique({ where: { token } });
    return row === null ? null : this.toRecord(row);
  }

  async incrementUsage(token: string, now: Date): Promise<MachineTokenRecord | null> {
    try {
      const row = await this.prisma.machineToken.update({
        where: { token },
        data: { signup_count: { increment: 1 }, last_used_at: now },
      });
      return this.toRecord(row);
    } catch (err) {
      // P2025 = record not found. Same shape as the in-memory store's
      // "return null" for an unknown token.
      if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2025") {
        return null;
      }
      throw err;
    }
  }

  async markPaired(token: string, accountId: string): Promise<void> {
    await this.prisma.machineToken.updateMany({
      where: { token },
      data: { paired_account_id: accountId },
    });
  }

  private toRecord(row: {
    token: string;
    created_at: Date;
    signup_count: number;
    last_used_at: Date | null;
    paired_account_id: string | null;
    asn_class?: string | null;
    asn_number?: string | null;
    asn_org?: string | null;
    asn_country?: string | null;
  }): MachineTokenRecord {
    const asnClass = row.asn_class;
    const asn: AsnFingerprint | null =
      asnClass === "residential" || asnClass === "datacenter" || asnClass === "unknown"
        ? {
            class: asnClass,
            number: row.asn_number ?? null,
            org: row.asn_org ?? null,
            country: row.asn_country ?? null,
          }
        : null;
    return {
      token: row.token,
      created_at: row.created_at,
      signup_count: row.signup_count,
      last_used_at: row.last_used_at,
      paired_account_id: row.paired_account_id,
      asn,
    };
  }
}
