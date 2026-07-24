import { describe, expect, it } from "vitest";
import { InMemoryE2ECredentialStore } from "../in-memory-e2e-credential-store.js";

const ACCOUNT = "01HACCOUNTAAAAAAAAAAAAAAAA";
const OTHER_ACCOUNT = "01HOTHERBBBBBBBBBBBBBBBBBB";

describe("InMemoryE2ECredentialStore", () => {
  it("roundtrips an opaque blob while metadata lists omit it", async () => {
    const store = new InMemoryE2ECredentialStore(() => new Date("2026-07-23T12:00:00.000Z"));
    const blob = '{ "ciphertext": "synthetic", "iv": [1, 2, 3] }';

    const id = await store.create(ACCOUNT, "Test card", blob);

    expect(await store.getByIdForAccount(id, ACCOUNT)).toMatchObject({ id, blob });
    const list = await store.listByAccount(ACCOUNT);
    expect(list).toEqual([
      {
        id,
        label: "Test card",
        createdAt: new Date("2026-07-23T12:00:00.000Z"),
      },
    ]);
    expect(list[0]).not.toHaveProperty("blob");
  });

  it("denies cross-account access and delete, then lets the owner delete", async () => {
    const store = new InMemoryE2ECredentialStore();
    const id = await store.create(ACCOUNT, "Test card", '{"synthetic":true}');

    expect(await store.getByIdForAccount(id, OTHER_ACCOUNT)).toBeNull();
    expect(await store.deleteForAccount(id, OTHER_ACCOUNT)).toBe(false);
    expect(await store.getByIdForAccount(id, ACCOUNT)).not.toBeNull();

    expect(await store.deleteForAccount(id, ACCOUNT)).toBe(true);
    expect(await store.getByIdForAccount(id, ACCOUNT)).toBeNull();
  });

  it("lists newest credentials first with a stable ID tie-breaker", async () => {
    let now = new Date("2026-07-23T12:00:00.000Z");
    const store = new InMemoryE2ECredentialStore(() => now);
    const firstId = await store.create(ACCOUNT, "First", "{}");
    const tiedId = await store.create(ACCOUNT, "Tied", "{}");
    now = new Date("2026-07-23T12:00:01.000Z");
    const newestId = await store.create(ACCOUNT, "Newest", "{}");

    const list = await store.listByAccount(ACCOUNT);
    expect(list.map((record) => record.id)).toEqual([
      newestId,
      ...[firstId, tiedId].sort().reverse(),
    ]);
  });
});
