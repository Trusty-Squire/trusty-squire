// End-to-end proof of replay-registry-share: a recipe recorded on one
// install is reused by a SECOND, wholly independent install (its own local
// recipe directory, no shared filesystem state) that visits the same
// (verb, eTLD+1) key. Drives the actual production orchestration functions
// (resolveRecipeForTask / publishRecipeToRegistry in tools/provision-drive.ts)
// against a mocked registry backend that mirrors the real wire contract
// apps/registry/src/routes/recipes.ts serves — the same "inject a fetchFn,
// no network, no Fastify" strategy skill-registry-client.test.ts already
// uses for the parallel Skill flow, so this stays a client-side unit/
// integration test with no live browser and no real HTTP.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRecipe, readRecipeForTask, type OperatorRecipe } from "../bot/operator-recipe.js";
import { resolveRecipeForTask, publishRecipeToRegistry } from "../tools/provision-drive.js";

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

/** Mirrors the exact wire contract of apps/registry/src/routes/recipes.ts. */
function makeMockRegistryFetch(store: Map<string, StoredRecipeEntry>): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (method === "POST" && url.endsWith("/recipes")) {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { recipe?: OperatorRecipe };
      const recipe = parsed.recipe;
      if (recipe?.verb === undefined || recipe.domain === undefined) {
        return json(400, { ok: false, error: "missing_key" });
      }
      const key = `${recipe.verb}--${recipe.domain.toLowerCase()}`;
      store.set(key, { recipe, updated_at: new Date(0).toISOString() });
      return json(201, { ok: true, key, verb: recipe.verb, domain: recipe.domain });
    }

    const match = /\/recipes\/([^/]+)\/([^/?]+)/.exec(url);
    if (method === "GET" && match) {
      const [, verb, rawDomain] = match;
      const key = `${verb}--${decodeURIComponent(rawDomain!).toLowerCase()}`;
      const found = store.get(key);
      if (found === undefined) return json(404, { ok: false, error: "no_recipe_for_key" });
      return json(200, { ok: true, key, recipe: found.recipe, updated_at: found.updated_at });
    }

    return json(404, { ok: false, error: "not_found" });
  }) as typeof globalThis.fetch;
}

describe("cross-user recipe reuse via the shared registry (replay-registry-share)", () => {
  let registryStore: Map<string, StoredRecipeEntry>;
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
    registryStore = new Map();
    dirA = mkdtempSync(join(tmpdir(), "ts-recipe-store-a-"));
    dirB = mkdtempSync(join(tmpdir(), "ts-recipe-store-b-"));
    originalFetch = globalThis.fetch;
    originalEnv = Object.fromEntries(trackedEnvKeys.map((k) => [k, process.env[k]]));
    globalThis.fetch = makeMockRegistryFetch(registryStore);
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

  it("a recipe recorded on install A is reused by install B, which has no local copy", async () => {
    // Install A records + publishes.
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirA;
    const recipe = makeRecipe();
    const file = await writeRecipe(recipe);
    const publishStatus = await publishRecipeToRegistry(file);
    expect(publishStatus.startsWith("published:")).toBe(true);

    // Install B: a wholly independent, empty local store — proves the
    // registry, not the filesystem, is what's serving this recipe.
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
    expect(registryStore.size).toBe(0);

    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirB;
    await expect(resolveRecipeForTask("get_api_key", "https://example.com/signup")).rejects.toThrow();
  });

  it("an unreachable registry degrades to the local-miss error rather than blocking the flow", async () => {
    globalThis.fetch = (async () => {
      throw new Error("simulated network outage");
    }) as typeof globalThis.fetch;
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirB; // empty — no local recipe either
    await expect(resolveRecipeForTask("get_api_key", "https://example.com/signup")).rejects.toThrow();
  }, 10_000);

  it("existing single-user behavior is unchanged: a local hit never calls the registry", async () => {
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dirA;
    const recipe = makeRecipe();
    await writeRecipe(recipe);

    let registryWasCalled = false;
    const baseFetch = makeMockRegistryFetch(registryStore);
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      registryWasCalled = true;
      return baseFetch(...args);
    }) as typeof globalThis.fetch;

    const resolved = await resolveRecipeForTask("get_api_key", "https://example.com/signup");
    expect(resolved.goal).toBe(recipe.goal);
    expect(registryWasCalled).toBe(false);
  });
});
