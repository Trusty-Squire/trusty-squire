import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveServiceRoutingFacts } from "../fix.js";

const OLD_FACTS_ENV = process.env.TRUSTY_SQUIRE_FIX_SERVICE_FACTS_YAML;

afterEach(() => {
  if (OLD_FACTS_ENV === undefined) delete process.env.TRUSTY_SQUIRE_FIX_SERVICE_FACTS_YAML;
  else process.env.TRUSTY_SQUIRE_FIX_SERVICE_FACTS_YAML = OLD_FACTS_ENV;
});

describe("resolveServiceRoutingFacts", () => {
  it("loads curated manual facts and DNS facts for services in the fix batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-fix-facts-"));
    const yamlPath = join(dir, "services.yaml");
    writeFileSync(
      yamlPath,
      [
        "services:",
        "  - slug: manual-svc",
        "    status: needs-manual",
        "    signup_url: https://localhost/signup",
        "  - slug: ignored-svc",
        "    status: needs-manual",
        "    signup_url: https://localhost/signup",
      ].join("\n"),
    );
    process.env.TRUSTY_SQUIRE_FIX_SERVICE_FACTS_YAML = yamlPath;

    const facts = await resolveServiceRoutingFacts(process.cwd(), ["manual-svc"]);

    expect(facts["manual-svc"]).toEqual({
      curatedNeedsManual: true,
      dnsAlive: true,
    });
    expect(facts["ignored-svc"]).toBeUndefined();
  });
});
