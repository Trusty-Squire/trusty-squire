// Vault-first egress targets — `use_credential { target }`.
//
// The invariant every test here shares: the credential value reaches the
// DESTINATION and nothing else. It is never in a returned result, and every
// path that cannot deliver it refuses loudly with a named code rather than
// guessing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { constants, publicEncrypt } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sodium from "libsodium-wrappers";
import type { ApiClient } from "../../api-client.js";
import {
  applyDotenvAssignment,
  EgressTargetError,
  executeEgressTarget,
  fetchVaultFieldsSealed,
  openDotenvWriteContext,
  readDotenv,
  resolveDotenvPath,
  selectEgressFieldName,
  withDotenvLock,
  writeDotenv,
  writeFileAtomic0600,
  serializeDotenvValue,
  unsafeProjectRoot,
  DEFAULT_EGRESS_TARGET_DEPS,
  type EgressTargetDeps,
} from "../egress-targets.js";
import { useCredentialTool } from "../use-credential.js";

const SECRET = "sk-live-must-never-reach-the-model-42";

// ── a fake API that behaves like /v1/vault/egress-fetch ──────────────────

interface FakeApi {
  api: ApiClient;
  listCalls: number;
  fetchCalls: Array<Record<string, unknown>>;
  outcomes: Array<Record<string, unknown>>;
  outcomeError: Error | null;
  // A reporter that honours abort (proves signal wiring).
  outcomeHangs: boolean;
  // A reporter that IGNORES abort and never settles — the real network black
  // hole. Only a settling timeout can bound this.
  outcomeNeverSettles: boolean;
  outcomeAbortSeen: boolean;
  fetchError: Error | null;
}

const REFERENCE = "vault://acct/cred-1";

function fakeApi(fields: Record<string, string> = { api_key: SECRET }): FakeApi {
  const state: FakeApi = {
    listCalls: 0,
    fetchCalls: [],
    outcomes: [],
    outcomeError: null,
    outcomeHangs: false,
    outcomeNeverSettles: false,
    outcomeAbortSeen: false,
    fetchError: null,
    api: null as unknown as ApiClient,
  };
  state.api = {
    // Metadata only — this is how the field is chosen before anything is
    // decrypted, so the fake must expose names without values.
    async listCredentials() {
      state.listCalls += 1;
      return {
        credentials: [
          {
            reference: REFERENCE,
            service: "browserstack",
            label: "default",
            field_names: Object.keys(fields),
            allowed_hosts: ["api.github.com", "local-file"],
          },
        ],
      };
    },
    async egressFetchCredential(input: {
      fields: string[];
      encrypted_response_public_key: string;
    }) {
      state.fetchCalls.push(input as unknown as Record<string, unknown>);
      if (state.fetchError !== null) throw state.fetchError;
      const encrypted_fields: Record<string, string> = {};
      for (const name of input.fields) {
        const value = fields[name];
        if (value === undefined) throw new Error(`missing_fields: ${name}`);
        encrypted_fields[name] = publicEncrypt(
          {
            key: input.encrypted_response_public_key,
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
          },
          Buffer.from(value, "utf8"),
        ).toString("base64");
      }
      return { reference: REFERENCE, encrypted_fields };
    },
    async reportEgressOutcome(input: Record<string, unknown>, signal?: AbortSignal) {
      if (state.outcomeNeverSettles) {
        signal?.addEventListener("abort", () => {
          state.outcomeAbortSeen = true;
        });
        // Deliberately never settles, abort or not.
        return await new Promise<never>(() => {});
      }
      if (state.outcomeHangs) {
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        });
      }
      if (state.outcomeError !== null) throw state.outcomeError;
      state.outcomes.push(input);
      return { recorded: true };
    },
  } as unknown as ApiClient;
  return state;
}

// ── a fake GitHub ────────────────────────────────────────────────────────

interface FakeGithub {
  deps: EgressTargetDeps;
  requests: Array<{ url: string; method: string; body?: string }>;
  publicKeyBase64: string;
  open: (sealedBase64: string) => string;
}

function fakeGithub(
  responses: {
    publicKey?: { status: number; body: string };
    put?: { status: number; body: string };
    putDelayMs?: number;
    publicKeyDelayMs?: number;
  } = {},
): FakeGithub {
  const keypair = sodium.crypto_box_keypair();
  const publicKeyBase64 = sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL);
  const requests: FakeGithub["requests"] = [];
  const deps: EgressTargetDeps = {
    githubToken: async () => "gh-token",
    // Real libsodium, so a roundtrip test proves the exact bytes GitHub gets.
    sealForGithub: async (plaintext, key) =>
      sodium.to_base64(
        sodium.crypto_box_seal(
          new Uint8Array(plaintext),
          sodium.from_base64(key, sodium.base64_variants.ORIGINAL),
        ),
        sodium.base64_variants.ORIGINAL,
      ),
    fetch: (async (url: string, init: { method: string; body?: string; signal?: AbortSignal }) => {
      requests.push({
        url: String(url),
        method: init.method,
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
      if (init.method === "GET") {
        if (responses.publicKeyDelayMs !== undefined) {
          await hangUntilAborted(responses.publicKeyDelayMs, init.signal);
        }
        const r =
          responses.publicKey ??
          ({
            status: 200,
            body: JSON.stringify({ key: publicKeyBase64, key_id: "kid-1" }),
          } as const);
        return { status: r.status, text: async () => r.body };
      }
      if (responses.putDelayMs !== undefined) {
        await hangUntilAborted(responses.putDelayMs, init.signal);
      }
      const r = responses.put ?? ({ status: 201, body: "" } as const);
      return { status: r.status, text: async () => r.body };
    }) as unknown as typeof globalThis.fetch,
  };
  return {
    deps,
    requests,
    publicKeyBase64,
    open: (sealedBase64) =>
      Buffer.from(
        sodium.crypto_box_seal_open(
          sodium.from_base64(sealedBase64, sodium.base64_variants.ORIGINAL),
          keypair.publicKey,
          keypair.privateKey,
        ),
      ).toString("utf8"),
  };
}

// A request that takes longer than any bound we set, and honours the abort the
// way a real fetch does.
function hangUntilAborted(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    });
  });
}

const GITHUB_TARGET = {
  kind: "github_repo_secret",
  owner: "octo",
  repo: "demo",
  name: "BROWSERSTACK_KEY",
} as const;

beforeEach(async () => {
  await sodium.ready;
});

// ── the shared vault → local process envelope ────────────────────────────

