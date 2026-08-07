// Admin routes for the promotion half of shared Operator Recipes
// (replay-registry-share). Mirrors admin.test.ts's coverage shape for the
// Skill verifier worker's admin surface.
//
// Coverage:
//   - 503 when REGISTRY_ADMIN_BEARER is unset (admin not configured)
//   - 401 when the bearer is wrong or missing
//   - GET /admin/recipe-candidates lists pending candidates, oldest first,
//     each with a sha256 content_digest
//   - POST /admin/recipes/:verb/:domain/promote moves a candidate live and
//     removes it from the candidate queue
//   - promote requires the reviewed content_digest (400 without it) and
//     refuses with 409 not_current when the candidate was overwritten after
//     review — the reviewed bytes, not the slot, are what get promoted
//   - promote re-checks share-eligibility and refuses an ineligible candidate
//   - 404 promoting/rejecting an unknown (verb, domain) key
//   - POST /admin/recipes/:verb/:domain/reject discards a candidate without
//     promoting it

import { beforeEach, describe, expect, it } from "vitest";
import type { OperatorRecipe } from "@trusty-squire/recipe-schema";
import { buildServer } from "../server.js";
import { InMemoryOperatorRecipeStore } from "../recipe-store-memory.js";
import { InMemoryOperatorRecipeCandidateStore } from "../recipe-candidate-store-memory.js";

const ADMIN_BEARER = "test-admin-bearer-recipes-promote-1a2b3c";

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

