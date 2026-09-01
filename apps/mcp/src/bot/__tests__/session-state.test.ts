import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEphemeralProfile,
  destroyEphemeralProfile,
  hasUsableGoogleIdentity,
  invalidateCanonicalGoogleIdentity,
  MAX_SESSION_STATE_BYTES,
  readPendingSessionStates,
  readCanonicalIdentityState,
  readCanonicalIdentityMetadata,
  readSessionState,
  sessionStatePath,
  removePendingSessionState,
  writeCanonicalIdentitySnapshot,
  writePendingSessionState,
  writeSessionState,
} from "../session-state.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("operator session storage state", () => {
  it("selects portable Google identity only while its auth marker is unexpired", () => {
    const nowSeconds = 2_000_000_000;
    const state = (expires: number) => ({
      cookies: [
        {
          name: "SID",
          value: "opaque-google-session",
          domain: ".google.com",
          path: "/",
          expires,
          httpOnly: true,
          secure: true,
          sameSite: "Lax" as const,
        },
      ],
      origins: [],
    });

    expect(hasUsableGoogleIdentity(state(nowSeconds - 1), nowSeconds)).toBe(false);
    expect(hasUsableGoogleIdentity(state(nowSeconds + 1), nowSeconds)).toBe(true);
    expect(hasUsableGoogleIdentity(state(-1), nowSeconds)).toBe(true);
  });

  it("atomically preserves cookies, local storage, and IndexedDB in a 0600 snapshot", async () => {
    const canonical = mkdtempSync(join(tmpdir(), "ts-session-state-"));
    roots.push(canonical);
    const state = {
      cookies: [
        {
          name: "user_session",
          value: "opaque",
          domain: "github.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax" as const,
        },
      ],
      origins: [
        {
          origin: "https://merchant.example",
          localStorage: [{ name: "token", value: "opaque" }],
          indexedDB: [{ name: "auth", version: 1, stores: [] }],
        },
      ],
    };

    await writeSessionState(canonical, state);

    await expect(readSessionState(canonical)).resolves.toEqual(state);
    expect(JSON.parse(readFileSync(sessionStatePath(canonical), "utf8"))).toEqual({
      version: 1,
      storageState: state,
    });
    expect(statSync(sessionStatePath(canonical)).mode & 0o777).toBe(0o600);
  });

  it("keeps the prior snapshot when terminal ownership is revoked before publish", async () => {
    const canonical = mkdtempSync(join(tmpdir(), "ts-session-state-revoked-"));
    roots.push(canonical);
    const cookie = {
      domain: ".google.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    };
    const prior = { cookies: [{ ...cookie, name: "SID", value: "prior" }], origins: [] };
    const replacement = {
      cookies: [{ ...cookie, name: "SID", value: "replacement" }],
      origins: [],
    };

    await writeSessionState(canonical, prior);
    await expect(writeSessionState(canonical, replacement, () => false)).resolves.toBe(false);

    await expect(readSessionState(canonical)).resolves.toEqual(prior);
  });

  it("persists successful deferred state independently of canonical publication", async () => {
    const canonical = mkdtempSync(join(tmpdir(), "ts-session-state-pending-"));
    roots.push(canonical);
    const state = {
      cookies: [
        {
          name: "merchant_session",
          value: "confirmed",
          domain: ".merchant.test",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax" as const,
        },
      ],
      origins: [],
    };

    const path = await writePendingSessionState(canonical, state);
    expect(path).toBeDefined();
    await expect(readPendingSessionStates(canonical)).resolves.toEqual([{ path, state }]);
    expect(statSync(path!).mode & 0o777).toBe(0o600);

    await removePendingSessionState(path!);
    await expect(readPendingSessionStates(canonical)).resolves.toEqual([]);
  });

  it("invalidates only Google identity before a forced re-login", async () => {
    const canonical = mkdtempSync(join(tmpdir(), "ts-session-state-google-invalidate-"));
    roots.push(canonical);
    const state = {
      cookies: [
        {
          name: "SID",
          value: "google-session",
          domain: ".google.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax" as const,
        },
        {
          name: "rp_session",
          value: "merchant-session",
          domain: ".merchant.test",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax" as const,
        },
      ],
      origins: [
        { origin: "https://accounts.google.com", localStorage: [] },
        { origin: "https://merchant.test", localStorage: [{ name: "session", value: "live" }] },
      ],
    };
    await writeCanonicalIdentitySnapshot(canonical, state, {
      googleAccountEmail: "old-account@example.com",
    });

    await expect(invalidateCanonicalGoogleIdentity(canonical)).resolves.toBe(true);

    await expect(readCanonicalIdentityState(canonical)).resolves.toEqual({
      storageState: {
        cookies: [state.cookies[1]],
        origins: [state.origins[1]],
      },
      identityMetadata: undefined,
    });
  });

  it("refuses to replace a live Google identity with a cookie-less capture", async () => {
    const canonical = mkdtempSync(join(tmpdir(), "ts-session-state-marker-clear-"));
    roots.push(canonical);
    await writeCanonicalIdentitySnapshot(
      canonical,
      {
        cookies: [
          {
            name: "SID",
            value: "live-google-session-before-capture",
            domain: ".google.com",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [],
      },
      undefined,
    );
    const capturedWithoutGoogle = {
      cookies: [
        {
          name: "merchant_session",
          value: "still-valid-merchant-session",
          domain: ".merchant.test",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax" as const,
        },
      ],
      origins: [],
    };
    await expect(
      writeCanonicalIdentitySnapshot(canonical, capturedWithoutGoogle, undefined),
    ).resolves.toBe(false);

    await expect(readSessionState(canonical)).resolves.toMatchObject({
      cookies: [expect.objectContaining({ name: "SID", domain: ".google.com" })],
    });
  });

  it("leaves one complete snapshot after concurrent last-writer-wins publishes", async () => {
    const canonical = mkdtempSync(join(tmpdir(), "ts-session-state-concurrent-"));
    roots.push(canonical);
    const first = { cookies: [], origins: [{ origin: "https://first.example", localStorage: [] }] };
    const second = {
      cookies: [],
      origins: [{ origin: "https://second.example", localStorage: [] }],
    };

    await Promise.all([writeSessionState(canonical, first), writeSessionState(canonical, second)]);

    expect([first, second]).toContainEqual(await readSessionState(canonical));
  });

  it("skips oversized snapshots and preserves the prior state", async () => {
    const canonical = mkdtempSync(join(tmpdir(), "ts-session-state-cap-"));
    roots.push(canonical);
    const prior = {
      cookies: [],
      origins: [{ origin: "https://prior.example", localStorage: [] }],
    };
    const oversized = {
      cookies: [],
      origins: [
        {
          origin: "https://oversized.example",
          localStorage: [{ name: "state", value: "x".repeat(MAX_SESSION_STATE_BYTES) }],
        },
      ],
    };
    await writeSessionState(canonical, prior);

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(writeSessionState(canonical, oversized)).resolves.toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("retaining prior snapshot"));
    } finally {
      error.mockRestore();
    }

    await expect(readSessionState(canonical)).resolves.toEqual(prior);
  });

  it("publishes storage state and account metadata as one accepted unit", async () => {
    const canonical = mkdtempSync(join(tmpdir(), "ts-session-state-identity-"));
    roots.push(canonical);
    const prior = { cookies: [], origins: [] };
    await writeCanonicalIdentitySnapshot(canonical, prior, {
      googleAccountEmail: "prior@example.com",
    });
    const oversized = {
      cookies: [],
      origins: [
        {
          origin: "https://oversized.example",
          localStorage: [{ name: "state", value: "x".repeat(MAX_SESSION_STATE_BYTES) }],
        },
      ],
    };

    await expect(
      writeCanonicalIdentitySnapshot(canonical, oversized, {
        googleAccountEmail: "replacement@example.com",
      }),
    ).resolves.toBe(false);

    await expect(readSessionState(canonical)).resolves.toEqual(prior);
    await expect(readCanonicalIdentityMetadata(canonical)).resolves.toEqual({
      googleAccountEmail: "prior@example.com",
    });
  });

  it("refuses an aborted canonical identity publication", async () => {
    const canonical = mkdtempSync(join(tmpdir(), "ts-session-state-aborted-identity-"));
    roots.push(canonical);
    const prior = {
      cookies: [],
      origins: [{ origin: "https://prior.example", localStorage: [] }],
    };
    const replacement = {
      cookies: [],
      origins: [{ origin: "https://replacement.example", localStorage: [] }],
    };
    await writeCanonicalIdentitySnapshot(canonical, prior, undefined);
    const controller = new AbortController();
    controller.abort();

    await expect(
      writeCanonicalIdentitySnapshot(canonical, replacement, undefined, () => true, [], {
        signal: controller.signal,
      }),
    ).resolves.toBe(false);

    await expect(readSessionState(canonical)).resolves.toEqual(prior);
  });

  it("migrates the existing provider email with legacy storage state", async () => {
    const canonical = mkdtempSync(join(tmpdir(), "ts-session-state-legacy-identity-"));
    roots.push(canonical);
    const state = {
      cookies: [
        {
          name: "SID",
          value: "legacy-google-session",
          domain: ".google.com",
          path: "/",
        },
      ],
      origins: [],
    };
    writeFileSync(sessionStatePath(canonical), JSON.stringify(state));
    writeFileSync(
      join(canonical, "provider-emails.json"),
      JSON.stringify({ google: "legacy-worker@example.com" }),
    );

    await expect(readCanonicalIdentityState(canonical)).resolves.toEqual({
      storageState: state,
      identityMetadata: { googleAccountEmail: "legacy-worker@example.com" },
    });
  });

  it("treats missing metadata in a v1 snapshot as authoritative", async () => {
    const canonical = mkdtempSync(join(tmpdir(), "ts-session-state-v1-metadata-clear-"));
    roots.push(canonical);
    const state = {
      cookies: [
        {
          name: "SID",
          value: "rotated-google-session",
          domain: ".google.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax" as const,
        },
      ],
      origins: [],
    };
    await writeCanonicalIdentitySnapshot(canonical, state, undefined);
    writeFileSync(
      join(canonical, "provider-emails.json"),
      JSON.stringify({ google: "stale-worker@example.com" }),
    );

    await expect(readCanonicalIdentityState(canonical)).resolves.toEqual({
      storageState: state,
      identityMetadata: undefined,
    });
  });

  it("creates distinct 0700 profiles and removes only the finished instance", async () => {
    const first = createEphemeralProfile();
    const second = createEphemeralProfile();
    try {
      expect(first).not.toBe(second);
      expect(statSync(first).mode & 0o777).toBe(0o700);
      await destroyEphemeralProfile(first);
      expect(() => statSync(first)).toThrow();
      expect(statSync(second).isDirectory()).toBe(true);
    } finally {
      await destroyEphemeralProfile(second);
    }
  });
});