describe("fetchVaultFieldsSealed", () => {
  it("seals to a fresh keypair per call and decrypts every returned field", async () => {
    const seen: string[] = [];
    const result = await fetchVaultFieldsSealed(async (publicKey) => {
      seen.push(publicKey);
      return {
        reference: REFERENCE,
        encrypted_fields: {
          api_key: publicEncrypt(
            { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
            Buffer.from(SECRET, "utf8"),
          ).toString("base64"),
        },
      };
    });
    expect(result.reference).toBe(REFERENCE);
    expect(result.fields.api_key).toBe(SECRET);

    await fetchVaultFieldsSealed(async (publicKey) => {
      seen.push(publicKey);
      return { reference: "r", encrypted_fields: {} };
    });
    expect(seen[0]).not.toBe(seen[1]);
  });
});

// ── field selection ──────────────────────────────────────────────────────

describe("selectEgressFieldName", () => {
  // Operates on NON-SECRET names from list_credentials, before any decrypt:
  // only the field a destination actually receives is ever fetched.
  it("picks a named field", () => {
    expect(selectEgressFieldName(["a", "b"], "b")).toBe("b");
  });

  it("prefers `value` when no field is named", () => {
    expect(selectEgressFieldName(["value", "username"], undefined)).toBe("value");
  });

  it("takes the sole field", () => {
    expect(selectEgressFieldName(["api_key"], undefined)).toBe("api_key");
  });

  it("takes the one secret-ish field among metadata fields", () => {
    expect(selectEgressFieldName(["username", "access_key"], undefined)).toBe("access_key");
  });

  it("refuses an ambiguous multi-field credential, listing the names", () => {
    expect(() => selectEgressFieldName(["api_key", "client_secret"], undefined)).toThrow(
      /api_key, client_secret.*pass `field`/s,
    );
  });

  it("names the missing field rather than falling back", () => {
    try {
      selectEgressFieldName(["api_key"], "nope");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EgressTargetError);
      expect((err as EgressTargetError).code).toBe("credential_field_missing");
    }
  });
});

describe("least privilege: only one field is ever decrypted", () => {
  it("resolves the field from list_credentials metadata, then fetches only it", async () => {
    const api = fakeApi({ username: "ada", access_key: SECRET });

    await executeEgressTarget(
      api.api,
      { selector: { service: "browserstack" }, target: { ...GITHUB_TARGET } },
      fakeGithub().deps,
    );

    expect(api.listCalls).toBe(1);
    expect(api.fetchCalls[0]!.fields).toEqual(["access_key"]);
  });

  it("keeps the server's ${SECRET} rule exactly — an unmatched name needs `field`", async () => {
    // `automate_key` does not match the secret-ish pattern (`_` is a word
    // character, so \bkey\b never fires inside it). That is the SERVER's rule
    // in http-proxy.ts resolveField, mirrored here on purpose: one rule, one
    // behaviour, and an explicit `field` when it cannot decide.
    const api = fakeApi({ username: "ada", automate_key: SECRET });

    await expect(
      executeEgressTarget(
        api.api,
        { selector: { service: "browserstack" }, target: { ...GITHUB_TARGET } },
        fakeGithub().deps,
      ),
    ).rejects.toThrow(/pass `field`/);
    expect(api.fetchCalls).toHaveLength(0);

    await executeEgressTarget(
      api.api,
      {
        selector: { service: "browserstack" },
        field: "automate_key",
        target: { ...GITHUB_TARGET },
      },
      fakeGithub().deps,
    );
    expect(api.fetchCalls[0]!.fields).toEqual(["automate_key"]);
  });

  it("refuses an ambiguous credential WITHOUT fetching anything", async () => {
    const api = fakeApi({ api_key: SECRET, client_secret: "also-secret" });

    await expect(
      executeEgressTarget(
        api.api,
        { selector: { service: "browserstack" }, target: { ...GITHUB_TARGET } },
        fakeGithub().deps,
      ),
    ).rejects.toThrow(/pass `field`/);

    expect(api.fetchCalls).toHaveLength(0);
  });

  it("sends the destination KIND and repo identity, never a host", async () => {
    const api = fakeApi();
    await executeEgressTarget(
      api.api,
      {
        selector: { reference: REFERENCE },
        target: { ...GITHUB_TARGET, environment: "production" },
      },
      fakeGithub().deps,
    );
    expect(api.fetchCalls[0]!.destination).toEqual({
      kind: "github_repo_secret",
      owner: "octo",
      repo: "demo",
      environment: "production",
    });
    expect(JSON.stringify(api.fetchCalls[0])).not.toContain("host");
  });
});

// ── github_repo_secret ───────────────────────────────────────────────────