describe("admin recipe-promotion routes", () => {
  let store: InMemoryOperatorRecipeStore;
  let candidateStore: InMemoryOperatorRecipeCandidateStore;

  beforeEach(() => {
    store = new InMemoryOperatorRecipeStore();
    candidateStore = new InMemoryOperatorRecipeCandidateStore();
  });

  async function queuedDigest(
    server: Awaited<ReturnType<typeof buildServer>>,
    verb: string,
    domain: string,
  ): Promise<string> {
    const queue = await server.inject({
      method: "GET",
      url: "/admin/recipe-candidates",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    const item = queue
      .json()
      .items.find((i: { verb: string; domain: string }) => i.verb === verb && i.domain === domain);
    expect(item).toBeDefined();
    expect(item.content_digest).toMatch(/^[0-9a-f]{64}$/);
    return item.content_digest;
  }

  it("returns 503 when the admin bearer is not configured", async () => {
    const server = await buildServer({ recipeStore: store, recipeCandidateStore: candidateStore });
    const res = await server.inject({ method: "GET", url: "/admin/recipe-candidates" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("admin_not_configured");
  });

  it("returns 401 for a missing or wrong bearer", async () => {
    const server = await buildServer({
      recipeStore: store,
      recipeCandidateStore: candidateStore,
      adminBearer: ADMIN_BEARER,
    });
    const noAuth = await server.inject({ method: "GET", url: "/admin/recipe-candidates" });
    expect(noAuth.statusCode).toBe(401);

    const wrongAuth = await server.inject({
      method: "GET",
      url: "/admin/recipe-candidates",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrongAuth.statusCode).toBe(401);
  });

  it("lists pending candidates oldest-submitted-first", async () => {
    const server = await buildServer({
      recipeStore: store,
      recipeCandidateStore: candidateStore,
      adminBearer: ADMIN_BEARER,
    });
    await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: validRecipe({ domain: "first.example" }) },
    });
    await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: validRecipe({ domain: "second.example" }) },
    });

    const res = await server.inject({
      method: "GET",
      url: "/admin/recipe-candidates",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((i: { domain: string }) => i.domain)).toEqual([
      "first.example",
      "second.example",
    ]);
  });

  it("promotes a candidate live and removes it from the queue", async () => {
    const server = await buildServer({
      recipeStore: store,
      recipeCandidateStore: candidateStore,
      adminBearer: ADMIN_BEARER,
    });
    await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: validRecipe() },
    });

    const digest = await queuedDigest(server, "get_api_key", "example.com");
    const promote = await server.inject({
      method: "POST",
      url: "/admin/recipes/get_api_key/example.com/promote",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
      payload: { promoted_by: "housekeeper-test", content_digest: digest },
    });
    expect(promote.statusCode).toBe(200);
    const promoteBody = promote.json();
    expect(promoteBody.ok).toBe(true);
    expect(promoteBody.promoted_by).toBe("housekeeper-test");

    // No longer in the queue...
    const queue = await server.inject({
      method: "GET",
      url: "/admin/recipe-candidates",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    expect(queue.json().items).toHaveLength(0);

    // ...and now live.
    const live = await server.inject({ method: "GET", url: "/recipes/get_api_key/example.com" });
    expect(live.statusCode).toBe(200);
  });

  it("refuses to promote a candidate that fails eligibility at promotion time", async () => {
    const server = await buildServer({
      recipeStore: store,
      recipeCandidateStore: candidateStore,
      adminBearer: ADMIN_BEARER,
    });
    // Write directly to the candidate store to simulate a stale/laxer
    // client having written something that would fail today's gate.
    await candidateStore.upsert({
      verb: "get_api_key",
      domain: "example.com",
      recipe: validRecipe({
        trace: [
          { action: { kind: "goto", url_template: "https://example.com/signup" } },
          { action: { kind: "type", text_match: "Full name", value: "Jordan Rivera" } },
        ],
      }),
    });

    const digest = await queuedDigest(server, "get_api_key", "example.com");
    const promote = await server.inject({
      method: "POST",
      url: "/admin/recipes/get_api_key/example.com/promote",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
      payload: { content_digest: digest },
    });
    expect(promote.statusCode).toBe(400);
    expect(promote.json().error).toBe("not_share_eligible");

    // Still not live.
    const live = await server.inject({ method: "GET", url: "/recipes/get_api_key/example.com" });
    expect(live.statusCode).toBe(404);
  });

  it("refuses to promote without the reviewed content_digest", async () => {
    const server = await buildServer({
      recipeStore: store,
      recipeCandidateStore: candidateStore,
      adminBearer: ADMIN_BEARER,
    });
    await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: validRecipe() },
    });

    const promote = await server.inject({
      method: "POST",
      url: "/admin/recipes/get_api_key/example.com/promote",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
      payload: { promoted_by: "housekeeper-test" },
    });
    expect(promote.statusCode).toBe(400);
    expect(promote.json().error).toBe("missing_content_digest");

    const live = await server.inject({ method: "GET", url: "/recipes/get_api_key/example.com" });
    expect(live.statusCode).toBe(404);
  });

  it("SAFETY: 409s a promote whose candidate was overwritten after review, promoting nothing", async () => {
    const server = await buildServer({
      recipeStore: store,
      recipeCandidateStore: candidateStore,
      adminBearer: ADMIN_BEARER,
    });
    await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: validRecipe({ goal: "reviewed version" }) },
    });
    const reviewedDigest = await queuedDigest(server, "get_api_key", "example.com");

    // An unauthenticated writer swaps the slot's content between review
    // and promote.
    await server.inject({
      method: "POST",
      url: "/recipes",
      payload: {
        recipe: validRecipe({
          goal: "swapped after review",
          entry_url: "https://attacker.example/phish",
        }),
      },
    });

    const promote = await server.inject({
      method: "POST",
      url: "/admin/recipes/get_api_key/example.com/promote",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
      payload: { content_digest: reviewedDigest },
    });
    expect(promote.statusCode).toBe(409);
    expect(promote.json().error).toBe("not_current");

    // Nothing went live, and the (swapped) candidate is still queued for
    // a fresh review.
    const live = await server.inject({ method: "GET", url: "/recipes/get_api_key/example.com" });
    expect(live.statusCode).toBe(404);
    const queue = await server.inject({
      method: "GET",
      url: "/admin/recipe-candidates",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    expect(queue.json().items).toHaveLength(1);
  });

  it("returns 404 promoting or rejecting an unknown key", async () => {
    const server = await buildServer({
      recipeStore: store,
      recipeCandidateStore: candidateStore,
      adminBearer: ADMIN_BEARER,
    });
    const promote = await server.inject({
      method: "POST",
      url: "/admin/recipes/get_api_key/never-seen.example/promote",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    expect(promote.statusCode).toBe(404);

    const reject = await server.inject({
      method: "POST",
      url: "/admin/recipes/get_api_key/never-seen.example/reject",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    expect(reject.statusCode).toBe(404);
  });

  it("rejects a candidate without promoting it, leaving no live recipe", async () => {
    const server = await buildServer({
      recipeStore: store,
      recipeCandidateStore: candidateStore,
      adminBearer: ADMIN_BEARER,
    });
    await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: validRecipe() },
    });

    const reject = await server.inject({
      method: "POST",
      url: "/admin/recipes/get_api_key/example.com/reject",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    expect(reject.statusCode).toBe(200);

    const queue = await server.inject({
      method: "GET",
      url: "/admin/recipe-candidates",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    expect(queue.json().items).toHaveLength(0);

    const live = await server.inject({ method: "GET", url: "/recipes/get_api_key/example.com" });
    expect(live.statusCode).toBe(404);
  });
});
