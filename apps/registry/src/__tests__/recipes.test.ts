// Integration tests for the shared Operator Recipe registry endpoints
// (replay-registry-share). Each test boots buildServer() with in-memory
// stores and hits the routes via fastify.inject() — no real network, no DB.
//
// Coverage targets:
//   - POST /recipes writes a CANDIDATE (pending-review) and returns 201
//   - POST /recipes rejects a malformed recipe with 400
//   - POST /recipes rejects a recipe missing (verb, domain) with 400
//   - POST /recipes rejects a not-share-eligible recipe with 400
//     (server-side re-check — defense in depth against a bypassed client)
//   - A write that lands as a candidate is NOT resolvable via GET
//     (the core safety property: replay never reads an unpromoted candidate)
//   - GET /recipes/:verb/:domain returns 404 for a key nobody has ever written
//   - GET /recipes/:verb/:domain rejects an unknown verb with 400
//   - A PROMOTED recipe IS resolvable via GET
//   - POST /recipes upserts the candidate — republishing overwrites, not conflicts
//   - Cross-user reuse: a SECOND server instance backed by the SAME stores
//     resolves the promoted recipe the first instance's candidate became
//     (no local state shared between the two "installs")

import { beforeEach, describe, expect, it } from "vitest";
import type { OperatorRecipe } from "@trusty-squire/recipe-schema";
import { buildServer } from "../server.js";
import { RECIPE_SUBMIT_IP_HOURLY_LIMIT } from "../routes/recipes.js";
import { InMemoryOperatorRecipeStore } from "../recipe-store-memory.js";
import { InMemoryOperatorRecipeCandidateStore } from "../recipe-candidate-store-memory.js";

const ADMIN_BEARER = "test-admin-bearer-recipes-9f8e7d6c";

function validRecipe(overrides: Partial<OperatorRecipe> = {}): OperatorRecipe {
  const base: OperatorRecipe = {
    name: "get_api_key--example.com",
    schema_version: 1,
    goal: "Get an API key from Example",
    verb: "get_api_key",
    domain: "example.com",
    entry_url: "https://example.com/signup",
    allowed_hosts: [],
    trace: [
      { action: { kind: "goto", url_template: "https://example.com/signup" } },
      {
        action: {
          kind: "type",
          text_match: "Email",
          value: { hole: "contact.email" },
        },
      },
      { action: { kind: "click", text_match: "Continue" } },
      { action: { kind: "extract", slot: "api_key" } },
    ],
    secrets: [{ slot: "api_key", stored: false }],
    postcondition: {
      kind: "execute_capability",
      describe: "the dashboard shows an API key",
      success_signal: { text_present: "API Key" },
    },
  };
  return { ...base, ...overrides };
}