describe("github_repo_secret target", () => {
  it("seals the vaulted value to the repo key and PUTs it", async () => {
    const api = fakeApi();
    const gh = fakeGithub();

    const result = (await executeEgressTarget(
      api.api,
      { selector: { reference: "vault://acct/cred-1" }, target: { ...GITHUB_TARGET } },
      gh.deps,
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      status: 201,
      destination: { kind: "github_repo_secret", repo: "octo/demo", name: "BROWSERSTACK_KEY" },
    });
    // The GET/PUT pair hit the repository (not environment) endpoints.
    expect(gh.requests[0]!.url).toBe(
      "https://api.github.com/repos/octo/demo/actions/secrets/public-key",
    );
    expect(gh.requests[1]!.url).toBe(
      "https://api.github.com/repos/octo/demo/actions/secrets/BROWSERSTACK_KEY",
    );
    expect(gh.requests[1]!.method).toBe("PUT");
    // Roundtrip: what GitHub receives decrypts back to the vaulted value.
    const body = JSON.parse(gh.requests[1]!.body!) as { encrypted_value: string; key_id: string };
    expect(body.key_id).toBe("kid-1");
    expect(gh.open(body.encrypted_value)).toBe(SECRET);
    // …and the ciphertext is not the plaintext by any reading.
    expect(gh.requests[1]!.body).not.toContain(SECRET);
    // The result the model sees carries no secret.
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("accepts a 204 PUT", async () => {
    const api = fakeApi();
    const gh = fakeGithub({ put: { status: 204, body: "" } });
    const result = (await executeEgressTarget(
      api.api,
      { selector: { reference: REFERENCE }, target: { ...GITHUB_TARGET } },
      gh.deps,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, status: 204 });
  });

  it("uses the environment endpoints when `environment` is given", async () => {
    const api = fakeApi();
    const gh = fakeGithub();
    const result = (await executeEgressTarget(
      api.api,
      {
        selector: { reference: REFERENCE },
        target: { ...GITHUB_TARGET, environment: "production" },
      },
      gh.deps,
    )) as Record<string, unknown>;

    expect(gh.requests[0]!.url).toBe(
      "https://api.github.com/repos/octo/demo/environments/production/secrets/public-key",
    );
    expect(gh.requests[1]!.url).toBe(
      "https://api.github.com/repos/octo/demo/environments/production/secrets/BROWSERSTACK_KEY",
    );
    expect(result).toMatchObject({ destination: { environment: "production" } });
    expect(api.outcomes[0]).toMatchObject({
      destination: { kind: "github_repo_secret", repo: "octo/demo", environment: "production" },
      status: "ok",
    });
  });

  it("surfaces a 403 verbatim and reports the failure", async () => {
    const api = fakeApi();
    const gh = fakeGithub({
      put: { status: 403, body: '{"message":"Resource not accessible by integration"}' },
    });

    await expect(
      executeEgressTarget(
        api.api,
        { selector: { reference: REFERENCE }, target: { ...GITHUB_TARGET } },
        gh.deps,
      ),
    ).rejects.toThrow(/403.*Resource not accessible by integration/s);

    expect(api.outcomes[0]).toMatchObject({ status: "error" });
    expect(String(api.outcomes[0]!.error)).toContain("Resource not accessible by integration");
    expect(JSON.stringify(api.outcomes)).not.toContain(SECRET);
  });

  it("surfaces a public-key fetch failure without attempting the PUT", async () => {
    const api = fakeApi();
    const gh = fakeGithub({ publicKey: { status: 404, body: '{"message":"Not Found"}' } });

    await expect(
      executeEgressTarget(
        api.api,
        { selector: { reference: REFERENCE }, target: { ...GITHUB_TARGET } },
        gh.deps,
      ),
    ).rejects.toThrow(/404.*Not Found/s);
    expect(gh.requests).toHaveLength(1);
  });

  it("refuses a public-key response with no key/key_id", async () => {
    const api = fakeApi();
    const gh = fakeGithub({ publicKey: { status: 200, body: "{}" } });
    await expect(
      executeEgressTarget(
        api.api,
        { selector: { reference: REFERENCE }, target: { ...GITHUB_TARGET } },
        gh.deps,
      ),
    ).rejects.toThrow(/no key\/key_id/);
  });

  it("aborts a hung PUBLIC-KEY GET at the 15s bound, not just the PUT", async () => {
    // Finding 12: the AbortController helper is shared, but only the PUT was
    // ever exercised. A hung GET is the more likely of the two.
    vi.useFakeTimers();
    try {
      const api = fakeApi();
      const gh = fakeGithub({ publicKeyDelayMs: 60_000 });
      const pending = executeEgressTarget(
        api.api,
        { selector: { reference: REFERENCE }, target: { ...GITHUB_TARGET } },
        gh.deps,
      );
      const assertion = expect(pending).rejects.toThrow(/timed out after 15000ms/);
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
      // It never got as far as the PUT.
      expect(gh.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a hung call at the 15s bound instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi();
      // Longer than the bound; the AbortController must win.
      const gh = fakeGithub({ putDelayMs: 60_000 });
      const pending = executeEgressTarget(
        api.api,
        { selector: { reference: REFERENCE }, target: { ...GITHUB_TARGET } },
        gh.deps,
      );
      const assertion = expect(pending).rejects.toThrow(/timed out after 15000ms/);
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
      expect(api.outcomes[0]).toMatchObject({ status: "error" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the delivery outcome with the repo identity, never the value", async () => {
    const api = fakeApi();
    await executeEgressTarget(
      api.api,
      { selector: { reference: REFERENCE }, target: { ...GITHUB_TARGET } },
      fakeGithub().deps,
    );
    expect(api.outcomes).toHaveLength(1);
    expect(api.outcomes[0]).toMatchObject({
      reference: REFERENCE,
      destination: { kind: "github_repo_secret", repo: "octo/demo" },
      status: "ok",
    });
    expect(JSON.stringify(api.outcomes[0])).not.toContain(SECRET);
  });

  it("still returns the successful result when the outcome report fails", async () => {
    const api = fakeApi();
    api.outcomeError = new Error("registry unreachable");
    const result = (await executeEgressTarget(
      api.api,
      { selector: { reference: REFERENCE }, target: { ...GITHUB_TARGET } },
      fakeGithub().deps,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true });
  });

  it("names both fixes when there is no GitHub token", async () => {
    const api = fakeApi();
    const gh = fakeGithub();
    const deps: EgressTargetDeps = {
      ...gh.deps,
      githubToken: async () => {
        throw new EgressTargetError(
          "github_auth_missing",
          "no GitHub token available: run `gh auth login`, or set GITHUB_TOKEN in this MCP server's environment",
        );
      },
    };
    await expect(
      executeEgressTarget(
        api.api,
        { selector: { reference: REFERENCE }, target: { ...GITHUB_TARGET } },
        deps,
      ),
    ).rejects.toThrow(/gh auth login.*GITHUB_TOKEN/s);
  });

  it("selects the named field out of a multi-field credential", async () => {
    const api = fakeApi({ username: "ada", automate_key: SECRET });
    const gh = fakeGithub();
    await executeEgressTarget(
      api.api,
      { selector: { reference: REFERENCE }, field: "automate_key", target: { ...GITHUB_TARGET } },
      gh.deps,
    );
    // Only the named field is asked for, so only it is ever decrypted here.
    expect(api.fetchCalls[0]!.fields).toEqual(["automate_key"]);
    const body = JSON.parse(gh.requests[1]!.body!) as { encrypted_value: string };
    expect(gh.open(body.encrypted_value)).toBe(SECRET);
  });
});

// ── the outcome report is best-effort AND bounded ────────────────────────

describe("egress-outcome reporting", () => {
  it("returns the completed result when the reporter IGNORES abort entirely", async () => {
    // Finding 3, second pass. The previous version of this test used a mock
    // that rejected on abort — which proves the signal is wired, not that the
    // bound holds. An AbortSignal does not settle a promise: a fetch stack, a
    // proxy, or a mocked client that ignores it leaves the await pending
    // forever, and an already-delivered secret must never be held hostage by
    // an audit row. This reporter is a true black hole.
    vi.useFakeTimers();
    try {
      const api = fakeApi();
      api.outcomeNeverSettles = true;
      const gh = fakeGithub();

      const pending = executeEgressTarget(
        api.api,
        { selector: { reference: REFERENCE }, target: { ...GITHUB_TARGET } },
        gh.deps,
      );
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(6_000);

      // Resolves, does not reject: the PUT succeeded, only the audit hung.
      // The signal IS raised at the bound — but raising it settles nothing,
      // which is exactly why the race is what makes the result return.
      expect(api.outcomeAbortSeen).toBe(true);
      await expect(pending).resolves.toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the ORIGINAL failure when the reporter never settles on an error path", async () => {
    // The error path awaits the same report. A black hole there would swallow
    // the failure the agent needs to see.
    vi.useFakeTimers();
    try {
      const api = fakeApi();
      api.outcomeNeverSettles = true;
      const gh = fakeGithub({ put: { status: 403, body: '{"message":"nope"}' } });

      const pending = executeEgressTarget(
        api.api,
        { selector: { reference: REFERENCE }, target: { ...GITHUB_TARGET } },
        gh.deps,
      );
      const assertion = expect(pending).rejects.toThrow(/403/);
      await vi.advanceTimersByTimeAsync(6_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an outcome when the .env path is refused before any fetch", async () => {
    // Finding 6: preflight refusals used to vanish from the trail entirely.
    const cwd = process.cwd();
    const root = await fs.realpath(mkdtempSync(path.join(tmpdir(), "ts-egress-preflight-")));
    process.chdir(root);
    try {
      const api = fakeApi();
      await expect(
        executeEgressTarget(
          api.api,
          {
            selector: { reference: REFERENCE },
            target: { kind: "dotenv_write", path: "../escaped.env", name: "KEY" },
          },
          fakeGithub().deps,
        ),
      ).rejects.toMatchObject({ code: "path_outside_project" });

      expect(api.fetchCalls).toHaveLength(0);
      expect(api.outcomes[0]).toMatchObject({
        reference: REFERENCE,
        destination: { kind: "dotenv_write", path: "../escaped.env" },
        status: "error",
      });
      expect(String(api.outcomes[0]!.error)).toContain("path_outside_project");
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports an outcome when the vault refuses the fetch (403 off-allowlist)", async () => {
    const api = fakeApi();
    api.fetchError = Object.assign(
      new Error("POST /v1/vault/egress-fetch → 403 host_not_allowed"),
      {
        code: "host_not_allowed",
      },
    );

    await expect(
      executeEgressTarget(
        api.api,
        { selector: { reference: REFERENCE }, target: { ...GITHUB_TARGET } },
        fakeGithub().deps,
      ),
    ).rejects.toThrow(/host_not_allowed/);

    expect(api.outcomes[0]).toMatchObject({
      reference: REFERENCE,
      destination: { kind: "github_repo_secret", repo: "octo/demo" },
      status: "error",
    });
    expect(String(api.outcomes[0]!.error)).toContain("host_not_allowed");
  });

  it("reports an outcome when the field cannot be resolved", async () => {
    const api = fakeApi({ api_key: SECRET, client_secret: "also-secret" });

    await expect(
      executeEgressTarget(
        api.api,
        { selector: { reference: REFERENCE }, target: { ...GITHUB_TARGET } },
        fakeGithub().deps,
      ),
    ).rejects.toThrow(/pass `field`/);

    expect(api.outcomes[0]).toMatchObject({ status: "error" });
    expect(String(api.outcomes[0]!.error)).toContain("credential_field_ambiguous");
    expect(JSON.stringify(api.outcomes)).not.toContain(SECRET);
  });

  it("carries the error CODE, never a field value, on every failure family", async () => {
    const cases: Array<() => Promise<FakeApi>> = [
      async () => {
        const api = fakeApi();
        const gh = fakeGithub({ put: { status: 403, body: '{"message":"nope"}' } });
        await executeEgressTarget(
          api.api,
          { selector: { reference: REFERENCE }, target: { ...GITHUB_TARGET } },
          gh.deps,
        ).catch(() => {});
        return api;
      },
      async () => {
        const api = fakeApi();
        const gh = fakeGithub({ publicKey: { status: 404, body: '{"message":"Not Found"}' } });
        await executeEgressTarget(
          api.api,
          { selector: { reference: REFERENCE }, target: { ...GITHUB_TARGET } },
          gh.deps,
        ).catch(() => {});
        return api;
      },
      async () => {
        const api = fakeApi();
        api.fetchError = new Error("network down");
        await executeEgressTarget(
          api.api,
          { selector: { reference: REFERENCE }, target: { ...GITHUB_TARGET } },
          fakeGithub().deps,
        ).catch(() => {});
        return api;
      },
    ];
    for (const run of cases) {
      const api = await run();
      expect(api.outcomes).toHaveLength(1);
      expect(api.outcomes[0]).toMatchObject({ status: "error" });
      expect(JSON.stringify(api.outcomes[0])).not.toContain(SECRET);
    }
  });
});

// ── the production sodium loader, not a stand-in ─────────────────────────

describe("DEFAULT_EGRESS_TARGET_DEPS.sealForGithub", () => {
  it("roundtrips through the real lazy-loaded libsodium", async () => {
    // Finding 9: the injected implementation in these tests proves sealed-box
    // semantics but not the production dynamic import. This exercises that.
    const keypair = sodium.crypto_box_keypair();
    const publicKeyBase64 = sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL);

    const sealedBase64 = await DEFAULT_EGRESS_TARGET_DEPS.sealForGithub(
      Buffer.from(SECRET, "utf8"),
      publicKeyBase64,
    );

    expect(sealedBase64).not.toContain(SECRET);
    const opened = Buffer.from(
      sodium.crypto_box_seal_open(
        sodium.from_base64(sealedBase64, sodium.base64_variants.ORIGINAL),
        keypair.publicKey,
        keypair.privateKey,
      ),
    ).toString("utf8");
    expect(opened).toBe(SECRET);
  });

  it("is reused across calls without re-initialising", async () => {
    const keypair = sodium.crypto_box_keypair();
    const key = sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL);
    const a = await DEFAULT_EGRESS_TARGET_DEPS.sealForGithub(Buffer.from("one", "utf8"), key);
    const b = await DEFAULT_EGRESS_TARGET_DEPS.sealForGithub(Buffer.from("two", "utf8"), key);
    expect(a).not.toBe(b);
  });
});

// ── resolveGithubToken (the real one) ────────────────────────────────────

describe("resolveGithubToken", () => {
  const originalPath = process.env.PATH;
  const originalToken = process.env.GITHUB_TOKEN;
  let bin: string;

  beforeEach(() => {
    bin = mkdtempSync(path.join(tmpdir(), "ts-gh-bin-"));
    // Empty PATH dir → no `gh` at all, which is the "gh missing" branch.
    process.env.PATH = bin;
    delete process.env.GITHUB_TOKEN;
  });
  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    rmSync(bin, { recursive: true, force: true });
  });

  it("prefers whatever `gh auth token` prints", async () => {
    const { resolveGithubToken } = await import("../egress-targets.js");
    await fs.writeFile(path.join(bin, "gh"), "#!/bin/sh\necho gho_from_gh_cli\n", { mode: 0o755 });
    process.env.GITHUB_TOKEN = "gho_from_env";
    expect(await resolveGithubToken()).toBe("gho_from_gh_cli");
  });

  it("falls back to GITHUB_TOKEN when gh is unavailable", async () => {
    const { resolveGithubToken } = await import("../egress-targets.js");
    process.env.GITHUB_TOKEN = "gho_from_env";
    expect(await resolveGithubToken()).toBe("gho_from_env");
  });

  it("kills a hung `gh auth token` at the 10s bound and falls back to the env", async () => {
    // Finding 11: a locked keyring makes `gh` hang, not fail. Real timers here
    // on purpose — the bound is execFile's own `timeout`, which fake timers do
    // not drive; the assertion is that it terminates and falls through.
    const { resolveGithubToken } = await import("../egress-targets.js");
    await fs.writeFile(path.join(bin, "gh"), "#!/bin/sh\nsleep 60\n", { mode: 0o755 });
    process.env.GITHUB_TOKEN = "gho_from_env";

    const started = Date.now();
    const token = await resolveGithubToken(150);

    expect(token).toBe("gho_from_env");
    // It did not wait for the 60s sleep.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it("errors rather than hanging when `gh` hangs and there is no env token", async () => {
    const { resolveGithubToken } = await import("../egress-targets.js");
    await fs.writeFile(path.join(bin, "gh"), "#!/bin/sh\nsleep 60\n", { mode: 0o755 });

    await expect(resolveGithubToken(150)).rejects.toMatchObject({
      code: "github_auth_missing",
    });
  }, 20_000);

  it("throws github_auth_missing naming both fixes when neither is present", async () => {
    const { resolveGithubToken } = await import("../egress-targets.js");
    try {
      await resolveGithubToken();
      expect.unreachable();
    } catch (err) {
      expect((err as EgressTargetError).code).toBe("github_auth_missing");
      expect((err as Error).message).toContain("gh auth login");
      expect((err as Error).message).toContain("GITHUB_TOKEN");
    }
  });
});

// ── .env grammar (pure) ──────────────────────────────────────────────────

describe("serializeDotenvValue", () => {
  it("double-quotes and escapes backslash and quote", () => {
    expect(serializeDotenvValue('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it("refuses a value containing a newline", () => {
    try {
      serializeDotenvValue("line1\nline2");
      expect.unreachable();
    } catch (err) {
      expect((err as EgressTargetError).code).toBe("dotenv_value_unsupported");
    }
  });
});

describe("applyDotenvAssignment", () => {
  it("creates the assignment when there is no file", () => {
    expect(applyDotenvAssignment(null, "KEY", "v")).toBe('KEY="v"\n');
  });

  it("replaces a plain NAME= line and preserves every other byte", () => {
    const before = "# comment\r\nOTHER=keep\r\nKEY=old\r\n\r\n# trailing\r\n";
    expect(applyDotenvAssignment(before, "KEY", "new")).toBe(
      '# comment\r\nOTHER=keep\r\nKEY="new"\r\n\r\n# trailing\r\n',
    );
  });

  it("replaces an `export NAME=` line and keeps the export prefix", () => {
    expect(applyDotenvAssignment("export KEY=old\n", "KEY", "new")).toBe('export KEY="new"\n');
  });

  it("appends when the key is absent, adding the missing final newline", () => {
    expect(applyDotenvAssignment("OTHER=keep", "KEY", "v")).toBe('OTHER=keep\nKEY="v"\n');
  });

  it("never matches a commented-out assignment", () => {
    expect(applyDotenvAssignment("#KEY=old\n", "KEY", "v")).toBe('#KEY=old\nKEY="v"\n');
  });

  it("refuses a duplicated key rather than guessing which one wins", () => {
    try {
      applyDotenvAssignment("KEY=a\nKEY=b\n", "KEY", "v");
      expect.unreachable();
    } catch (err) {
      expect((err as EgressTargetError).code).toBe("dotenv_unsupported_format");
      expect((err as Error).message).toContain("more than once");
    }
  });

  it("refuses a `NAME = value` spelling it does not parse", () => {
    try {
      applyDotenvAssignment("KEY = old\n", "KEY", "v");
      expect.unreachable();
    } catch (err) {
      expect((err as EgressTargetError).code).toBe("dotenv_unsupported_format");
    }
  });

  it("refuses a line-continued value", () => {
    try {
      applyDotenvAssignment("KEY=abc\\\ndef\n", "KEY", "v");
      expect.unreachable();
    } catch (err) {
      expect((err as EgressTargetError).code).toBe("dotenv_unsupported_format");
      expect((err as Error).message).toContain("multi-line");
    }
  });

  it("refuses an unterminated quoted value", () => {
    try {
      applyDotenvAssignment('KEY="abc\ndef"\n', "KEY", "v");
      expect.unreachable();
    } catch (err) {
      expect((err as EgressTargetError).code).toBe("dotenv_unsupported_format");
    }
  });

  it("rewrites a terminated quoted value on one line", () => {
    expect(applyDotenvAssignment('KEY="abc def"\n', "KEY", "v")).toBe('KEY="v"\n');
  });

  it("appends using the file's own CRLF convention", () => {
    // Finding 5: a CRLF .env that gains one LF-terminated line is a diff the
    // user did not ask for.
    expect(applyDotenvAssignment("# keep\r\nOTHER=keep\r\n", "KEY", "v")).toBe(
      '# keep\r\nOTHER=keep\r\nKEY="v"\r\n',
    );
  });

  it("appends LF to an LF file and adds the missing terminator in the file's EOL", () => {
    expect(applyDotenvAssignment("OTHER=keep\n", "KEY", "v")).toBe('OTHER=keep\nKEY="v"\n');
    expect(applyDotenvAssignment("OTHER=keep\r\n#x\r\nA=1", "KEY", "v")).toBe(
      'OTHER=keep\r\n#x\r\nA=1\r\nKEY="v"\r\n',
    );
  });

  it("accepts a quoted value ending in an EVEN backslash run", () => {
    // Finding 5: `KEY="abc\\"` is a complete one-line value — the closing quote
    // is real because the backslash run before it is even. Refusing it was a
    // false positive.
    expect(applyDotenvAssignment('KEY="abc\\\\"\n', "KEY", "v")).toBe('KEY="v"\n');
    expect(applyDotenvAssignment("KEY=abc\\\\\n", "KEY", "v")).toBe('KEY="v"\n');
  });

  it("still refuses an ODD backslash run, which really does continue", () => {
    for (const before of ['KEY="abc\\\\\\"\ndef"\n', "KEY=abc\\\ndef\n"]) {
      try {
        applyDotenvAssignment(before, "KEY", "v");
        expect.unreachable();
      } catch (err) {
        expect((err as EgressTargetError).code).toBe("dotenv_unsupported_format");
      }
    }
  });

  it("does not match a different key with the same prefix", () => {
    expect(applyDotenvAssignment("KEY_TWO=keep\n", "KEY", "v")).toBe('KEY_TWO=keep\nKEY="v"\n');
  });
});

// ── dotenv_write end to end ──────────────────────────────────────────────

describe("dotenv_write target", () => {
  let root: string;
  let cwd: string;

  beforeEach(async () => {
    cwd = process.cwd();
    root = await fs.realpath(mkdtempSync(path.join(tmpdir(), "ts-egress-proj-")));
    process.chdir(root);
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  async function run(target: { path: string; name: string }, fields?: Record<string, string>) {
    const api = fakeApi(fields);
    const result = (await executeEgressTarget(
      api.api,
      { selector: { reference: REFERENCE }, target: { kind: "dotenv_write", ...target } },
      fakeGithub().deps,
    )) as Record<string, unknown>;
    return { result, api };
  }

  it("creates a fresh .env with mode 0600 and returns no secret", async () => {
    const { result, api } = await run({ path: ".env", name: "BROWSERSTACK_KEY" });

    expect(result).toMatchObject({
      written: true,
      name: "BROWSERSTACK_KEY",
      path: path.join(root, ".env"),
      created: true,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(await fs.readFile(path.join(root, ".env"), "utf8")).toBe(
      `BROWSERSTACK_KEY="${SECRET}"\n`,
    );
    const stat = await fs.stat(path.join(root, ".env"));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(api.outcomes[0]).toMatchObject({
      destination: { kind: "dotenv_write", path: path.join(root, ".env") },
      status: "ok",
    });
  });

  it("declares only the dotenv_write kind — the server derives the gated host", async () => {
    const { api } = await run({ path: ".env", name: "K" });
    expect(api.fetchCalls[0]!.destination).toEqual({ kind: "dotenv_write" });
  });

  it("replaces an existing assignment and preserves the surrounding file", async () => {
    await fs.writeFile(path.join(root, ".env"), "# keep\r\nA=1\r\nKEY=old\r\nB=2\r\n");
    const { result } = await run({ path: ".env", name: "KEY" });
    expect(result).toMatchObject({ created: false });
    expect(await fs.readFile(path.join(root, ".env"), "utf8")).toBe(
      `# keep\r\nA=1\r\nKEY="${SECRET}"\r\nB=2\r\n`,
    );
  });

  it("writes into a nested directory inside the project", async () => {
    await fs.mkdir(path.join(root, "apps", "web"), { recursive: true });
    await run({ path: "apps/web/.env.local", name: "KEY" });
    expect(await fs.readFile(path.join(root, "apps/web/.env.local"), "utf8")).toContain("KEY=");
  });

  it("refuses a path outside the project root", async () => {
    try {
      await run({ path: "../escaped.env", name: "KEY" });
      expect.unreachable();
    } catch (err) {
      expect((err as EgressTargetError).code).toBe("path_outside_project");
    }
  });

  it("refuses an absolute path outside the project root", async () => {
    try {
      await run({ path: path.join(tmpdir(), "elsewhere.env"), name: "KEY" });
      expect.unreachable();
    } catch (err) {
      expect((err as EgressTargetError).code).toBe("path_outside_project");
    }
  });

  it("refuses a symlink that escapes the project root", async () => {
    const outside = await fs.realpath(mkdtempSync(path.join(tmpdir(), "ts-egress-out-")));
    try {
      await fs.writeFile(path.join(outside, "target.env"), "KEY=old\n");
      await fs.symlink(path.join(outside, "target.env"), path.join(root, ".env"));
      try {
        await run({ path: ".env", name: "KEY" });
        expect.unreachable();
      } catch (err) {
        expect((err as EgressTargetError).code).toBe("path_outside_project");
      }
      // The escape target is untouched.
      expect(await fs.readFile(path.join(outside, "target.env"), "utf8")).toBe("KEY=old\n");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a directory that does not exist rather than creating one", async () => {
    try {
      await run({ path: "nope/deeper/.env", name: "KEY" });
      expect.unreachable();
    } catch (err) {
      expect((err as EgressTargetError).code).toBe("dotenv_directory_missing");
    }
  });

  it("refuses an unsupported grammar and leaves the file untouched", async () => {
    const before = "KEY=a\nKEY=b\n";
    await fs.writeFile(path.join(root, ".env"), before);
    await expect(run({ path: ".env", name: "KEY" })).rejects.toThrow(/more than once/);
    expect(await fs.readFile(path.join(root, ".env"), "utf8")).toBe(before);
  });

  it("reports the failure outcome with the destination path", async () => {
    await fs.writeFile(path.join(root, ".env"), "KEY=a\nKEY=b\n");
    const api = fakeApi();
    await expect(
      executeEgressTarget(
        api.api,
        {
          selector: { reference: REFERENCE },
          target: { kind: "dotenv_write", path: ".env", name: "KEY" },
        },
        fakeGithub().deps,
      ),
    ).rejects.toThrow();
    expect(api.outcomes[0]).toMatchObject({
      destination: { kind: "dotenv_write", path: path.join(root, ".env") },
      status: "error",
    });
    expect(JSON.stringify(api.outcomes)).not.toContain(SECRET);
  });

  it("surfaces EACCES and leaves the existing file intact (atomic, no partial write)", async () => {
    const dir = path.join(root, "locked");
    await fs.mkdir(dir);
    const target = path.join(dir, ".env");
    await fs.writeFile(target, "KEY=old\n");
    await fs.chmod(dir, 0o500);
    try {
      await expect(run({ path: "locked/.env", name: "KEY" })).rejects.toThrow(/EACCES|EPERM/);
      // Neither a partial file nor a stray temp file survived.
      expect(await fs.readFile(target, "utf8")).toBe("KEY=old\n");
      expect((await fs.readdir(dir)).sort()).toEqual([".env"]);
    } finally {
      await fs.chmod(dir, 0o700);
    }
  });

  it("preserves BOTH updates when two writers race the same file", async () => {
    // Finding 2: atomic rename makes each replacement whole; it does NOT make
    // read-modify-write atomic. Without the lock, one of these silently wins.
    await fs.writeFile(path.join(root, ".env"), "BASE=1\n");

    await Promise.all([
      run({ path: ".env", name: "FIRST" }, { api_key: "one" }),
      run({ path: ".env", name: "SECOND" }, { api_key: "two" }),
    ]);

    const written = await fs.readFile(path.join(root, ".env"), "utf8");
    expect(written).toContain("BASE=1");
    expect(written).toContain('FIRST="one"');
    expect(written).toContain('SECOND="two"');
    // And no lock file survived.
    expect(await fs.readdir(root)).toEqual([".env"]);
  });

  it("keeps every writer's key when many race at once", async () => {
    await fs.writeFile(path.join(root, ".env"), "BASE=1\n");
    const names = ["K0", "K1", "K2", "K3", "K4", "K5"];

    await Promise.all(names.map((name) => run({ path: ".env", name }, { api_key: name })));

    const written = await fs.readFile(path.join(root, ".env"), "utf8");
    for (const name of names) expect(written).toContain(`${name}="${name}"`);
    expect(written).toContain("BASE=1");
  });

  it("re-tightens the mode to 0600 when REPLACING a looser existing file", async () => {
    const target = path.join(root, ".env");
    await fs.writeFile(target, "KEY=old\n");
    await fs.chmod(target, 0o644);

    await run({ path: ".env", name: "KEY" });

    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });

  it("refuses rather than clobbering a writer that never took the lock", async () => {
    // Finding 2a. The lock serializes writers that USE it. An editor, or any
    // other tool, does not — and renaming our temp file over their completed
    // write destroys it silently. `writeFileAtomic0600` re-reads the target's
    // stamp immediately before the rename; this drives that check directly by
    // handing it a stamp that no longer matches.
    const target = path.join(root, ".env");
    await fs.writeFile(target, "BASE=1\n");
    const destination = await resolveDotenvPath(".env");
    const context = await openDotenvWriteContext(destination);
    const stale = (await readDotenv(context)).stamp;

    // Someone else writes while we were "thinking".
    await fs.writeFile(target, "BASE=1\nEXTERNAL=keep\n");

    await expect(writeFileAtomic0600(context, 'KEY="v"\n', stale)).rejects.toThrow();
    await context.handle.close();

    // Their update is intact, and no temp file was left behind.
    expect(await fs.readFile(target, "utf8")).toBe("BASE=1\nEXTERNAL=keep\n");
    expect(await fs.readdir(root)).toEqual([".env"]);
  });

  it("re-reads and reapplies when a non-locking writer lands mid-transaction", async () => {
    // The same window, through the whole public path: a large value widens the
    // temp write enough for an external writer to land, and the transaction
    // must either preserve their update or fail — never silently drop it.
    const target = path.join(root, ".env");
    await fs.writeFile(target, "BASE=1\n");
    const big = "x".repeat(4 * 1024 * 1024);

    let external: Promise<void> | null = null;
    const write = run({ path: ".env", name: "KEY" }, { api_key: big }).then(
      () => "ok" as const,
      () => "failed" as const,
    );
    // Land the external write while the 4MiB temp file is being written.
    external = new Promise<void>((resolve) => {
      setTimeout(() => {
        void fs.writeFile(target, "BASE=1\nEXTERNAL=keep\n").then(() => resolve());
      }, 1);
    });

    const [outcome] = await Promise.all([write, external]);
    const finalContent = await fs.readFile(target, "utf8");

    // The invariant: whatever happened, the external writer's completed update
    // was not silently discarded.
    if (outcome === "ok") {
      expect(finalContent).toContain("EXTERNAL=keep");
      expect(finalContent).toContain("KEY=");
    } else {
      expect(finalContent).toBe("BASE=1\nEXTERNAL=keep\n");
    }
  }, 30_000);

  it("releases only a lock it still owns (ABA)", async () => {
    // Finding 2b. Stale recovery and release used to unlink the lock PATHNAME
    // unconditionally. If the lock we looked at is released and re-acquired by
    // someone else in between, that deletes THEIR lock and admits two writers.
    const target = path.join(root, ".env");
    await fs.writeFile(target, "BASE=1\n");
    const destination = await resolveDotenvPath(".env");
    const lockPath = `${target}.lock`;

    // A write whose body swaps the lock file for a DIFFERENT inode, standing in
    // for "our lock expired and someone else took the pathname".
    const context = await openDotenvWriteContext(destination);
    await withDotenvLock(context, ".env.lock", async () => {
      await fs.rm(lockPath, { force: true });
      await fs.writeFile(lockPath, "someone-else");
    });
    await context.handle.close();

    // Release must have left the impostor alone.
    expect(await fs.readFile(lockPath, "utf8")).toBe("someone-else");
    await fs.rm(lockPath, { force: true });
  });

  it("refuses when the validated directory is swapped for a symlink before the write", async () => {
    // Finding 7: path validation is check-then-use. dev/ino identity is what
    // makes the recheck at write time mean something.
    const outside = await fs.realpath(mkdtempSync(path.join(tmpdir(), "ts-egress-swap-")));
    try {
      await fs.mkdir(path.join(root, "config"));
      const destination = await resolveDotenvPath("config/.env");

      // The swap an attacker with in-project write access can perform between
      // validation and use.
      await fs.rename(path.join(root, "config"), path.join(root, "config.moved"));
      await fs.symlink(outside, path.join(root, "config"));

      await expect(writeDotenv(destination, "KEY", SECRET)).rejects.toMatchObject({
        code: "path_outside_project",
      });

      // Nothing landed on the escape target.
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("writes through the directory HANDLE, so a swap before fs.open cannot escape", async () => {
    // Finding 7, second pass. The reviewer swapped the directory in the window
    // between the last identity check and the temp `fs.open`, and captured the
    // plaintext from their own directory before cleanup removed it. Cleanup
    // after exposure is not containment.
    //
    // The transaction now holds the validated directory OPEN and resolves every
    // path through that descriptor, so the swap is simply irrelevant: the bytes
    // follow the fd to the real directory.
    const outside = await fs.realpath(mkdtempSync(path.join(tmpdir(), "ts-egress-swap2-")));
    try {
      await fs.mkdir(path.join(root, "config"));
      const destination = await resolveDotenvPath("config/.env");
      const context = await openDotenvWriteContext(destination);

      // The swap, performed AFTER the context is open — precisely the window
      // that used to leak.
      await fs.rename(path.join(root, "config"), path.join(root, "config.moved"));
      await fs.symlink(outside, path.join(root, "config"));

      let wrote = true;
      try {
        await writeFileAtomic0600(context, `KEY="${SECRET}"\n`, null);
      } catch {
        wrote = false;
      }
      await context.handle.close();

      // Whatever happened, NOTHING of ours is in the attacker's directory —
      // not a finished file, not a temp file, not an empty one.
      expect(await fs.readdir(outside)).toEqual([]);
      // On a platform with fd-relative resolution the write simply succeeds
      // against the real directory; without it, it refuses. Both are safe.
      if (wrote) {
        expect(await fs.readFile(path.join(root, "config.moved", ".env"), "utf8")).toBe(
          `KEY="${SECRET}"\n`,
        );
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("never leaves plaintext in a swapped-in directory, even transiently", async () => {
    // The sharper form of the same property: poll the attacker's directory
    // throughout the write and assert no file with the secret EVER appears —
    // not "was cleaned up afterwards".
    const outside = await fs.realpath(mkdtempSync(path.join(tmpdir(), "ts-egress-swap3-")));
    let seenOutside: string[] = [];
    const poll = setInterval(() => {
      try {
        seenOutside = seenOutside.concat(readdirSync(outside));
      } catch {
        /* directory momentarily unreadable */
      }
    }, 1);
    try {
      await fs.mkdir(path.join(root, "config"));
      const destination = await resolveDotenvPath("config/.env");
      const context = await openDotenvWriteContext(destination);
      await fs.rename(path.join(root, "config"), path.join(root, "config.moved"));
      await fs.symlink(outside, path.join(root, "config"));

      await writeFileAtomic0600(context, `KEY="${SECRET}"\n`, null).catch(() => {});
      await context.handle.close();
    } finally {
      clearInterval(poll);
      const contents = readdirSync(outside);
      rmSync(outside, { recursive: true, force: true });
      expect(seenOutside).toEqual([]);
      expect(contents).toEqual([]);
    }
  });

  it("refuses when the validated directory is deleted before the write", async () => {
    await fs.mkdir(path.join(root, "gone"));
    const destination = await resolveDotenvPath("gone/.env");
    await fs.rm(path.join(root, "gone"), { recursive: true, force: true });

    await expect(writeDotenv(destination, "KEY", SECRET)).rejects.toMatchObject({
      code: "path_outside_project",
    });
  });

  it("refuses a value that cannot be represented on one line", async () => {
    try {
      await run({ path: ".env", name: "KEY" }, { api_key: "line1\nline2" });
      expect.unreachable();
    } catch (err) {
      expect((err as EgressTargetError).code).toBe("dotenv_value_unsupported");
    }
  });

  it("escapes quotes and backslashes in the written value", async () => {
    await run({ path: ".env", name: "KEY" }, { api_key: 'a"b\\c' });
    expect(await fs.readFile(path.join(root, ".env"), "utf8")).toBe('KEY="a\\"b\\\\c"\n');
  });
});

// ── resolveDotenvPath in isolation ───────────────────────────────────────

describe("resolveDotenvPath", () => {
  let root: string;
  let cwd: string;
  beforeEach(async () => {
    cwd = process.cwd();
    root = await fs.realpath(mkdtempSync(path.join(tmpdir(), "ts-egress-path-")));
    process.chdir(root);
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves a relative path against the project root", async () => {
    const destination = await resolveDotenvPath(".env");
    expect(destination.path).toBe(path.join(root, ".env"));
    expect(destination.dir).toBe(root);
  });

  it("captures the directory identity the write will re-assert", async () => {
    const destination = await resolveDotenvPath(".env");
    const stat = await fs.stat(root);
    expect(destination.dev).toBe(stat.dev);
    expect(destination.ino).toBe(stat.ino);
  });

  it("refuses to treat a filesystem root or $HOME as a project root", async () => {
    // Goose Desktop spawns MCP extensions with cwd=/ (CLAUDE.md). Rooted
    // there the gate would authorise the entire filesystem.
    expect(unsafeProjectRoot(path.parse(process.cwd()).root, "/home/ada")).toBe(true);
    expect(unsafeProjectRoot("/home/ada", "/home/ada")).toBe(true);
    expect(unsafeProjectRoot("/home/ada", "/home/ada/")).toBe(true);
    expect(unsafeProjectRoot("/home/ada/proj", "/home/ada")).toBe(false);
    expect(unsafeProjectRoot("/home/ada/proj", undefined)).toBe(false);
  });

  it("refuses a .env write when the server was launched at $HOME", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = root;
    try {
      await expect(resolveDotenvPath(".env")).rejects.toMatchObject({
        code: "project_root_unsafe",
      });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("resolves an in-project symlink to its real target", async () => {
    await fs.mkdir(path.join(root, "config"));
    await fs.writeFile(path.join(root, "config", "real.env"), "");
    await fs.symlink(path.join(root, "config", "real.env"), path.join(root, ".env"));
    const destination = await resolveDotenvPath(".env");
    expect(destination.path).toBe(path.join(root, "config", "real.env"));
    expect(destination.dir).toBe(path.join(root, "config"));
  });
});

// ── use_credential wiring ────────────────────────────────────────────────

describe("use_credential { target } schema", () => {
  it("refuses both http and target in one call", () => {
    const parsed = useCredentialTool.inputSchema.safeParse({
      service: "x",
      http: { method: "GET", url: "https://api.example.com" },
      target: { kind: "dotenv_write", path: ".env", name: "KEY" },
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses neither http nor target", () => {
    const parsed = useCredentialTool.inputSchema.safeParse({ service: "x" });
    expect(parsed.success).toBe(false);
  });

  it("accepts a target alone", () => {
    const parsed = useCredentialTool.inputSchema.safeParse({
      service: "x",
      target: { kind: "github_repo_secret", owner: "octo", repo: "demo", name: "KEY" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a secret name GitHub would reject", () => {
    const parsed = useCredentialTool.inputSchema.safeParse({
      service: "x",
      target: { kind: "github_repo_secret", owner: "octo", repo: "demo", name: "not-valid" },
    });
    expect(parsed.success).toBe(false);
  });

  it("routes a target through the egress path, never through the http proxy", async () => {
    const cwd = process.cwd();
    const root = await fs.realpath(mkdtempSync(path.join(tmpdir(), "ts-egress-tool-")));
    process.chdir(root);
    try {
      const api = fakeApi();
      const useCredential = vi.fn();
      const merged = { ...api.api, useCredential } as unknown as ApiClient;
      const result = (await useCredentialTool.handler(
        useCredentialTool.inputSchema.parse({
          service: "browserstack",
          target: { kind: "dotenv_write", path: ".env", name: "KEY" },
        }),
        merged,
      )) as Record<string, unknown>;

      expect(useCredential).not.toHaveBeenCalled();
      expect(result).toMatchObject({ written: true, name: "KEY" });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
