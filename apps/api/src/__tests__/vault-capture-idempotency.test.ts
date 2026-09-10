import { expect, it } from "vitest";
import { issueAgentSession } from "../auth/agent.js";
import { buildInMemoryDeps } from "../services/deps.js";
import { buildServer } from "../server.js";

it("binds capture writes to an authenticated account and refuses conflicting reuse", async () => {
  const deps = buildInMemoryDeps({ sessionSecret: "isolated-capture-test" });
  const server = await buildServer({ deps });
  const account = await deps.accountStore.createAccount("capture@example.test", "Capture");
  const { raw_token, record } = issueAgentSession({
    account_id: account.id,
    agent_identity: "test",
    agent_version: "test",
    now: new Date(),
  });
  await deps.agentSessionStore.insert(record);
  const secret = ["capture", "test", "value"].join("-");
  const request = {
    method: "POST" as const,
    url: "/v1/vault/credentials",
    headers: { authorization: `Bearer ${raw_token}` },
    payload: { service: "example", label: "fresh", value: secret, write_id: "capture-one" },
  };
  try {
    const first = await server.inject(request);
    const repeat = await server.inject(request);
    expect(first.statusCode).toBe(201);
    expect(repeat.statusCode).toBe(201);
    expect(repeat.json()).toEqual(first.json());
    expect(repeat.body).not.toContain(secret);
    const conflict = await server.inject({
      ...request,
      payload: { ...request.payload, service: "other" },
    });
    expect(conflict.statusCode).toBeGreaterThanOrEqual(400);
    const rejected = await server.inject({ ...request, headers: {} });
    expect(rejected.statusCode).toBe(401);
    const current = await deps.credentialStore.findActive(first.json().reference);
    expect(current?.retrieval_count).toBe(0);
    expect(current?.rotated_at).toBeNull();
  } finally {
    await server.close();
  }
});
