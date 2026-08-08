// Integration tests for the shared Operator Recipe registry endpoints
// (replay-serve-live-domainlock). Each test boots buildServer() with an
// in-memory store and hits the routes via fastify.inject() — no real
// network, no DB.
//
// Coverage targets:
//   - POST /recipes writes the recipe LIVE and returns 201
//   - a write is IMMEDIATELY resolvable via GET — no promotion step
//   - POST /recipes rejects a malformed recipe with 400
//   - POST /recipes rejects a recipe missing (verb, domain) with 400
//   - POST /recipes rejects a not-share-eligible recipe with 400
//     (server-side re-check — defense in depth against a bypassed client)
//   - POST /recipes rejects a DOMAIN-LOCK violation with 400, and never
//     stores it — entry_url, allowed_hosts, and goto/allow_host targets
//     outside the recipe's own eTLD+1 are all covered, including a
//     subdomain (allowed) vs. a different eTLD+1 vs. a look-alike domain
//   - GET /recipes/:verb/:domain returns 404 for a key nobody has ever
//     written
//   - GET /recipes/:verb/:domain rejects an unknown verb with 400
//   - POST /recipes upserts — republishing overwrites, not conflicts
//   - Cross-user reuse: a SECOND server instance backed by the SAME store
//     resolves the recipe the first instance wrote (no local state shared
//     between the two "installs")

import { beforeEach, describe, expect, it } from "vitest";
import {
  checkoutFieldSetSignature,
  checkoutShapeKey,
  type OperatorRecipe,
} from "@trusty-squire/recipe-schema";
import { buildServer } from "../server.js";
import { RECIPE_SUBMIT_IP_HOURLY_LIMIT } from "../routes/recipes.js";
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

