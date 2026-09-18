// The retired admin-bearer bypass used to accept Authorization: Bearer
// <UNIVERSAL_BOT_API_KEY> on /v1/inbox/*. Inbox routes now accept
// machine tokens only; a leftover Fly secret must not reopen that path.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { buildInMemoryDeps } from "../services/deps.js";

describe("POST /v1/inbox/poll-operator-otp — admin bearer retired", () => {
  let app: FastifyInstance;
  let savedKey: string | undefined;

  beforeEach(async () => {
    savedKey = process.env.UNIVERSAL_BOT_API_KEY;
    process.env.UNIVERSAL_BOT_API_KEY = "leftover-admin-secret";
    const deps = buildInMemoryDeps({
      sessionSecret: "test-secret-not-used",
    });
    app = await buildServer({ deps });
  });

  afterEach(async () => {
    await app.close();
    if (savedKey === undefined) delete process.env.UNIVERSAL_BOT_API_KEY;
    else process.env.UNIVERSAL_BOT_API_KEY = savedKey;
  });

  it("rejects Authorization: Bearer without a machine token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/inbox/poll-operator-otp",
      headers: {
        authorization: "Bearer leftover-admin-secret",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ since_seconds: 60 }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "missing_machine_token" });
  });
});
