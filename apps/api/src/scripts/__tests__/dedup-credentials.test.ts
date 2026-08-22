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

// A faked store that records atomic collapses — enough to prove the dry-run
// path mutates nothing and the apply path soft-deletes + audits exactly
// the planned references. We don't construct full CredentialRecords; the
// store fake returns the candidates the planner consumes, narrowed to the
// shape runDedup reads off each record (reference/account_id/label/
// created_at/metadata).
type StoreLike = Parameters<typeof runDedup>[0];

function fakeStore(records: DedupCandidate[]): {
  store: StoreLike;
  softDeletes: { reference: string; deletedAt: Date }[];
  events: {
    account_id: string;
    type: string;
    reference: string;
    collapsed_into: string;
  }[];
} {
  const softDeletes: { reference: string; deletedAt: Date }[] = [];
  const events: {
    account_id: string;
    type: string;
    reference: string;
    collapsed_into: string;
  }[] = [];
  const accountIds = [...new Set(records.map((r) => r.account_id))];
  const store = {
    listAllAccountIds: async () => accountIds,
    listByAccount: async (accountId: string) => records.filter((r) => r.account_id === accountId),
    collapseDuplicateSlot: async (
      accountId: string,
      service: string,
      label: string,
      deletedAt: Date,
    ) => {
      const slot = records
        .filter(
          (record) =>
            record.account_id === accountId &&
            record.label === label &&
            typeof record.metadata.service === "string" &&
            record.metadata.service.toLowerCase() === service.toLowerCase() &&
            !softDeletes.some((entry) => entry.reference === record.reference),
        )
        .sort((left, right) => right.created_at.getTime() - left.created_at.getTime());
      const [survivor, ...collapsed] = slot;
      if (survivor === undefined || collapsed.length === 0) return null;
      for (const candidate of collapsed) {
        softDeletes.push({ reference: candidate.reference, deletedAt });
        events.push({
          account_id: accountId,
          type: "vault.credential_collapsed",
          reference: candidate.reference,
          collapsed_into: survivor.reference,
        });
      }
      return {
        survivor: survivor.reference,
        collapsed: collapsed.map((candidate) => candidate.reference),
      };
    },
    // runDedup only calls the three methods above; the rest of the
    // PrismaCredentialStore surface is never reached on this path.
  } as unknown as StoreLike;
  return { store, softDeletes, events };
}

describe("runDedup", () => {
  const records: DedupCandidate[] = [
    cand("cred_old", { service: "ipinfo", createdAt: "2026-01-01T00:00:00Z" }),
    cand("cred_new", { service: "ipinfo", createdAt: "2026-03-01T00:00:00Z" }),
    cand("cred_mid", { service: "ipinfo", createdAt: "2026-02-01T00:00:00Z" }),
  ];

  it("dry-run mutates nothing (no soft-deletes, no audit events)", async () => {
    const { store, softDeletes, events } = fakeStore(records);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await runDedup(store, /* apply */ false);

    expect(softDeletes).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(result.groupsAffected).toBe(1);
    expect(result.rowsCollapsed).toBe(2);
    vi.restoreAllMocks();
  });

  it("apply soft-deletes exactly the collapsed refs and records a collapsed audit event each", async () => {
    const { store, softDeletes, events } = fakeStore(records);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await runDedup(store, /* apply */ true);

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

  it("does not delete a row that left the duplicate slot after planning", async () => {
    const moving = records.map((record) => ({ ...record, metadata: { ...record.metadata } }));
    const { store, softDeletes, events } = fakeStore(moving);
    const originalList = store.listByAccount.bind(store);
    store.listByAccount = async (accountId: string) => {
      const snapshot = (await originalList(accountId)).map((record) => ({
        ...record,
        metadata: { ...record.metadata },
      }));
      moving.find((record) => record.reference === "cred_old")!.label = "moved";
      return snapshot;
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await runDedup(store, true);

    expect(result.rowsCollapsed).toBe(1);
    expect(softDeletes.map((entry) => entry.reference)).toEqual(["cred_mid"]);
    expect(events.map((event) => event.reference)).toEqual(["cred_mid"]);
    vi.restoreAllMocks();
  });

  it("keeps the current newest row when the planned survivor leaves the slot", async () => {
    const moving = records.map((record) => ({ ...record, metadata: { ...record.metadata } }));
    const { store, softDeletes, events } = fakeStore(moving);
    const originalList = store.listByAccount.bind(store);
    store.listByAccount = async (accountId: string) => {
      const snapshot = (await originalList(accountId)).map((record) => ({
        ...record,
        metadata: { ...record.metadata },
      }));
      moving.find((record) => record.reference === "cred_new")!.label = "moved";
      return snapshot;
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await runDedup(store, true);

    expect(result.rowsCollapsed).toBe(1);
    expect(softDeletes.map((entry) => entry.reference)).toEqual(["cred_old"]);
    expect(events).toMatchObject([
      { reference: "cred_old", collapsed_into: "cred_mid" },
    ]);
    vi.restoreAllMocks();
  });
});