describe("POST /recipes (candidate) + GET /recipes/:verb/:domain (live only)", () => {
  let store: InMemoryOperatorRecipeStore;
  let candidateStore: InMemoryOperatorRecipeCandidateStore;
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    store = new InMemoryOperatorRecipeStore();
    candidateStore = new InMemoryOperatorRecipeCandidateStore();
    server = await buildServer({
      recipeStore: store,
      recipeCandidateStore: candidateStore,
      adminBearer: ADMIN_BEARER,
    });
  });

  async function promote(verb: string, domain: string): Promise<void> {
    const queue = await server.inject({
      method: "GET",
      url: "/admin/recipe-candidates",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    const item = queue
      .json()
      .items.find((i: { verb: string; domain: string }) => i.verb === verb && i.domain === domain);
    expect(item).toBeDefined();
    const res = await server.inject({
      method: "POST",
      url: `/admin/recipes/${verb}/${domain}/promote`,
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
      payload: { content_digest: item.content_digest },
    });
    expect(res.statusCode).toBe(200);
  }

  it("publishes an eligible recipe as a pending-review CANDIDATE and returns 201", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: validRecipe() },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      ok: true,
      key: "get_api_key--example.com",
      verb: "get_api_key",
      domain: "example.com",
      status: "pending-review",
    });
  });

  it("rejects a malformed recipe with 400", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: { not: "a recipe" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("schema_validation_failed");
  });

  it("rejects a recipe whose domain is not a plausible hostname with 400", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: validRecipe({ domain: "not-a-hostname" }) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_domain");
  });

  it("rate-limits candidate submissions per IP with 429, without affecting other IPs", async () => {
    for (let i = 0; i < RECIPE_SUBMIT_IP_HOURLY_LIMIT; i += 1) {
      const res = await server.inject({
        method: "POST",
        url: "/recipes",
        headers: { "fly-client-ip": "203.0.113.7" },
        payload: { recipe: validRecipe() },
      });
      expect(res.statusCode).toBe(201);
    }
    const throttled = await server.inject({
      method: "POST",
      url: "/recipes",
      headers: { "fly-client-ip": "203.0.113.7" },
      payload: { recipe: validRecipe() },
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json()).toMatchObject({ error: "rate_limited", scope: "ip" });

    const otherIp = await server.inject({
      method: "POST",
      url: "/recipes",
      headers: { "fly-client-ip": "198.51.100.9" },
      payload: { recipe: validRecipe() },
    });
    expect(otherIp.statusCode).toBe(201);
  });

  it("rejects a recipe missing (verb, domain) with 400", async () => {
    const recipe = validRecipe({ verb: undefined, domain: undefined });
    const res = await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_key");
  });

  it("rejects a not-share-eligible recipe server-side even if a client would have blocked it", async () => {
    const recipe = validRecipe({
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "type",
            text_match: "Full name",
            // A literal that should have been a hole — the server-side
            // re-check is the backstop a stale/buggy client can't bypass.
            value: "Jordan Rivera",
          },
        },
      ],
    });
    const res = await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("not_share_eligible");
    expect(body.reasons.some((r: string) => r.includes("name"))).toBe(true);
  });

  it("SAFETY: a write that lands as a candidate is NOT resolvable via GET until promoted", async () => {
    const publish = await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: validRecipe() },
    });
    expect(publish.statusCode).toBe(201);

    // The candidate exists (an admin can see it)...
    const queue = await server.inject({
      method: "GET",
      url: "/admin/recipe-candidates",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    expect(queue.json().items).toHaveLength(1);

    // ...but replay's read path (GET /recipes/:verb/:domain) sees nothing.
    const fetched = await server.inject({
      method: "GET",
      url: "/recipes/get_api_key/example.com",
    });
    expect(fetched.statusCode).toBe(404);
    expect(fetched.json().error).toBe("no_recipe_for_key");
  });

  it("returns 404 for a key that was never published", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/recipes/get_api_key/never-seen.example",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("no_recipe_for_key");
  });

  it("rejects an unknown verb with 400", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/recipes/not_a_real_verb/example.com",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_verb");
  });

  it("SAFETY: a PROMOTED recipe IS resolvable via GET", async () => {
    await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: validRecipe() },
    });
    await promote("get_api_key", "example.com");

    const res = await server.inject({
      method: "GET",
      url: "/recipes/get_api_key/example.com",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.recipe.domain).toBe("example.com");
    expect(body.recipe.verb).toBe("get_api_key");
    expect(body.recipe.goal).toBe("Get an API key from Example");
  });

  it("upserts the candidate on republish — same key, new content overwrites rather than conflicting", async () => {
    await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: validRecipe({ goal: "first version" }) },
    });
    const second = await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: validRecipe({ goal: "second version" }) },
    });
    expect(second.statusCode).toBe(201);
    await promote("get_api_key", "example.com");
    const res = await server.inject({
      method: "GET",
      url: "/recipes/get_api_key/example.com",
    });
    expect(res.json().recipe.goal).toBe("second version");
  });

  it("cross-user reuse: a second, independent server backed by the same stores resolves the promoted recipe", async () => {
    // Simulates User A's install publishing (via its server/client) and
    // User B's install — a wholly separate process with no local recipe —
    // fetching from the shared registry, once a promotion has happened.
    const publisher = await buildServer({
      recipeStore: store,
      recipeCandidateStore: candidateStore,
      adminBearer: ADMIN_BEARER,
    });
    const publish = await publisher.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: validRecipe() },
    });
    expect(publish.statusCode).toBe(201);
    await promote("get_api_key", "example.com");

    const reader = await buildServer({
      recipeStore: store,
      recipeCandidateStore: candidateStore,
      adminBearer: ADMIN_BEARER,
    });
    const fetched = await reader.inject({
      method: "GET",
      url: "/recipes/get_api_key/example.com",
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().recipe.name).toBe("get_api_key--example.com");
  });
});
