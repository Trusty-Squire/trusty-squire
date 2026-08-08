// End-to-end proof of replay-registry-share: a recipe recorded on one
// install is reused by a SECOND, wholly independent install (its own local
// recipe directory, no shared filesystem state) that visits the same
// (verb, eTLD+1) key — ONLY after the registry's candidate has been
// promoted to live. Drives the actual production orchestration functions
// (resolveRecipeForTask / publishRecipeToRegistry in tools/provision-drive.ts)
// against a mocked registry backend that mirrors the real two-tier wire
// contract apps/registry/src/routes/recipes.ts + routes/admin-recipes.ts
// serve (POST /recipes writes a candidate only; GET /recipes reads live
// only; promotion is a separate admin-bearer-gated step) — the same
// "inject a fetchFn, no network, no Fastify" strategy
// skill-registry-client.test.ts already uses for the parallel Skill flow,
// so this stays a client-side unit/integration test with no live browser
// and no real HTTP.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeRecipe,
  readRecipeForTask,
  checkoutFieldSetSignature,
  type OperatorRecipe,
} from "../bot/operator-recipe.js";
import {
  resolveRecipeForTask,
  resolveCheckoutLegRecipe,
  publishRecipeToRegistry,
} from "../tools/provision-drive.js";

function makeRecipe(overrides: Partial<OperatorRecipe> = {}): OperatorRecipe {
  return {
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
    ...overrides,
  };
}

interface StoredRecipeEntry {
  recipe: unknown;
  updated_at: string;
}

interface MockRegistryBackend {
  candidates: Map<string, StoredRecipeEntry>;
  live: Map<string, StoredRecipeEntry>;
  fetchFn: typeof globalThis.fetch;
  /** Simulates what the admin-bearer-gated promotion route does. */
  promote(verb: string, domain: string): void;
}

/**
 * Mirrors the exact two-tier wire contract of
 * apps/registry/src/routes/recipes.ts: POST /recipes writes ONLY the
 * candidate map; GET /recipes/:verb/:domain reads ONLY the live map. The
 * `promote` helper stands in for the real registry's admin-bearer-gated
 * `POST /admin/recipes/:verb/:domain/promote` — this mcp-level test isn't
 * exercising the admin route's own auth/eligibility logic (that's covered
 * registry-side in apps/registry/src/__tests__/admin-recipes.test.ts); it
 * only needs an accurate stand-in for "a promotion happened" so the
 * client-side resolution path can be proven against both pre- and
 * post-promotion state.
 */
function makeMockRegistryBackend(): MockRegistryBackend {
  const candidates = new Map<string, StoredRecipeEntry>();
  const live = new Map<string, StoredRecipeEntry>();

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (method === "POST" && url.endsWith("/recipes")) {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { recipe?: OperatorRecipe };
      const recipe = parsed.recipe;
      if (recipe?.verb === undefined || recipe.domain === undefined) {
        return json(400, { ok: false, error: "missing_key" });
      }
      const key = `${recipe.verb}--${recipe.domain.toLowerCase()}`;
      candidates.set(key, { recipe, updated_at: new Date(0).toISOString() });
      return json(201, {
        ok: true,
        key,
        verb: recipe.verb,
        domain: recipe.domain,
        status: "pending-review",
      });
    }

    const match = /\/recipes\/([^/]+)\/([^/?]+)/.exec(url);
    if (method === "GET" && match) {
      const [, verb, rawDomain] = match;
      const key = `${verb}--${decodeURIComponent(rawDomain!).toLowerCase()}`;
      const found = live.get(key); // LIVE only — a pending candidate is invisible here
      if (found === undefined) return json(404, { ok: false, error: "no_recipe_for_key" });
      return json(200, { ok: true, key, recipe: found.recipe, updated_at: found.updated_at });
    }

    return json(404, { ok: false, error: "not_found" });
  }) as typeof globalThis.fetch;

  return {
    candidates,
    live,
    fetchFn,
    promote(verb, domain) {
      const key = `${verb}--${domain.toLowerCase()}`;
      const candidate = candidates.get(key);
      if (candidate === undefined) throw new Error(`no candidate for ${key} to promote`);
      live.set(key, candidate);
      candidates.delete(key);
    },
  };
}

