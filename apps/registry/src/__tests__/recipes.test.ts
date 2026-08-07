// Integration tests for the shared Operator Recipe registry endpoints
// (replay-registry-share). Each test boots buildServer() with an
// in-memory OperatorRecipeStore and hits the routes via fastify.inject()
// — no real network, no DB.
//
// Coverage targets:
//   - POST /recipes publishes an eligible recipe and returns 201
//   - POST /recipes rejects a malformed recipe with 400
//   - POST /recipes rejects a recipe missing (verb, domain) with 400
//   - POST /recipes rejects a not-share-eligible recipe with 400
//     (server-side re-check — defense in depth against a bypassed client)
//   - GET /recipes/:verb/:domain returns the published recipe
//   - GET /recipes/:verb/:domain returns 404 when nothing exists
//   - GET /recipes/:verb/:domain rejects an unknown verb with 400
//   - POST /recipes upserts — republishing the same key overwrites, not conflicts
//   - Cross-user reuse: a SECOND server instance backed by the SAME store
//     resolves the recipe the first instance published (no local state
//     shared between the two "installs")

import { beforeEach, describe, expect, it } from "vitest";
import type { OperatorRecipe } from "@trusty-squire/recipe-schema";
import { buildServer } from "../server.js";
import { InMemoryOperatorRecipeStore } from "../recipe-store-memory.js";

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

describe("POST /recipes + GET /recipes/:verb/:domain", () => {
  let store: InMemoryOperatorRecipeStore;
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    store = new InMemoryOperatorRecipeStore();
    server = await buildServer({ recipeStore: store });
  });

  it("publishes an eligible recipe and returns 201", async () => {
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

  it("round-trips a published recipe through GET", async () => {
    await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: validRecipe() },
    });
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

  it("upserts on republish — same key, new content overwrites rather than conflicting", async () => {
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
    const res = await server.inject({
      method: "GET",
      url: "/recipes/get_api_key/example.com",
    });
    expect(res.json().recipe.goal).toBe("second version");
  });

  it("cross-user reuse: a second, independent server backed by the same store resolves what the first published", async () => {
    // Simulates User A's install publishing (via its server/client) and
    // User B's install — a wholly separate process with no local recipe —
    // fetching from the shared registry.
    const publisher = await buildServer({ recipeStore: store });
    const publish = await publisher.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: validRecipe() },
    });
    expect(publish.statusCode).toBe(201);

    const reader = await buildServer({ recipeStore: store });
    const fetched = await reader.inject({
      method: "GET",
      url: "/recipes/get_api_key/example.com",
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().recipe.name).toBe("get_api_key--example.com");
  });
});
