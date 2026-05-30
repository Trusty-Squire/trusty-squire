import { describe, expect, it, vi } from "vitest";
import type { DedupCandidate } from "../dedup-credentials.js";
import { planAccountDedup, runDedup } from "../dedup-credentials.js";

// Builds a candidate with the few fields the planner reads. `service`
// undefined => no metadata.service key at all (the unkeyable case).
function cand(
  reference: string,
  opts: { service?: string; label?: string; createdAt: string },
): DedupCandidate {
  const metadata: Record<string, unknown> =
    opts.service === undefined ? {} : { service: opts.service };
  return {
    reference,
    account_id: "acct_1",
    label: opts.label ?? "default",
    created_at: new Date(opts.createdAt),
    metadata,
  };
}

describe("planAccountDedup", () => {
  it("keeps the newest of a 3-row same-(service,label) group and collapses the other two", () => {
    const groups = planAccountDedup([
      cand("cred_old", { service: "ipinfo", createdAt: "2026-01-01T00:00:00Z" }),
      cand("cred_new", { service: "ipinfo", createdAt: "2026-03-01T00:00:00Z" }),
      cand("cred_mid", { service: "ipinfo", createdAt: "2026-02-01T00:00:00Z" }),
    ]);

    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g?.kept).toBe("cred_new");
    expect(g?.collapsed).toEqual(["cred_mid", "cred_old"]);
  });

  it("matches service case-insensitively when grouping", () => {
    const groups = planAccountDedup([
      cand("cred_a", { service: "IPInfo", createdAt: "2026-01-01T00:00:00Z" }),
      cand("cred_b", { service: "ipinfo", createdAt: "2026-02-01T00:00:00Z" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kept).toBe("cred_b");
    expect(groups[0]?.collapsed).toEqual(["cred_a"]);
  });

  it("does NOT collapse rows that share a service but differ by label", () => {
    const groups = planAccountDedup([
      cand("cred_prod", { service: "stripe", label: "prod", createdAt: "2026-01-01T00:00:00Z" }),
      cand("cred_dev", { service: "stripe", label: "dev", createdAt: "2026-02-01T00:00:00Z" }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it("leaves rows with no metadata.service untouched", () => {
    const groups = planAccountDedup([
      cand("cred_x", { createdAt: "2026-01-01T00:00:00Z" }),
      cand("cred_y", { createdAt: "2026-02-01T00:00:00Z" }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it("treats an empty-string service as unkeyable", () => {
    const groups = planAccountDedup([
      cand("cred_x", { service: "", createdAt: "2026-01-01T00:00:00Z" }),
      cand("cred_y", { service: "", createdAt: "2026-02-01T00:00:00Z" }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it("isolates groups: a duplicate pair and a singleton yield one group", () => {
    const groups = planAccountDedup([
      cand("dup_old", { service: "resend", createdAt: "2026-01-01T00:00:00Z" }),
      cand("dup_new", { service: "resend", createdAt: "2026-02-01T00:00:00Z" }),
      cand("solo", { service: "sentry", createdAt: "2026-01-15T00:00:00Z" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.service).toBe("resend");
    expect(groups[0]?.collapsed).toEqual(["dup_old"]);
  });
});

// A faked store/audit that records calls — enough to prove the dry-run
// path mutates nothing and the apply path soft-deletes + audits exactly
// the planned references. We don't construct full CredentialRecords; the
// store fake returns the candidates the planner consumes, narrowed to the
// shape runDedup reads off each record (reference/account_id/label/
// created_at/metadata).
type StoreLike = Parameters<typeof runDedup>[0];
type AuditLike = Parameters<typeof runDedup>[1];

function fakeStore(records: DedupCandidate[]): {
  store: StoreLike;
  softDeletes: { reference: string; deletedAt: Date }[];
} {
  const softDeletes: { reference: string; deletedAt: Date }[] = [];
  const accountIds = [...new Set(records.map((r) => r.account_id))];
  const store = {
    listAllAccountIds: async () => accountIds,
    listByAccount: async (accountId: string) =>
      records.filter((r) => r.account_id === accountId),
    softDelete: async (reference: string, deletedAt: Date) => {
      softDeletes.push({ reference, deletedAt });
    },
    // runDedup only calls the three methods above; the rest of the
    // PrismaCredentialStore surface is never reached on this path.
  } as unknown as StoreLike;
  return { store, softDeletes };
}

function fakeAudit(): {
  audit: AuditLike;
  events: { account_id: string; type: string; reference: string; collapsed_into: string | undefined }[];
} {
  const events: { account_id: string; type: string; reference: string; collapsed_into: string | undefined }[] = [];
  const audit = {
    record: async (event: {
      account_id: string;
      type: string;
      payload: { reference: string; collapsed_into?: string };
    }) => {
      events.push({
        account_id: event.account_id,
        type: event.type,
        reference: event.payload.reference,
        collapsed_into: event.payload.collapsed_into,
      });
    },
  } as unknown as AuditLike;
  return { audit, events };
}

describe("runDedup", () => {
  const records: DedupCandidate[] = [
    cand("cred_old", { service: "ipinfo", createdAt: "2026-01-01T00:00:00Z" }),
    cand("cred_new", { service: "ipinfo", createdAt: "2026-03-01T00:00:00Z" }),
    cand("cred_mid", { service: "ipinfo", createdAt: "2026-02-01T00:00:00Z" }),
  ];

  it("dry-run mutates nothing (no soft-deletes, no audit events)", async () => {
    const { store, softDeletes } = fakeStore(records);
    const { audit, events } = fakeAudit();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await runDedup(store, audit, /* apply */ false);

    expect(softDeletes).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(result.groupsAffected).toBe(1);
    expect(result.rowsCollapsed).toBe(2);
    vi.restoreAllMocks();
  });

  it("apply soft-deletes exactly the collapsed refs and records a collapsed audit event each", async () => {
    const { store, softDeletes } = fakeStore(records);
    const { audit, events } = fakeAudit();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await runDedup(store, audit, /* apply */ true);

    expect(softDeletes.map((s) => s.reference).sort()).toEqual(["cred_mid", "cred_old"]);
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.type).toBe("vault.credential_collapsed");
      expect(e.collapsed_into).toBe("cred_new");
      expect(["cred_mid", "cred_old"]).toContain(e.reference);
    }
    // The survivor is never touched.
    expect(softDeletes.map((s) => s.reference)).not.toContain("cred_new");
    vi.restoreAllMocks();
  });
});
