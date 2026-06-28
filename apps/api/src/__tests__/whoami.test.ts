// GET /v1/auth/whoami — surfaces the user's account + bound provider
// identities. Powers the install wizard's "which steps are done?"
// polling.
//
// Two flows pinned here:
//   - Anonymous caller: 200 with signed_in:false (NOT 401), so the
//     wizard's step-1 CTA renders without distinguishing "broken auth"
//     from "no session yet."
//   - Signed-in caller with multiple identities: returns them sorted
//     so the wizard render is deterministic.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";

describe("/v1/auth/whoami", () => {
  let app: FastifyInstance;
  let deps: ApiDeps;

  beforeEach(async () => {
    deps = buildInMemoryDeps({
      sessionSecret: "test-secret-not-used",
      pollIntervalMs: 1,
    });
    app = await buildServer({ deps });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns signed_in:false for an anonymous caller (no 401)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/auth/whoami" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ signed_in: false, identities: [] });
  });

  it("returns the sorted list of bound providers when signed in", async () => {
    // Set up an account with two identities + a session, then call
    // whoami with the session cookie. We can't easily run the full
    // OAuth callback in-process; instead we exercise the same plumbing
    // by seeding the stores directly.
    const account = await deps.accountStore.createAccount(
      "user@example.com",
      "Test User",
    );
    await deps.oauthIdentityStore.create({
      account_id: account.id,
      provider: "github",
      provider_user_id: "gh-123",
      email: "user@example.com",
    });
    await deps.oauthIdentityStore.create({
      account_id: account.id,
      provider: "google",
      provider_user_id: "g-456",
      email: "user@example.com",
    });

    const { issueSession, signSessionJwt } = await import("../auth/session.js");
    const { record, jwt } = issueSession({
      account_id: account.id,
      ip: "127.0.0.1",
      user_agent: "test",
      now: new Date(),
    });
    await deps.sessionStore.insert(record);
    const cookie = signSessionJwt(jwt, deps.sessionSecret);

    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/whoami",
      cookies: { ts_session: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      signed_in: true,
      account_id: account.id,
      // Sorted alphabetically — pins render order in the wizard.
      identities: ["github", "google"],
    });
  });
});
