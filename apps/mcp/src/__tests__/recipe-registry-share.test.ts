// End-to-end proof of replay-serve-live-domainlock: a recipe recorded on
// one install is reused by a SECOND, wholly independent install (its own
// local recipe directory, no shared filesystem state) that visits the same
// (verb, eTLD+1) key — the instant it's written, with no promotion step.
// Drives the actual production orchestration functions
// (resolveRecipeForTask / publishRecipeToRegistry in tools/provision-drive.ts)
// against a mocked registry backend that mirrors the real wire contract
// apps/registry/src/routes/recipes.ts serves (POST /recipes writes and
// serves live in one step; GET /recipes reads that same store) — the same
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
  live: Map<string, StoredRecipeEntry>;
  fetchFn: typeof globalThis.fetch;
}

/**
 * Mirrors the real registry's replay-serve-live-domainlock wire contract:
 * POST /recipes writes directly into the one store GET /recipes reads —
 * no candidate tier, no separate promotion call.
 */
function makeMockRegistryBackend(): MockRegistryBackend {
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
      live.set(key, { recipe, updated_at: new Date(0).toISOString() });
      return json(201, {
        ok: true,
        key,
        verb: recipe.verb,
        domain: recipe.domain,
        status: "live",
      });
    }

    const match = /\/recipes\/([^/]+)\/([^/?]+)/.exec(url);
    if (method === "GET" && match) {
      const [, verb, rawDomain] = match;
      const key = `${verb}--${decodeURIComponent(rawDomain!).toLowerCase()}`;
      const found = live.get(key);
      if (found === undefined) return json(404, { ok: false, error: "no_recipe_for_key" });
      return json(200, { ok: true, key, recipe: found.recipe, updated_at: found.updated_at });
    }

    return json(404, { ok: false, error: "not_found" });
  }) as typeof globalThis.fetch;

  return { live, fetchFn };
}

describe("cross-user recipe reuse via the shared registry (replay-serve-live-domainlock)", () => {
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

  it("SAFETY: a recipe recorded on install A is resolvable by install B IMMEDIATELY — no promotion step", async () => {
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirA;
    const recipe = makeRecipe();
    const file = await writeRecipe(recipe);
    const publishStatus = await publishRecipeToRegistry(file);
    expect(publishStatus.startsWith("published:")).toBe(true);
    expect(backend.live.size).toBe(1);

    // Install B: wholly independent, empty local store — proves the
    // registry, not the filesystem, is what's serving this recipe, and
    // that it's live the instant A published it.
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirB;
    await expect(readRecipeForTask("get_api_key", "https://example.com/signup")).rejects.toThrow();

    const resolved = await resolveRecipeForTask("get_api_key", "https://example.com/signup");
    expect(resolved.goal).toBe(recipe.goal);
    expect(resolved.domain).toBe("example.com");
    expect(resolved.verb).toBe("get_api_key");
  });

  it("a not-share-eligible recipe is never published, and install B still cold-misses", async () => {
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirA;
    const recipe = makeRecipe({
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "type",
            text_match: "Full name",
            // A literal that should have been a hole — must never reach the
            // shared registry (isRecipeShareEligible's job).
            value: "Jordan Rivera",
          },
        },
      ],
    });
    const file = await writeRecipe(recipe);
    const publishStatus = await publishRecipeToRegistry(file);
    expect(publishStatus.startsWith("not_shared:")).toBe(true);
    expect(backend.live.size).toBe(0);

    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirB;
    await expect(
      resolveRecipeForTask("get_api_key", "https://example.com/signup"),
    ).rejects.toThrow();
  });

  it("SAFETY: a recipe whose entry_url leaves its own domain is never published", async () => {
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirA;
    const recipe = makeRecipe({ entry_url: "https://attacker.net/signup" });
    const file = await writeRecipe(recipe);
    const publishStatus = await publishRecipeToRegistry(file);
    expect(publishStatus.startsWith("not_shared:")).toBe(true);
    expect(backend.live.size).toBe(0);
  });

  it("SAFETY: a recipe whose allowed_hosts declares an off-domain host is never published", async () => {
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirA;
    const recipe = makeRecipe({ allowed_hosts: ["attacker.net"] });
    const file = await writeRecipe(recipe);
    const publishStatus = await publishRecipeToRegistry(file);
    expect(publishStatus.startsWith("not_shared:")).toBe(true);
    expect(backend.live.size).toBe(0);
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
// instead of domain. Same mock registry backend/serve-live contract as
// above; only the key shape differs (shape:<hash> instead of a real
// eTLD+1), which the backend's generic verb/domain URL matching already
// handles unchanged.
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

  it("a checkout-leg recipe recorded on store A resolves immediately on a wholly different store B that computes the SAME field-name-set signature", async () => {
    const signature = checkoutFieldSetSignature(SHARED_CHECKOUT_FIELDS)!;

    // Store A records + publishes its checkout-leg recipe.
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirA;
    const recipe = makeCheckoutLegRecipe(signature);
    const file = await writeRecipe(recipe);
    const publishStatus = await publishRecipeToRegistry(file);
    expect(publishStatus.startsWith("published:")).toBe(true);

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

    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirB;
    const unrelatedSignature = checkoutFieldSetSignature(UNRELATED_CHECKOUT_FIELDS)!;
    const resolved = await resolveCheckoutLegRecipe("purchase", unrelatedSignature);
    expect(resolved).toBeNull();
  });

  it("returns null (never throws) on a total miss, so the caller degrades to cold driving", async () => {
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirB;
    const resolved = await resolveCheckoutLegRecipe("purchase", "0".repeat(64));
    expect(resolved).toBeNull();
  });
});
