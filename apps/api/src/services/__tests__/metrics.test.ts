import { describe, expect, it, vi } from "vitest";
import {
  collectMetrics,
  makeCachedCollector,
  renderPrometheus,
  type MetricsSnapshot,
} from "../metrics.js";
import type { ApiPrismaClient } from "../api-prisma-client.js";

const SNAPSHOT: MetricsSnapshot = {
  accounts_total: 12,
  machine_tokens_total: 40,
  residential_installs_total: 7,
  credentials_total: 31,
  egress_grants_total: 9,
  egress_grants_active: 5,
  captcha_events_total: 8,
  vault_audit_events_total: 256,
  db_up: 1,
};

describe("renderPrometheus", () => {
  it("emits HELP/TYPE/value for every gauge plus labelled build_info", () => {
    const out = renderPrometheus(SNAPSHOT, "0.1.0");
    expect(out).toBe(
      [
        "# HELP squire_accounts_total Total accounts created.",
        "# TYPE squire_accounts_total gauge",
        "squire_accounts_total 12",
        "# HELP squire_machine_tokens_total Total machine tokens issued (installs incl. infra/CI).",
        "# TYPE squire_machine_tokens_total gauge",
        "squire_machine_tokens_total 40",
        "# HELP squire_residential_installs_total Machine tokens from residential ASNs (honest external-install signal).",
        "# TYPE squire_residential_installs_total gauge",
        "squire_residential_installs_total 7",
        "# HELP squire_credentials_total Total credentials stored in the vault.",
        "# TYPE squire_credentials_total gauge",
        "squire_credentials_total 31",
        "# HELP squire_egress_grants_total Total egress grants ever minted.",
        "# TYPE squire_egress_grants_total gauge",
        "squire_egress_grants_total 9",
        "# HELP squire_egress_grants_active Egress grants not yet revoked.",
        "# TYPE squire_egress_grants_active gauge",
        "squire_egress_grants_active 5",
        "# HELP squire_captcha_events_total Total captcha encounters recorded.",
        "# TYPE squire_captcha_events_total gauge",
        "squire_captcha_events_total 8",
        "# HELP squire_vault_audit_events_total Total vault audit-trail events recorded.",
        "# TYPE squire_vault_audit_events_total gauge",
        "squire_vault_audit_events_total 256",
        "# HELP squire_db_up 1 if the database answered the liveness probe, else 0.",
        "# TYPE squire_db_up gauge",
        "squire_db_up 1",
        "# HELP squire_build_info Build metadata; value is always 1, version carried as a label.",
        "# TYPE squire_build_info gauge",
        'squire_build_info{version="0.1.0"} 1',
        "",
      ].join("\n"),
    );
  });

  it("escapes backslash, double-quote and newline in the version label", () => {
    const out = renderPrometheus(SNAPSHOT, 'v1\\beta"x\ny');
    expect(out).toContain('squire_build_info{version="v1\\\\beta\\"x\\ny"} 1');
  });

  it("ends with a trailing newline", () => {
    expect(renderPrometheus(SNAPSHOT, "0.1.0").endsWith("\n")).toBe(true);
  });
});

// A stub ApiPrismaClient whose count() mocks return per-model fixtures and
// record their `where` args so we can assert the residential + active filters.
function stubPrisma(): {
  prisma: ApiPrismaClient;
  calls: { residentialWhere: unknown; activeWhere: unknown };
} {
  const calls: { residentialWhere: unknown; activeWhere: unknown } = {
    residentialWhere: "UNSET",
    activeWhere: "UNSET",
  };
  const machineTokenCount = vi.fn(
    (args?: { where?: Record<string, unknown> }): Promise<number> => {
      // First (no where) = grand total; the asn_class one is the residential filter.
      if (args?.where?.asn_class !== undefined) {
        calls.residentialWhere = args.where;
        return Promise.resolve(7);
      }
      return Promise.resolve(40);
    },
  );
  const egressCount = vi.fn(
    (args?: { where?: Record<string, unknown> }): Promise<number> => {
      if (args?.where !== undefined && "revoked_at" in args.where) {
        calls.activeWhere = args.where;
        return Promise.resolve(5);
      }
      return Promise.resolve(9);
    },
  );
  // Only the methods collectMetrics touches need to be real; the rest of the
  // ApiPrismaClient surface is unused here. The cast is the standard
  // narrow-stub pattern (commented) — building the full client is infeasible.
  const prisma = {
    account: { count: vi.fn(() => Promise.resolve(12)) },
    machineToken: { count: machineTokenCount },
    credential: { count: vi.fn(() => Promise.resolve(31)) },
    egressGrant: { count: egressCount },
    captchaEvent: { count: vi.fn(() => Promise.resolve(8)) },
    vaultAuditEvent: { count: vi.fn(() => Promise.resolve(256)) },
  } as unknown as ApiPrismaClient;
  return { prisma, calls };
}

describe("collectMetrics", () => {
  it("maps every count, applies residential + active filters, db_up=1", async () => {
    const { prisma, calls } = stubPrisma();
    const snap = await collectMetrics(prisma, () => Promise.resolve(true));
    expect(snap).toEqual(SNAPSHOT);
    expect(calls.residentialWhere).toEqual({ asn_class: "residential" });
    expect(calls.activeWhere).toEqual({ revoked_at: null });
  });

  it("short-circuits to zeros + db_up=0 when the DB ping fails", async () => {
    const { prisma } = stubPrisma();
    const accountCount = prisma.account.count;
    const snap = await collectMetrics(prisma, () => Promise.resolve(false));
    expect(snap.db_up).toBe(0);
    expect(snap.accounts_total).toBe(0);
    expect(snap.machine_tokens_total).toBe(0);
    // No counts should run when the DB is down.
    expect(accountCount).not.toHaveBeenCalled();
  });
});

describe("makeCachedCollector", () => {
  it("serves the cached snapshot within ttl, recomputes after it advances", async () => {
    let clock = 1000;
    const collect = vi.fn(() => Promise.resolve({ ...SNAPSHOT }));
    const cached = makeCachedCollector(collect, 15000, () => clock);

    await cached();
    await cached(); // within ttl
    clock += 14999;
    await cached(); // still within ttl
    expect(collect).toHaveBeenCalledTimes(1);

    clock += 2; // now 15001ms past the first collect → ttl elapsed
    await cached();
    expect(collect).toHaveBeenCalledTimes(2);
  });
});
