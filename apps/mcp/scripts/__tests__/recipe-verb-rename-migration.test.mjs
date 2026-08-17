import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateRecipeVerbs, CANONICAL_VERB } from "../recipe-verb-rename-migration.mjs";

// Small fixture renderer matching the runtime's recipe shape (name + verb +
// domain are all that matter for the migration; nothing else is touched).
function recipe(overrides = {}) {
  return {
    name: "fixture",
    schema_version: 1,
    ...overrides,
  };
}

async function writeRecipe(dir, file, content, mtimeMs) {
  const p = path.join(dir, file);
  await fs.writeFile(p, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  if (mtimeMs !== undefined) {
    await fs.utimes(p, new Date(mtimeMs), new Date(mtimeMs));
  }
  return p;
}

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function exists(p) {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

describe("recipe verb-rename migration", () => {
  let dir;
  const NOW = 1_700_000_000_000;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "recipe-migrate-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("inlines the canonical map as the two captain-named merges", () => {
    expect(CANONICAL_VERB).toEqual({
      reserve: "book",
      renew: "subscribe",
      upgrade: "subscribe",
      downgrade: "subscribe",
    });
  });

  it("renames each legacy-verb file to its canonical path and rewrites the verb", async () => {
    await writeRecipe(dir, "reserve--acme.com.json", recipe({ verb: "reserve", domain: "acme.com" }));
    await writeRecipe(dir, "renew--acme.com.json", recipe({ verb: "renew", domain: "acme.com" }));
    await writeRecipe(dir, "upgrade--foo.io.json", recipe({ verb: "upgrade", domain: "foo.io" }));
    await writeRecipe(dir, "downgrade--bar.net.json", recipe({ verb: "downgrade", domain: "bar.net" }));

    const summary = await migrateRecipeVerbs({ dir, timestampBase: "t" });

    expect(summary.renamed).toHaveLength(4);
    expect(summary.superseded).toHaveLength(0);

    const book = await readJson(path.join(dir, "book--acme.com.json"));
    expect(book.verb).toBe("book");
    expect(await exists(path.join(dir, "reserve--acme.com.json"))).toBe(false);

    const sub1 = await readJson(path.join(dir, "subscribe--acme.com.json"));
    expect(sub1.verb).toBe("subscribe");
    const sub2 = await readJson(path.join(dir, "subscribe--foo.io.json"));
    expect(sub2.verb).toBe("subscribe");
    const sub3 = await readJson(path.join(dir, "subscribe--bar.net.json"));
    expect(sub3.verb).toBe("subscribe");
  });

  it("preserves an existing action_path segment when renaming", async () => {
    await writeRecipe(
      dir,
      "reserve--acme--signup.json",
      recipe({ verb: "reserve", domain: "acme.com", action_path: "signup" }),
    );
    await migrateRecipeVerbs({ dir, timestampBase: "t" });

    const migrated = await readJson(path.join(dir, "book--acme--signup.json"));
    expect(migrated.verb).toBe("book");
    expect(migrated.action_path).toBe("signup");
    expect(await exists(path.join(dir, "reserve--acme--signup.json"))).toBe(false);
  });

  it("leaves non-merged verbs untouched", async () => {
    for (const [file, verb] of [
      ["purchase--acme.json", "purchase"],
      ["signup--acme.json", "signup"],
      ["book--acme.json", "book"],
      ["subscribe--acme.json", "subscribe"],
      ["get_api_key--acme.json", "get_api_key"],
    ]) {
      await writeRecipe(dir, file, recipe({ verb, domain: "acme.com" }));
    }

    const summary = await migrateRecipeVerbs({ dir, timestampBase: "t" });

    expect(summary.renamed).toHaveLength(0);
    const stillThere = [
      "purchase--acme.json",
      "signup--acme.json",
      "book--acme.json",
      "subscribe--acme.json",
      "get_api_key--acme.json",
    ];
    for (const f of stillThere) {
      expect(await exists(path.join(dir, f))).toBe(true);
      expect((await readJson(path.join(dir, f))).verb).not.toBeUndefined();
    }
  });

  it("collision: keeps the newer file at the canonical path and preserves the loser as superseded", async () => {
    // reserve is newer than the existing book file.
    await writeRecipe(dir, "book--acme.json", recipe({ verb: "book", domain: "acme.com" }), NOW - 10_000);
    await writeRecipe(dir, "reserve--acme.json", recipe({ verb: "reserve", domain: "acme.com" }), NOW);

    const logs = [];
    const summary = await migrateRecipeVerbs({
      dir,
      timestampBase: "t",
      log: (l) => logs.push(l),
    });

    // reserve (newer) was rewritten to book and landed on the canonical path.
    const canonical = await readJson(path.join(dir, "book--acme.json"));
    expect(canonical.verb).toBe("book");

    // The older book file is preserved, not deleted.
    const supersededFile = (await fs.readdir(dir)).find((f) => f.endsWith(".superseded-t"));
    expect(supersededFile).toBeTruthy();
    expect((await readJson(path.join(dir, supersededFile))).verb).toBe("book");

    expect(summary.superseded).toHaveLength(1);
    expect(summary.superseded[0]).toMatchObject({
      domain: "acme.com",
      canonicalFile: "book--acme.json",
      winnerVerb: "reserve",
    });

    // One collision log line naming domain, both verbs, and the winner.
    const collisionLine = logs.find((l) => l.startsWith("collision "));
    expect(collisionLine).toBeTruthy();
    expect(collisionLine).toContain("acme.com");
    expect(collisionLine).toContain("reserve");
    expect(collisionLine).toContain("book");
    expect(collisionLine).toContain("reserve");
  });

  it("collision: keeps pre-existing canonical file when it is newer", async () => {
    await writeRecipe(dir, "book--acme.json", recipe({ verb: "book", domain: "acme.com" }), NOW);
    await writeRecipe(dir, "reserve--acme.json", recipe({ verb: "reserve", domain: "acme.com" }), NOW - 10_000);

    const summary = await migrateRecipeVerbs({ dir, timestampBase: "t" });

    // Existing book file stayed put and still wins.
    const canonical = await readJson(path.join(dir, "book--acme.json"));
    expect(canonical.verb).toBe("book");

    // The older reserve file is preserved as superseded with its original verb.
    const supersededFile = (await fs.readdir(dir)).find((f) => f.endsWith(".superseded-t"));
    expect(supersededFile).toBeTruthy();
    expect((await readJson(path.join(dir, supersededFile))).verb).toBe("reserve");

    expect(summary.superseded[0].winnerVerb).toBe("book");
  });

  it("collision: two legacy verbs onto the same canonical get unique superseded names", async () => {
    await writeRecipe(dir, "subscribe--acme.json", recipe({ verb: "subscribe", domain: "acme.com" }), NOW);
    await writeRecipe(dir, "renew--acme.json", recipe({ verb: "renew", domain: "acme.com" }), NOW - 20_000);
    await writeRecipe(dir, "upgrade--acme.json", recipe({ verb: "upgrade", domain: "acme.com" }), NOW - 10_000);

    const summary = await migrateRecipeVerbs({ dir, timestampBase: "t" });

    expect(summary.superseded).toHaveLength(2);
    const superseded = (await fs.readdir(dir)).filter((f) => f.includes(".superseded-"));
    expect(superseded).toHaveLength(2);
    expect(new Set(superseded).size).toBe(2); // unique names
  });

  it("is idempotent — a second run is a no-op", async () => {
    await writeRecipe(dir, "reserve--acme.json", recipe({ verb: "reserve", domain: "acme.com" }));

    const first = await migrateRecipeVerbs({ dir, timestampBase: "t" });
    expect(first.renamed).toHaveLength(1);

    const before = (await fs.readdir(dir)).sort();
    const second = await migrateRecipeVerbs({ dir, timestampBase: "t" });
    const after = (await fs.readdir(dir)).sort();

    expect(second.renamed).toHaveLength(0);
    expect(second.superseded).toHaveLength(0);
    expect(before).toEqual(after);
    expect((await readJson(path.join(dir, "book--acme.json"))).verb).toBe("book");
  });

  it("dry-run write nothing", async () => {
    await writeRecipe(dir, "reserve--acme.json", recipe({ verb: "reserve", domain: "acme.com" }), NOW - 10_000);
    await writeRecipe(dir, "book--acme.json", recipe({ verb: "book", domain: "acme.com" }), NOW);

    const logs = [];
    const summary = await migrateRecipeVerbs({
      dir,
      dryRun: true,
      timestampBase: "t",
      log: (l) => logs.push(l),
    });

    // Reports the collision without touching disk.
    expect(summary.superseded).toHaveLength(1);
    expect(logs.some((l) => l.startsWith("collision "))).toBe(true);

    const files = (await fs.readdir(dir)).sort();
    expect(files).toEqual(["book--acme.json", "reserve--acme.json"].sort());
    expect((await readJson(path.join(dir, "reserve--acme.json"))).verb).toBe("reserve");
    expect((await readJson(path.join(dir, "book--acme.json"))).verb).toBe("book");
    expect(files.some((f) => f.includes(".superseded-"))).toBe(false);
  });

  it("is a no-op when the recipe dir does not exist", async () => {
    const missing = path.join(dir, "does-not-exist");
    const summary = await migrateRecipeVerbs({ dir: missing, timestampBase: "t" });
    expect(summary.renamed).toHaveLength(0);
  });
});
