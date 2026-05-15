// Alias ownership enforcement on /v1/inbox/*.
//
// An alias is stamped with the machine token that created it. A
// different machine token must not be able to long-poll or delete it —
// otherwise one Tier 0 user could read another's verification codes.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { buildInMemoryDeps } from "../services/deps.js";

const CUSTOMER_ID = "ts-test";

describe("/v1/inbox alias ownership", () => {
  let app: FastifyInstance;
  let savedAdminKey: string | undefined;

  beforeEach(async () => {
    savedAdminKey = process.env["UNIVERSAL_BOT_API_KEY"];
    process.env["UNIVERSAL_BOT_API_KEY"] = "inbox-admin-key";
    const deps = buildInMemoryDeps({
      sessionSecret: "test-secret-not-used",
      customerId: CUSTOMER_ID,
      // Fast poll so /wait timeouts return quickly.
      pollIntervalMs: 1,
    });
    app = await buildServer({ deps });
  });

  afterEach(async () => {
    await app.close();
    if (savedAdminKey === undefined) delete process.env["UNIVERSAL_BOT_API_KEY"];
    else process.env["UNIVERSAL_BOT_API_KEY"] = savedAdminKey;
  });

  async function issueMachineToken(): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/v1/install" });
    return (res.json() as { machine_token: string }).machine_token;
  }

  async function createAlias(token: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/inbox/aliases",
      headers: { "content-type": "application/json", "x-machine-token": token },
      payload: { service: "resend", run_id: "run-1" },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { alias: string }).alias;
  }

  it("lets the issuing token long-poll its own alias", async () => {
    const token = await issueMachineToken();
    const alias = await createAlias(token);
    const res = await app.inject({
      method: "GET",
      url: `/v1/inbox/aliases/${encodeURIComponent(alias)}/wait?timeout_seconds=1`,
      headers: { "x-machine-token": token },
    });
    // No email arrives → 408 timeout, but the ownership check PASSED
    // (a 403 would mean ownership rejected it).
    expect(res.statusCode).toBe(408);
  });

  it("denies a different machine token long-polling someone else's alias", async () => {
    const owner = await issueMachineToken();
    const intruder = await issueMachineToken();
    const alias = await createAlias(owner);

    const res = await app.inject({
      method: "GET",
      url: `/v1/inbox/aliases/${encodeURIComponent(alias)}/wait?timeout_seconds=1`,
      headers: { "x-machine-token": intruder },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "alias_not_owned" });
  });

  it("denies a different machine token deleting someone else's alias", async () => {
    const owner = await issueMachineToken();
    const intruder = await issueMachineToken();
    const alias = await createAlias(owner);

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/inbox/aliases/${encodeURIComponent(alias)}`,
      headers: { "x-machine-token": intruder },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "alias_not_owned" });
  });

  it("lets the issuing token delete its own alias", async () => {
    const token = await issueMachineToken();
    const alias = await createAlias(token);
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/inbox/aliases/${encodeURIComponent(alias)}`,
      headers: { "x-machine-token": token },
    });
    expect(res.statusCode).toBe(204);
  });

  it("lets an admin bearer bypass the ownership check", async () => {
    const owner = await issueMachineToken();
    const alias = await createAlias(owner);
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/inbox/aliases/${encodeURIComponent(alias)}`,
      headers: { authorization: "Bearer inbox-admin-key" },
    });
    expect(res.statusCode).toBe(204);
  });

  it("returns 404 when long-polling an alias that was never created", async () => {
    const token = await issueMachineToken();
    const res = await app.inject({
      method: "GET",
      url: `/v1/inbox/aliases/${encodeURIComponent("never-made@test.local")}/wait?timeout_seconds=1`,
      headers: { "x-machine-token": token },
    });
    expect(res.statusCode).toBe(404);
  });
});
