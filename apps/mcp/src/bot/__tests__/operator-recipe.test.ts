import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OperatorRecipeSchema,
  writeRecipe,
  readRecipe,
  listRecipes,
  renderOperatorRecipeHint,
  checkSuccessSignal,
  fillTemplate,
  recipeEntryUrl,
  operatorRecipeDir,
  type OperatorRecipe,
} from "../operator-recipe.js";

const RECIPE: OperatorRecipe = {
  name: "add-google-oauth",
  schema_version: 1,
  goal: "Create a Google OAuth web client and prove it issues a token",
  allowed_hosts: ["console.cloud.google.com", "developers.google.com"],
  trace: [
    { action: { kind: "goto", url_template: "https://console.cloud.google.com/auth/clients/create?project=${PROJECT}" } },
    { action: { kind: "click", text_match: "Web application" } },
    { action: { kind: "extract", slot: "oauth_secret" } },
    { action: { kind: "allow_host", host: "developers.google.com" } },
    { action: { kind: "type_secret", slot: "oauth_secret", text_match: "OAuth Client secret" } },
  ],
  secrets: [{ slot: "oauth_secret", sealed_from: "GCP client secret", stored: false }],
  postcondition: {
    kind: "execute_capability",
    describe: "Playground issues an access token after consent",
    success_signal: { field_text: "Access token", min_value_len: 40 },
  },
};

describe("operator-recipe IO round-trip", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "op-recipe-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
  });
  afterAll(async () => {
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes then reads back an identical recipe", async () => {
    const file = await writeRecipe(RECIPE);
    expect(file).toContain("add-google-oauth.json");
    expect(await readRecipe("add-google-oauth")).toEqual(RECIPE);
  });

  it("lists saved recipes by name", async () => {
    await writeRecipe(RECIPE);
    expect(await listRecipes()).toContain("add-google-oauth");
  });

  it("honors the env-overridden recipe dir", () => {
    expect(operatorRecipeDir()).toBe(dir);
  });
});

describe("iron invariant: a recipe never stores a secret VALUE", () => {
  it("schema rejects a secret marked stored:true", () => {
    const bad = { ...RECIPE, secrets: [{ slot: "oauth_secret", stored: true }] };
    expect(OperatorRecipeSchema.safeParse(bad).success).toBe(false);
  });

  it("schema rejects a value-bearing field on a secret (strict)", () => {
    const bad = { ...RECIPE, secrets: [{ slot: "oauth_secret", stored: false, value: "GOCSPX-leak" }] };
    expect(OperatorRecipeSchema.safeParse(bad).success).toBe(false);
  });

  it("a written recipe with a sealed secret carries no value on disk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "op-recipe-iron-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    const file = await writeRecipe(RECIPE);
    const raw = await fs.readFile(file, "utf8");
    expect(raw).toContain("oauth_secret"); // the slot ref is present
    expect(raw).toContain('"stored": false'); // marked unstored
    expect(raw).not.toMatch(/GOCSPX-/); // no Google client-secret value anywhere
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("renderOperatorRecipeHint (a MAP, not a script)", () => {
  const hint = renderOperatorRecipeHint(RECIPE);

  it("frames the recipe as a map with a fallback", () => {
    expect(hint).toContain("a MAP, not a script");
    expect(hint).toContain("fall back to your own judgment");
  });

  it("includes the goal and a numbered route from the trace", () => {
    expect(hint).toContain("goal: Create a Google OAuth");
    expect(hint).toMatch(/1\. go to https:\/\/console\.cloud\.google\.com/);
    expect(hint).toContain('click "Web application"');
  });

  it("tells the host to re-seal secrets, not read them from the recipe", () => {
    expect(hint).toContain("reveal + seal");
  });

  it("states the machine-checkable success condition", () => {
    expect(hint).toContain("success when: Playground issues an access token");
  });
});

describe("checkSuccessSignal (the anti-false-green gate)", () => {
  const tokenSnap = { url: "https://developers.google.com/oauthplayground/", text: "", fields: [{ label: "Access token:", value_len: 253 }] };

  it("field_text confirms only when a matching field is long enough", () => {
    expect(checkSuccessSignal({ field_text: "Access token", min_value_len: 40 }, tokenSnap).confirmed).toBe(true);
  });

  it("field_text fails when the value is too short", () => {
    const snap = { ...tokenSnap, fields: [{ label: "Access token:", value_len: 10 }] };
    const r = checkSuccessSignal({ field_text: "Access token", min_value_len: 40 }, snap);
    expect(r.confirmed).toBe(false);
    expect(r.reason).toContain("too short");
  });

  it("field_text fails when no field matches", () => {
    const snap = { ...tokenSnap, fields: [{ label: "Email", value_len: 99 }] };
    expect(checkSuccessSignal({ field_text: "Access token", min_value_len: 40 }, snap).confirmed).toBe(false);
  });

  it("evidence carries the LENGTH, never the value", () => {
    const r = checkSuccessSignal({ field_text: "Access token", min_value_len: 40 }, tokenSnap);
    expect(r.evidence).toEqual({ field: "Access token", value_len: 253, required: 40 });
  });

  it("text_present and url_contains both work", () => {
    const snap = { url: "https://app.example.com/dashboard", text: "Welcome back, you are signed in", fields: [] };
    expect(checkSuccessSignal({ text_present: "Welcome back" }, snap).confirmed).toBe(true);
    expect(checkSuccessSignal({ url_contains: "/dashboard" }, snap).confirmed).toBe(true);
    expect(checkSuccessSignal({ url_contains: "/login" }, snap).confirmed).toBe(false);
  });
});

describe("fillTemplate + recipeEntryUrl", () => {
  it("fills ${VAR} and reports any missing params", () => {
    expect(fillTemplate("a/${PROJECT}/b", { PROJECT: "x" })).toEqual({ url: "a/x/b", missing: [] });
    expect(fillTemplate("a/${PROJECT}", {}).missing).toEqual(["PROJECT"]);
  });

  it("recipeEntryUrl returns the first goto's url", () => {
    expect(recipeEntryUrl(RECIPE)).toContain("clients/create");
  });

  it("recipeEntryUrl is null when no goto exists", () => {
    expect(recipeEntryUrl({ ...RECIPE, trace: [{ action: { kind: "click", text_match: "x" } }] })).toBeNull();
  });
});