describe("cross-user recipe reuse via the shared registry (replay-registry-share)", () => {
  let backend: MockRegistryBackend;
  let dirA: string;
  let dirB: string;
  let originalFetch: typeof globalThis.fetch;
  const trackedEnvKeys = [
    "TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR",
    "TRUSTY_SQUIRE_ACCOUNT_ID",
    "TRUSTY_SQUIRE_REGISTRY_URL",
  ] as const;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    backend = makeMockRegistryBackend();
    dirA = mkdtempSync(join(tmpdir(), "ts-recipe-store-a-"));
    dirB = mkdtempSync(join(tmpdir(), "ts-recipe-store-b-"));
    originalFetch = globalThis.fetch;
    originalEnv = Object.fromEntries(trackedEnvKeys.map((k) => [k, process.env[k]]));
    globalThis.fetch = backend.fetchFn;
    process.env.TRUSTY_SQUIRE_ACCOUNT_ID = "test-account";
    process.env.TRUSTY_SQUIRE_REGISTRY_URL = "https://registry.test";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of trackedEnvKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it("SAFETY: install B cannot resolve install A's recipe while it's still just a candidate", async () => {
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirA;
    const recipe = makeRecipe();
    const file = await writeRecipe(recipe);
    const publishStatus = await publishRecipeToRegistry(file);
    expect(publishStatus.startsWith("submitted:")).toBe(true);
    expect(backend.candidates.size).toBe(1);
    expect(backend.live.size).toBe(0);

    // Install B: wholly independent, empty local store. No promotion has
    // happened yet, so this must cold-miss exactly like the key was never
    // written — the same "not resolvable by replay" property the registry
    // route test proves server-side.
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirB;
    await expect(
      resolveRecipeForTask("get_api_key", "https://example.com/signup"),
    ).rejects.toThrow();
  });

  it("a recipe recorded on install A is reused by install B once promoted, and install B has no local copy", async () => {
    // Install A records + submits.
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirA;
    const recipe = makeRecipe();
    const file = await writeRecipe(recipe);
    const publishStatus = await publishRecipeToRegistry(file);
    expect(publishStatus.startsWith("submitted:")).toBe(true);

    // A housekeeper (or operator) vets and promotes the candidate.
    backend.promote("get_api_key", "example.com");

    // Install B: a wholly independent, empty local store — proves the
    // registry, not the filesystem, is what's serving this recipe.
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirB;
    await expect(readRecipeForTask("get_api_key", "https://example.com/signup")).rejects.toThrow();

    const resolved = await resolveRecipeForTask("get_api_key", "https://example.com/signup");
    expect(resolved.goal).toBe(recipe.goal);
    expect(resolved.domain).toBe("example.com");
    expect(resolved.verb).toBe("get_api_key");
  });

  it("a not-share-eligible recipe is never submitted, and install B still cold-misses", async () => {
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirA;
    const recipe = makeRecipe({
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "type",
            text_match: "Full name",
            // A literal that should have been a hole — must never reach the
            // shared registry (isRecipeShareEligible's job), not even as a
            // candidate.
            value: "Jordan Rivera",
          },
        },
      ],
    });
    const file = await writeRecipe(recipe);
    const publishStatus = await publishRecipeToRegistry(file);
    expect(publishStatus.startsWith("not_shared:")).toBe(true);
    expect(backend.candidates.size).toBe(0);
    expect(backend.live.size).toBe(0);

    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirB;
    await expect(
      resolveRecipeForTask("get_api_key", "https://example.com/signup"),
    ).rejects.toThrow();
  });

  it("an unreachable registry degrades to the local-miss error rather than blocking the flow", async () => {
    globalThis.fetch = (async () => {
      throw new Error("simulated network outage");
    }) as typeof globalThis.fetch;
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirB; // empty — no local recipe either
    await expect(
      resolveRecipeForTask("get_api_key", "https://example.com/signup"),
    ).rejects.toThrow();
  }, 10_000);

  it("existing single-user behavior is unchanged: a local hit never calls the registry", async () => {
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirA;
    const recipe = makeRecipe();
    await writeRecipe(recipe);

    let registryWasCalled = false;
    const baseFetch = backend.fetchFn;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      registryWasCalled = true;
      return baseFetch(...args);
    }) as typeof globalThis.fetch;

    const resolved = await resolveRecipeForTask("get_api_key", "https://example.com/signup");
    expect(resolved.goal).toBe(recipe.goal);
    expect(registryWasCalled).toBe(false);
  });
});

