// Vault-first egress targets — `use_credential { target }`.
//
// The invariant every test here shares: the credential value reaches the
// DESTINATION and nothing else. It is never in a returned result, and every
// path that cannot deliver it refuses loudly with a named code rather than
// guessing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { constants, publicEncrypt } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sodium from "libsodium-wrappers";
import type { ApiClient } from "../../api-client.js";
import {
  applyDotenvAssignment,
  EgressTargetError,
  executeEgressTarget,
  fetchVaultFieldsSealed,
  resolveDotenvPath,
  resolveEgressField,
  serializeDotenvValue,
  unsafeProjectRoot,
  type EgressTargetDeps,
} from "../egress-targets.js";
import { useCredentialTool } from "../use-credential.js";

const SECRET = "sk-live-must-never-reach-the-model-42";

// ── a fake API that behaves like /v1/vault/egress-fetch ──────────────────

interface FakeApi {
  api: ApiClient;
  fetchCalls: Array<Record<string, unknown>>;
  outcomes: Array<Record<string, unknown>>;
  outcomeError: Error | null;
}

function fakeApi(fields: Record<string, string> = { api_key: SECRET }): FakeApi {
  const state: FakeApi = {
    fetchCalls: [],
    outcomes: [],
    outcomeError: null,
    api: null as unknown as ApiClient,
  };
  state.api = {
    async egressFetchCredential(input: {
      fields?: string[];
      encrypted_response_public_key: string;
    }) {
      state.fetchCalls.push(input as unknown as Record<string, unknown>);
      const requested = input.fields ?? Object.keys(fields);
      const encrypted_fields: Record<string, string> = {};
      for (const name of requested) {
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
      return { reference: "vault://acct/cred-1", encrypted_fields };
    },
    async reportEgressOutcome(input: Record<string, unknown>) {
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
        const r =
          responses.publicKey ??
          ({
            status: 200,
            body: JSON.stringify({ key: publicKeyBase64, key_id: "kid-1" }),
          } as const);
        return { status: r.status, text: async () => r.body };
      }
      if (responses.putDelayMs !== undefined) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, responses.putDelayMs);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          });
        });
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
        reference: "vault://acct/cred-1",
        encrypted_fields: {
          api_key: publicEncrypt(
            { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
            Buffer.from(SECRET, "utf8"),
          ).toString("base64"),
        },
      };
    });
    expect(result.reference).toBe("vault://acct/cred-1");
    expect(result.fields.api_key).toBe(SECRET);

    await fetchVaultFieldsSealed(async (publicKey) => {
      seen.push(publicKey);
      return { reference: "r", encrypted_fields: {} };
    });
    expect(seen[0]).not.toBe(seen[1]);
  });
});

// ── field selection ──────────────────────────────────────────────────────

describe("resolveEgressField", () => {
  it("picks a named field", () => {
    expect(resolveEgressField({ a: "1", b: "2" }, "b")).toBe("2");
  });

  it("prefers `value` when no field is named", () => {
    expect(resolveEgressField({ value: "v", username: "u" }, undefined)).toBe("v");
  });

  it("takes the sole field", () => {
    expect(resolveEgressField({ api_key: SECRET }, undefined)).toBe(SECRET);
  });

  it("takes the one secret-ish field among metadata fields", () => {
    expect(resolveEgressField({ username: "ada", access_key: SECRET }, undefined)).toBe(SECRET);
  });

  it("refuses an ambiguous multi-field credential", () => {
    expect(() => resolveEgressField({ api_key: "1", client_secret: "2" }, undefined)).toThrow(
      /pass `field`/,
    );
  });

  it("names the missing field rather than falling back", () => {
    try {
      resolveEgressField({ api_key: "1" }, "nope");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EgressTargetError);
      expect((err as EgressTargetError).code).toBe("credential_field_missing");
    }
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

  it("declares the destination host so the server can gate it", async () => {
    const api = fakeApi();
    await executeEgressTarget(
      api.api,
      { selector: { service: "browserstack" }, target: { ...GITHUB_TARGET } },
      fakeGithub().deps,
    );
    expect(api.fetchCalls[0]).toMatchObject({
      service: "browserstack",
      destination: { kind: "github_repo_secret", host: "api.github.com" },
    });
  });

  it("accepts a 204 PUT", async () => {
    const api = fakeApi();
    const gh = fakeGithub({ put: { status: 204, body: "" } });
    const result = (await executeEgressTarget(
      api.api,
      { selector: { reference: "r" }, target: { ...GITHUB_TARGET } },
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
        selector: { reference: "r" },
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
        { selector: { reference: "r" }, target: { ...GITHUB_TARGET } },
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
        { selector: { reference: "r" }, target: { ...GITHUB_TARGET } },
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
        { selector: { reference: "r" }, target: { ...GITHUB_TARGET } },
        gh.deps,
      ),
    ).rejects.toThrow(/no key\/key_id/);
  });

  it("aborts a hung call at the 15s bound instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi();
      // Longer than the bound; the AbortController must win.
      const gh = fakeGithub({ putDelayMs: 60_000 });
      const pending = executeEgressTarget(
        api.api,
        { selector: { reference: "r" }, target: { ...GITHUB_TARGET } },
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
      { selector: { reference: "r" }, target: { ...GITHUB_TARGET } },
      fakeGithub().deps,
    );
    expect(api.outcomes).toHaveLength(1);
    expect(api.outcomes[0]).toMatchObject({
      reference: "vault://acct/cred-1",
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
      { selector: { reference: "r" }, target: { ...GITHUB_TARGET } },
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
        { selector: { reference: "r" }, target: { ...GITHUB_TARGET } },
        deps,
      ),
    ).rejects.toThrow(/gh auth login.*GITHUB_TOKEN/s);
  });

  it("selects the named field out of a multi-field credential", async () => {
    const api = fakeApi({ username: "ada", automate_key: SECRET });
    const gh = fakeGithub();
    await executeEgressTarget(
      api.api,
      { selector: { reference: "r" }, field: "automate_key", target: { ...GITHUB_TARGET } },
      gh.deps,
    );
    // Only the named field is asked for, so only it is ever decrypted here.
    expect(api.fetchCalls[0]!.fields).toEqual(["automate_key"]);
    const body = JSON.parse(gh.requests[1]!.body!) as { encrypted_value: string };
    expect(gh.open(body.encrypted_value)).toBe(SECRET);
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
      { selector: { reference: "r" }, target: { kind: "dotenv_write", ...target } },
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

  it("declares the local-file sentinel host so the server audits it", async () => {
    const { api } = await run({ path: ".env", name: "K" });
    expect(api.fetchCalls[0]).toMatchObject({
      destination: { kind: "dotenv_write", host: "local-file" },
    });
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
          selector: { reference: "r" },
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
    expect(await resolveDotenvPath(".env")).toBe(path.join(root, ".env"));
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
    expect(await resolveDotenvPath(".env")).toBe(path.join(root, "config", "real.env"));
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
