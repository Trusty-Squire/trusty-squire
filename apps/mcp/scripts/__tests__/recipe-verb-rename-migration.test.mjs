import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
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

function runtimeFileName(stem) {
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= 80) return `${slug}.json`;
  const digest = createHash("sha256").update(slug).digest("hex").slice(0, 16);
  return `${slug.slice(0, 63)}-${digest}.json`;
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
      "reserve--acme.com--signup.json",
      recipe({ verb: "reserve", domain: "acme.com", action_path: "signup" }),
    );
    await migrateRecipeVerbs({ dir, timestampBase: "t" });

    const migrated = await readJson(path.join(dir, "book--acme.com--signup.json"));
    expect(migrated.verb).toBe("book");
    expect(migrated.action_path).toBe("signup");
    expect(await exists(path.join(dir, "reserve--acme.com--signup.json"))).toBe(false);
  });

  it("recomputes canonical filenames for long-domain recipe keys", async () => {
    const domain = `${"a".repeat(76)}.com`;
    const legacyFile = runtimeFileName(`reserve--${domain}`);
    const canonicalFile = runtimeFileName(`book--${domain}`);
    await writeRecipe(
      dir,
      legacyFile,
      recipe({ name: "long-domain", verb: "reserve", domain }),
    );

    const summary = await migrateRecipeVerbs({ dir, timestampBase: "t" });

    expect(canonicalFile).not.toBe(legacyFile.replace(/^reserve/, "book"));
    expect(summary.renamed[0]).toMatchObject({ from: legacyFile, to: canonicalFile });
    expect(await readJson(path.join(dir, canonicalFile))).toMatchObject({
      name: "long-domain",
      verb: "book",
    });
    expect(await exists(path.join(dir, legacyFile))).toBe(false);
  });

  it("rewrites a legacy verb already stored at its canonical path", async () => {
    const canonicalFile = "book--acme.com.json";
    await writeRecipe(
      dir,
      canonicalFile,
      recipe({ name: "interrupted", verb: "reserve", domain: "acme.com" }),
    );

    const first = await migrateRecipeVerbs({ dir, timestampBase: "t" });
    const second = await migrateRecipeVerbs({ dir, timestampBase: "t" });

    expect(await readJson(path.join(dir, canonicalFile))).toMatchObject({
      name: "interrupted",
      verb: "book",
    });
    expect(first.renamed[0]).toMatchObject({ from: canonicalFile, to: canonicalFile });
    expect(second.renamed).toHaveLength(0);
    expect(second.superseded).toHaveLength(0);
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
    await writeRecipe(dir, "book--acme.com.json", recipe({ verb: "book", domain: "acme.com" }), NOW - 10_000);
    await writeRecipe(dir, "reserve--acme.com.json", recipe({ verb: "reserve", domain: "acme.com" }), NOW);

    const logs = [];
    const summary = await migrateRecipeVerbs({
      dir,
      timestampBase: "t",
      log: (l) => logs.push(l),
    });

    // reserve (newer) was rewritten to book and landed on the canonical path.
    const canonical = await readJson(path.join(dir, "book--acme.com.json"));
    expect(canonical.verb).toBe("book");

    // The older book file is preserved, not deleted.
    const supersededFile = (await fs.readdir(dir)).find((f) => f.endsWith(".superseded-t"));
    expect(supersededFile).toBeTruthy();
    expect((await readJson(path.join(dir, supersededFile))).verb).toBe("book");

    expect(summary.superseded).toHaveLength(1);
    expect(summary.superseded[0]).toMatchObject({
      domain: "acme.com",
      canonicalFile: "book--acme.com.json",
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
    await writeRecipe(dir, "book--acme.com.json", recipe({ verb: "book", domain: "acme.com" }), NOW);
    await writeRecipe(dir, "reserve--acme.com.json", recipe({ verb: "reserve", domain: "acme.com" }), NOW - 10_000);

    const summary = await migrateRecipeVerbs({ dir, timestampBase: "t" });

    // Existing book file stayed put and still wins.
    const canonical = await readJson(path.join(dir, "book--acme.com.json"));
    expect(canonical.verb).toBe("book");

    // The older reserve file is preserved as superseded with its original verb.
    const supersededFile = (await fs.readdir(dir)).find((f) => f.endsWith(".superseded-t"));
    expect(supersededFile).toBeTruthy();
    expect((await readJson(path.join(dir, supersededFile))).verb).toBe("reserve");

    expect(summary.superseded[0].winnerVerb).toBe("book");
  });

  it("collision: two legacy verbs onto the same canonical get unique superseded names", async () => {
    await writeRecipe(dir, "subscribe--acme.com.json", recipe({ verb: "subscribe", domain: "acme.com" }), NOW);
    await writeRecipe(dir, "renew--acme.com.json", recipe({ verb: "renew", domain: "acme.com" }), NOW - 20_000);
    await writeRecipe(dir, "upgrade--acme.com.json", recipe({ verb: "upgrade", domain: "acme.com" }), NOW - 10_000);

    const summary = await migrateRecipeVerbs({ dir, timestampBase: "t" });

    expect(summary.superseded).toHaveLength(2);
    const superseded = (await fs.readdir(dir)).filter((f) => f.includes(".superseded-"));
    expect(superseded).toHaveLength(2);
    expect(new Set(superseded).size).toBe(2); // unique names
  });

  it("plans same-target legacy collisions before writing and keeps the newest", async () => {
    await writeRecipe(
      dir,
      "renew--acme.com.json",
      recipe({ name: "older-renew", verb: "renew", domain: "acme.com" }),
      NOW - 10_000,
    );
    await writeRecipe(
      dir,
      "upgrade--acme.com.json",
      recipe({ name: "newer-upgrade", verb: "upgrade", domain: "acme.com" }),
      NOW,
    );

    const dryRun = await migrateRecipeVerbs({
      dir,
      dryRun: true,
      timestampBase: "t",
      log: () => {},
    });
    const live = await migrateRecipeVerbs({ dir, timestampBase: "t", log: () => {} });

    expect(dryRun).toEqual(live);
    expect((await readJson(path.join(dir, "subscribe--acme.com.json")))).toMatchObject({
      name: "newer-upgrade",
      verb: "subscribe",
    });
    expect(
      await readJson(path.join(dir, "subscribe--acme.com.json.superseded-t")),
    ).toMatchObject({ name: "older-renew", verb: "renew" });
    expect(live.log.filter((line) => line.startsWith("collision "))).toEqual([
      expect.stringMatching(/renew vs upgrade.*keeping upgrade/),
    ]);
  });

  it("orders cross-group legacy renames before publishing canonical targets", async () => {
    await writeRecipe(
      dir,
      "reserve--a.com.json",
      recipe({ name: "reserve-source", verb: "reserve", domain: "a.com" }),
      NOW,
    );
    await writeRecipe(
      dir,
      "book--a.com.json",
      recipe({ name: "upgrade-source", verb: "upgrade", domain: "a.com" }),
      NOW - 10_000,
    );

    const dryRun = await migrateRecipeVerbs({
      dir,
      dryRun: true,
      timestampBase: "t",
      log: () => {},
    });
    const summary = await migrateRecipeVerbs({ dir, timestampBase: "t", log: () => {} });

    expect(await readJson(path.join(dir, "book--a.com.json"))).toMatchObject({
      name: "reserve-source",
      verb: "book",
    });
    expect(await readJson(path.join(dir, "subscribe--a.com.json"))).toMatchObject({
      name: "upgrade-source",
      verb: "subscribe",
    });
    expect(dryRun).toEqual(summary);
    expect(summary.renamed).toHaveLength(2);
    expect(summary.superseded).toHaveLength(0);
  });

  it("never overwrites an existing superseded archive", async () => {
    await writeRecipe(
      dir,
      "book--acme.com.json",
      recipe({ name: "canonical", verb: "book", domain: "acme.com" }),
      NOW,
    );
    await writeRecipe(
      dir,
      "reserve--acme.com.json",
      recipe({ name: "legacy", verb: "reserve", domain: "acme.com" }),
      NOW - 10_000,
    );
    await writeRecipe(
      dir,
      "book--acme.com.json.superseded-t",
      recipe({ name: "prior-archive", verb: "reserve", domain: "acme.com" }),
    );

    const summary = await migrateRecipeVerbs({ dir, timestampBase: "t", log: () => {} });

    expect(await readJson(path.join(dir, "book--acme.com.json.superseded-t"))).toMatchObject({
      name: "prior-archive",
    });
    expect(await readJson(path.join(dir, "book--acme.com.json.superseded-t-2"))).toMatchObject({
      name: "legacy",
      verb: "reserve",
    });
    expect(summary.superseded[0].superseded).toBe("book--acme.com.json.superseded-t-2");
  });

  it("is idempotent — a second run is a no-op", async () => {
    await writeRecipe(dir, "reserve--acme.com.json", recipe({ verb: "reserve", domain: "acme.com" }));

    const first = await migrateRecipeVerbs({ dir, timestampBase: "t" });
    expect(first.renamed).toHaveLength(1);

    const before = (await fs.readdir(dir)).sort();
    const second = await migrateRecipeVerbs({ dir, timestampBase: "t" });
    const after = (await fs.readdir(dir)).sort();

    expect(second.renamed).toHaveLength(0);
    expect(second.superseded).toHaveLength(0);
    expect(before).toEqual(after);
    expect((await readJson(path.join(dir, "book--acme.com.json"))).verb).toBe("book");
  });

  it("dry-run write nothing", async () => {
    await writeRecipe(dir, "reserve--acme.com.json", recipe({ verb: "reserve", domain: "acme.com" }), NOW - 10_000);
    await writeRecipe(dir, "book--acme.com.json", recipe({ verb: "book", domain: "acme.com" }), NOW);

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
    expect(files).toEqual(["book--acme.com.json", "reserve--acme.com.json"].sort());
    expect((await readJson(path.join(dir, "reserve--acme.com.json"))).verb).toBe("reserve");
    expect((await readJson(path.join(dir, "book--acme.com.json"))).verb).toBe("book");
    expect(files.some((f) => f.includes(".superseded-"))).toBe(false);
  });

  it("is a no-op when the recipe dir does not exist", async () => {
    const missing = path.join(dir, "does-not-exist");
    const summary = await migrateRecipeVerbs({ dir: missing, timestampBase: "t" });
    expect(summary.renamed).toHaveLength(0);
  });
});
