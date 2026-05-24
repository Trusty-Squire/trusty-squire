// Live validation of rc.25's fill-label disambiguator against a real
// Playwright + Chromium DOM, with no external service or OAuth gate.
//
// Why this exists: the rc.25 disambiguator has unit-test coverage of
// preValidate AND executeStep (the parity bug caught by CI between
// rc.24 and rc.25). What it didn't have was a live integration run
// against real Playwright. The natural targets — Railway, OpenRouter
// — have their own auth gates (GitHub OAuth, Google challenge) that
// block the bot from reaching the replay path even when the
// disambiguator code is sound. This script bypasses those gates by
// serving a local HTML fixture that reproduces the OpenRouter
// "Name matched 2 inputs" scenario exactly:
//
//   - input A: labelled "Name", value already filled, in viewport
//   - input B: labelled "Name", value empty, in viewport
//
// Then it constructs a single-step Skill (fill label_hint="Name"),
// invokes replaySkill in full mode against a real Chromium, and
// inspects the page after to assert that #new got the typed value
// while #existing was left untouched. That proves both code paths
// of the disambiguator (preValidate cascade + executeStep parity)
// against a real DOM.
//
// Run with:
//   tsx tools/disambiguator-live-test/run.ts
//
// Exit code 0 on pass, 1 on fail.

import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Skill } from "@trusty-squire/adapter-sdk";
// Import from BUILT dist/, not src/. tsx wraps source-imported TS in
// a helper-injecting transformer; that's fine for top-level code but
// breaks when the same module's functions get serialized into
// page.evaluate() — the helpers reference symbols that don't exist
// in the browser context, surfacing as `__name is not defined`.
// dist/*.js is pre-transformed JS, no tsx wrap, evaluates cleanly.
import { BrowserController } from "../../apps/mcp/dist/bot/browser.js";
import { replaySkill } from "../../apps/mcp/dist/bot/replay-skill.js";

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head><title>rc.25 disambiguator fixture</title></head>
<body style="font-family:sans-serif;padding:20px;">
  <h2>Existing API keys</h2>
  <div>
    <label for="existing">Name</label>
    <input id="existing" type="text" value="existing-key-name" />
  </div>

  <h2>Create a new key</h2>
  <form id="new-key-form">
    <label for="new">Name</label>
    <input id="new" type="text" value="" />
    <button type="submit">Create</button>
  </form>
</body>
</html>`;

interface FixtureServer {
  url: string;
  close: () => Promise<void>;
}

function startFixtureServer(): Promise<FixtureServer> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURE_HTML);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        throw new Error("server.address() not AddressInfo");
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

async function main(): Promise<void> {
  const fixture = await startFixtureServer();
  console.log(`[fixture] serving at ${fixture.url}`);

  const profileDir = await mkdtemp(join(tmpdir(), "disambig-live-"));
  console.log(`[browser] profile dir: ${profileDir}`);

  const browser = new BrowserController({ humanize: false, profileDir });
  await browser.start();
  console.log(`[browser] launched mode=${browser.launchMode} channel=${browser.channel ?? "?"}`);

  try {
    await browser.goto(fixture.url);
    console.log(`[browser] navigated to fixture`);

    // Pre-replay inventory: prove there ARE two matching "Name"
    // inputs so the disambiguator actually has something to disambiguate.
    const preInventory = await browser.extractInteractiveElements();
    const nameMatches = preInventory.filter((el) => {
      const lt = (el.labelText ?? "").toLowerCase();
      const ph = (el.placeholder ?? "").toLowerCase();
      const ar = (el.ariaLabel ?? "").toLowerCase();
      return lt === "name" || ph === "name" || ar === "name";
    });
    console.log(
      `[pre-replay] inputs matching label_hint="Name": ${nameMatches.length}`,
    );
    for (const m of nameMatches) {
      console.log(
        `  - selector=${m.selector}  value=${JSON.stringify(m.value)}  inViewport=${m.inViewport}`,
      );
    }
    if (nameMatches.length < 2) {
      throw new Error(
        `Fixture didn't produce a multi-match scenario — only ${nameMatches.length} input(s) matched. ` +
          `The disambiguator cascade would never fire on this DOM.`,
      );
    }

    const skill: Skill = {
      schema_version: 1,
      service: "fixture-disambig-test",
      version: "v1",
      skill_id: "01HZTEST0000000000000000XX",
      signup_url: fixture.url,
      oauth_provider: null,
      steps: [
        {
          kind: "fill",
          label_hint: "Name",
          value_template: "rc25-disambig-pass",
          provenance: { run_id: "live-test", round_index: 0 },
        },
      ],
      credentials: [
        {
          type: "api_key",
          shape_hint: "opaque",
          env_var_suggestion: "FIXTURE_API_KEY",
          post_extract_validator: {
            min_length: 1,
            max_length: 200,
          },
        },
      ],
      source_run_ids: ["live-test"],
      status: "active",
      replays_succeeded: 0,
      replays_failed: 0,
      consecutive_failures: 0,
      created_at: new Date().toISOString(),
      last_replayed_at: null,
      superseded_at: null,
      deleted_at: null,
    };

    console.log(`[replay] invoking replaySkill mode=full`);
    const outcome = await replaySkill({ skill, browser, mode: "full" });
    console.log(`[replay] outcome.kind = ${outcome.kind}`);

    // The skill has no extract step, so full-mode replay returns
    // extraction_failed after the fill — that's expected. The real
    // assertion is on the side effect: which input got the value.
    const postInventory = await browser.extractInteractiveElements();
    const existing = postInventory.find((el) => el.selector.includes("#existing"));
    const newInput = postInventory.find((el) => el.selector.includes("#new"));

    if (existing === undefined || newInput === undefined) {
      throw new Error(
        `Lost one of the fixture inputs from inventory: existing=${existing?.selector}, new=${newInput?.selector}`,
      );
    }

    console.log(`[verify] #existing value: ${JSON.stringify(existing.value)}`);
    console.log(`[verify] #new      value: ${JSON.stringify(newInput.value)}`);

    const newGotIt = newInput.value === "rc25-disambig-pass";
    const existingUntouched = existing.value === "existing-key-name";

    if (newGotIt && existingUntouched) {
      console.log("");
      console.log("[PASS] rc.25 disambiguator picked #new (empty + in-viewport)");
      console.log("       #existing was left untouched");
      process.exit(0);
    } else {
      console.log("");
      console.log("[FAIL] disambiguator picked the WRONG input");
      console.log(`       expected: #new='rc25-disambig-pass', #existing='existing-key-name'`);
      console.log(`       got:      #new=${JSON.stringify(newInput.value)}, #existing=${JSON.stringify(existing.value)}`);
      process.exit(1);
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
