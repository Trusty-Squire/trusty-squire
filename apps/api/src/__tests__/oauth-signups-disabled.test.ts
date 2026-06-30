// SIGNUPS_DISABLED at the OAuth callback (checklist #10).
//
// The contract: when the kill switch is engaged, a callback that resolves to a
// BRAND-NEW account is refused (redirect to the login error state, no account
// created) — but a RETURNING user (existing provider identity) still signs in.
// We mock the provider network calls (exchangeCode/fetchIdentity) so the
// callback runs offline; isOAuthProvider/buildAuthorizeUrl stay real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";

// vi.mock is hoisted above imports, so the identity it returns must live in a
// vi.hoisted box the factory can legally close over. Tests mutate `.identity`.
const mock = vi.hoisted(() => ({
  identity: {
    provider: "google" as const,
    provider_user_id: "g-default",
    email: "default@test.dev",
    display_name: "Default",
  },
}));

vi.mock("../auth/oauth-providers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/oauth-providers.js")>();
  return {
    ...actual,
    exchangeCode: async (): Promise<string> => "fake-access-token",
    fetchIdentity: async (): Promise<typeof mock.identity> => mock.identity,
  };
});

const savedEnv = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

let server: FastifyInstance;
let deps: ApiDeps;

beforeEach(async () => {
  // credsFor must resolve non-null or the callback 503s before reaching the
  // account logic.
  setEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
  setEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-client-secret");
});

afterEach(async () => {
  await server?.close();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

async function build(): Promise<void> {
  deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
  server = await buildServer({ deps });
}

// A callback request whose state cookie + state query match (CSRF passes).
// Return type inferred from server.inject so we don't depend on the
// light-my-request types being resolvable to tsc.
function callback() {
  return server.inject({
    method: "GET",
    url: "/v1/auth/oauth/google/callback?code=auth-code&state=csrf123",
    headers: { cookie: `ts_oauth_state=google:csrf123:${encodeURIComponent("/vault")}` },
  });
}

describe("SIGNUPS_DISABLED — OAuth callback", () => {
  it("blocks a brand-new account and creates nothing", async () => {
    setEnv("SIGNUPS_DISABLED", "1");
    mock.identity = { provider: "google", provider_user_id: "g-new", email: "newcomer@test.dev", display_name: "New" };
    await build();

    const res = await callback();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("/login?error=signups_disabled");
    // No account was created for the new identity.
    expect(await deps.accountStore.findAccountByEmail("newcomer@test.dev")).toBeNull();
    expect(await deps.oauthIdentityStore.findByProvider("google", "g-new")).toBeNull();
  });

  it("lets a RETURNING user (existing identity) sign in even when engaged", async () => {
    setEnv("SIGNUPS_DISABLED", "1");
    mock.identity = { provider: "google", provider_user_id: "g-returning", email: "regular@test.dev", display_name: "Reg" };
    await build();
    // Pre-existing account + bound identity = a returning user.
    const account = await deps.accountStore.createAccount("regular@test.dev", "Reg");
    await deps.oauthIdentityStore.create({
      account_id: account.id,
      provider: "google",
      provider_user_id: "g-returning",
      email: "regular@test.dev",
    });

    const res = await callback();
    expect(res.statusCode).toBe(302);
    // Lands in the app (not the error state) with a session cookie set.
    expect(res.headers.location).toBe("http://localhost:3000/vault");
    const setCookie = res.headers["set-cookie"];
    expect(String(setCookie)).toContain("ts_session=");
  });

  it("creates a new account normally when NOT engaged", async () => {
    setEnv("SIGNUPS_DISABLED", undefined);
    mock.identity = { provider: "google", provider_user_id: "g-allowed", email: "allowed@test.dev", display_name: "Allowed" };
    await build();

    const res = await callback();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("http://localhost:3000/vault");
    expect(await deps.accountStore.findAccountByEmail("allowed@test.dev")).not.toBeNull();
  });
});