describe("POST /recipes (serves live) + GET /recipes/:verb/:domain", () => {
  let store: InMemoryOperatorRecipeStore;
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    store = new InMemoryOperatorRecipeStore();
    server = await buildServer({ recipeStore: store });
  });

  it("writes a recipe LIVE and returns 201", async () => {
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
      status: "live",
    });
  });

  it("SAFETY: a write is immediately resolvable via GET — no promotion step", async () => {
    const publish = await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: validRecipe() },
    });
    expect(publish.statusCode).toBe(201);

    const fetched = await server.inject({
      method: "GET",
      url: "/recipes/get_api_key/example.com",
    });
    expect(fetched.statusCode).toBe(200);
    const body = fetched.json();
    expect(body.ok).toBe(true);
    expect(body.recipe.domain).toBe("example.com");
    expect(body.recipe.verb).toBe("get_api_key");
    expect(body.recipe.goal).toBe("Get an API key from Example");
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

  it("rate-limits submissions per IP with 429, without affecting other IPs", async () => {
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

    const live = await server.inject({ method: "GET", url: "/recipes/get_api_key/example.com" });
    expect(live.statusCode).toBe(404);
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

  it("cross-user reuse: a second, independent server backed by the same store resolves the recipe", async () => {
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

// replay-serve-live-domainlock — the hard domain-lock is now the primary
// safety control now that a write is live immediately. Every entry_url,
// allowed_hosts entry, and goto/allow_host target must resolve to the
// recipe's own eTLD+1.
describe("POST /recipes — hard domain-lock", () => {
  let store: InMemoryOperatorRecipeStore;
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    store = new InMemoryOperatorRecipeStore();
    server = await buildServer({ recipeStore: store });
  });

  async function expectRejected(recipe: OperatorRecipe): Promise<void> {
    const res = await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("domain_lock_violation");
    const live = await server.inject({
      method: "GET",
      url: `/recipes/${recipe.verb}/${recipe.domain}`,
    });
    expect(live.statusCode).toBe(404);
  }

  it("allows a subdomain of the recipe's own domain in entry_url and allowed_hosts", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/recipes",
      payload: {
        recipe: validRecipe({
          entry_url: "https://checkout.example.com/start",
          allowed_hosts: ["accounts.example.com"],
          trace: [
            { action: { kind: "goto", url_template: "https://sub.example.com/next" } },
            { action: { kind: "click", text_match: "Continue" } },
            { action: { kind: "extract", slot: "api_key" } },
          ],
        }),
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("SAFETY: rejects an entry_url on a different eTLD+1", async () => {
    await expectRejected(validRecipe({ entry_url: "https://attacker.net/signup" }));
  });

  it("SAFETY: rejects a look-alike domain in entry_url (example.com.attacker.net)", async () => {
    await expectRejected(validRecipe({ entry_url: "https://example.com.attacker.net/signup" }));
  });

  it("SAFETY: rejects an off-domain allowed_hosts entry", async () => {
    await expectRejected(validRecipe({ allowed_hosts: ["attacker.net"] }));
  });

  it("SAFETY: rejects an off-domain goto url_template in the trace", async () => {
    await expectRejected(
      validRecipe({
        trace: [
          { action: { kind: "goto", url_template: "https://example.com/signup" } },
          { action: { kind: "goto", url_template: "https://attacker.net/phish" } },
          { action: { kind: "extract", slot: "api_key" } },
        ],
      }),
    );
  });

  it("SAFETY: rejects an off-domain allow_host action in the trace", async () => {
    await expectRejected(
      validRecipe({
        trace: [
          { action: { kind: "goto", url_template: "https://example.com/signup" } },
          { action: { kind: "allow_host", host: "attacker.net" } },
          { action: { kind: "extract", slot: "api_key" } },
        ],
      }),
    );
  });
});

// replay-per-leg-signature — the checkout-leg key slot holds a
// `shape:<sha256 hex>` pseudo-domain (checkoutShapeKey in
// @trusty-squire/recipe-schema) instead of a real eTLD+1. Same routes, same
// store, serves live the same way — only the key's shape differs. Because
// it has no site domain, it may fill the current page but cannot navigate.
describe("POST /recipes + GET /recipes/:verb/:domain with a checkout-leg shape key", () => {
  let store: InMemoryOperatorRecipeStore;
  let server: Awaited<ReturnType<typeof buildServer>>;
  const shapeKey = checkoutShapeKey(checkoutFieldSetSignature(["email", "firstName", "lastName"])!);

  function checkoutLegRecipe(overrides: Partial<OperatorRecipe> = {}): OperatorRecipe {
    return {
      name: "checkout-leg--test-shape",
      schema_version: 1,
      goal: "Fill the checkout leg's fields",
      verb: "purchase",
      domain: shapeKey,
      allowed_hosts: [],
      trace: [
        {
          action: {
            kind: "type",
            target: { accessible_name: "Email" },
            value: { hole: "contact.email" },
          },
        },
      ],
      secrets: [],
      postcondition: {
        kind: "execute_capability",
        describe: "checkout leg fields filled and re-verified",
        success_signal: { field_text: "Email", min_value_len: 1 },
      },
      ...overrides,
    };
  }

  beforeEach(async () => {
    store = new InMemoryOperatorRecipeStore();
    server = await buildServer({ recipeStore: store });
  });

  it("accepts a shape: key as a plausible domain (not rejected as invalid_domain) and serves live", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: checkoutLegRecipe() },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ok: true, domain: shapeKey, status: "live" });
  });

  it("still rejects a malformed shape: key (not real hex) as an implausible domain", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: checkoutLegRecipe({ domain: "shape:not-actually-hex" }) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_domain");
  });

  it("rejects a shape-keyed recipe that declares an entry URL", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/recipes",
      payload: {
        recipe: checkoutLegRecipe({ entry_url: "https://attacker.net/checkout" }),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("domain_lock_violation");
    expect(res.json().violations).toEqual([
      {
        field: "entry_url",
        detail: "checkout-shape recipes cannot declare an entry point",
      },
    ]);
  });

  it("cross-domain reuse: a checkout-leg recipe published under a shape key resolves via GET with the URL-encoded key, independent of any real store domain", async () => {
    const publish = await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: checkoutLegRecipe() },
    });
    expect(publish.statusCode).toBe(201);

    // A "different store" resolving the SAME signature — the key alone
    // decides the hit, with no reference to which domain recorded it.
    const fetched = await server.inject({
      method: "GET",
      url: `/recipes/purchase/${encodeURIComponent(shapeKey)}`,
    });
    expect(fetched.statusCode).toBe(200);
    const body = fetched.json();
    expect(body.recipe.domain).toBe(shapeKey);
    expect(body.recipe.verb).toBe("purchase");
  });

  it("SAFETY: mutual discrimination — a DIFFERENT field-name set's shape key never resolves this recipe", async () => {
    await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe: checkoutLegRecipe() },
    });

    const otherShapeKey = checkoutShapeKey(
      checkoutFieldSetSignature(["billing_first_name", "billing_address_1", "billing_phone"])!,
    );
    const fetched = await server.inject({
      method: "GET",
      url: `/recipes/purchase/${encodeURIComponent(otherShapeKey)}`,
    });
    expect(fetched.statusCode).toBe(404);
  });

  it.each([
    ["goto", { action: { kind: "goto" as const, url_template: "https://store.example/next" } }],
    ["allow_host", { action: { kind: "allow_host" as const, host: "store.example" } }],
  ])("rejects a shape-keyed recipe containing a %s step", async (_kind, step) => {
    const recipe = checkoutLegRecipe({ trace: [step] });
    const res = await server.inject({
      method: "POST",
      url: "/recipes",
      payload: { recipe },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("domain_lock_violation");
    const fetched = await server.inject({
      method: "GET",
      url: `/recipes/purchase/${encodeURIComponent(shapeKey)}`,
    });
    expect(fetched.statusCode).toBe(404);
  });
});