// replay-per-leg-signature — the checkout leg's own independent resolution
// path (resolveCheckoutLegRecipe), keyed by field-name-set signature
// instead of domain. Same mock registry backend/two-tier candidate+promote
// contract as above; only the key shape differs (shape:<hash> instead of a
// real eTLD+1), which the backend's generic verb/domain URL matching
// already handles unchanged.
describe("cross-domain checkout-leg reuse via the shared registry (replay-per-leg-signature)", () => {
  let backend: MockRegistryBackend;
  let dirA: string;
  let dirB: string;
  let originalFetch: typeof globalThis.fetch;
  const trackedEnvKeys = [
    "TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR",
    "TRUSTY_SQUIRE_ACCOUNT_ID",
    "TRUSTY_SQUIRE_REGISTRY_URL",
  ] as const;
  let originalEnv: Record<string, string | undefined>;

  // Field-name sets standing in for two UNRELATED stores that share a
  // checkout implementation (Shopify's proven byte-identical field set) —
  // same set, different store. And a third, structurally different set
  // (WooCommerce-shaped) that must never cross-fire against it.
  const SHARED_CHECKOUT_FIELDS = [
    "firstName",
    "lastName",
    "email",
    "address1",
    "city",
    "postalCode",
    "serialized-shop",
    "serialized-graphql",
  ];
  const UNRELATED_CHECKOUT_FIELDS = ["billing_first_name", "billing_address_1", "billing_phone"];

  function makeCheckoutLegRecipe(signature: string): OperatorRecipe {
    return {
      name: "checkout-leg--test",
      schema_version: 1,
      goal: "Fill the checkout leg's fields",
      verb: "purchase",
      domain: `shape:${signature}`,
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
    };
  }

  beforeEach(() => {
    backend = makeMockRegistryBackend();
    dirA = mkdtempSync(join(tmpdir(), "ts-checkout-leg-a-"));
    dirB = mkdtempSync(join(tmpdir(), "ts-checkout-leg-b-"));
    originalFetch = globalThis.fetch;
    originalEnv = Object.fromEntries(trackedEnvKeys.map((k) => [k, process.env[k]]));
    globalThis.fetch = backend.fetchFn;
    process.env.TRUSTY_SQUIRE_ACCOUNT_ID = "test-account";
    process.env.TRUSTY_SQUIRE_REGISTRY_URL = "https://registry.test";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of trackedEnvKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it("a checkout-leg recipe recorded on store A resolves on a wholly different store B that computes the SAME field-name-set signature", async () => {
    const signature = checkoutFieldSetSignature(SHARED_CHECKOUT_FIELDS)!;

    // Store A records + submits its checkout-leg recipe.
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirA;
    const recipe = makeCheckoutLegRecipe(signature);
    const file = await writeRecipe(recipe);
    const publishStatus = await publishRecipeToRegistry(file);
    expect(publishStatus.startsWith("submitted:")).toBe(true);
    backend.promote("purchase", `shape:${signature}`);

    // Store B: a wholly independent local store, never wrote this recipe —
    // it computes the SAME signature (its checkout happens to share the
    // identical field-name set) and resolves the SAME recipe.
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirB;
    const signatureOnB = checkoutFieldSetSignature([...SHARED_CHECKOUT_FIELDS].reverse())!;
    expect(signatureOnB).toBe(signature); // same set, different order — same signature
    const resolved = await resolveCheckoutLegRecipe("purchase", signatureOnB);
    expect(resolved).not.toBeNull();
    expect(resolved?.domain).toBe(`shape:${signature}`);
  });

  it("SAFETY: mutual discrimination — a structurally different store's signature never resolves the other store's checkout-leg recipe", async () => {
    const signature = checkoutFieldSetSignature(SHARED_CHECKOUT_FIELDS)!;
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirA;
    const file = await writeRecipe(makeCheckoutLegRecipe(signature));
    await publishRecipeToRegistry(file);
    backend.promote("purchase", `shape:${signature}`);

    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirB;
    const unrelatedSignature = checkoutFieldSetSignature(UNRELATED_CHECKOUT_FIELDS)!;
    const resolved = await resolveCheckoutLegRecipe("purchase", unrelatedSignature);
    expect(resolved).toBeNull();
  });

  it("SAFETY: a checkout-leg candidate is not resolvable until promoted", async () => {
    const signature = checkoutFieldSetSignature(SHARED_CHECKOUT_FIELDS)!;
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirA;
    const file = await writeRecipe(makeCheckoutLegRecipe(signature));
    await publishRecipeToRegistry(file);
    // No promotion.
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirB;
    const resolved = await resolveCheckoutLegRecipe("purchase", signature);
    expect(resolved).toBeNull();
  });

  it("returns null (never throws) on a total miss, so the caller degrades to cold driving", async () => {
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirB;
    const resolved = await resolveCheckoutLegRecipe("purchase", "0".repeat(64));
    expect(resolved).toBeNull();
  });
});
