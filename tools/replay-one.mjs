// On-demand replay of a single skill by id, bypassing the verifier's freshness
// gate — for testing a fix without waiting for the skill to become freshness-due.
// Fetches the skill from the registry, runs the real verify replay path
// (createReplayRunner → replaySkill, full mode, bypassStatusGuard), prints the
// outcome. Run (needs harvester.env for REGISTRY_ADMIN_BEARER + proxy):
//   set -a; . ~/.config/trusty-squire/harvester.env; set +a
//   node tools/replay-one.mjs <skill_id> [<skill_id> ...]
import { createReplayRunner } from "../apps/mcp/dist/housekeeper/modes/verify.js";
import { parseSkill } from "../packages/skill-schema/dist/skill.js";
import { openSessionStorage } from "../apps/mcp/dist/session.js";
import { readFileSync } from "node:fs";

// Backfill the operator creds from the install session (same as the
// housekeeper CLI). createReplayRunner wires the await_email_code inbox
// poller ONLY when TRUSTY_SQUIRE_MACHINE_TOKEN is present — without this an
// OTP skill's await_email_code step has no inbox and times out silently.
if (
  process.env.TRUSTY_SQUIRE_MACHINE_TOKEN === undefined ||
  process.env.TRUSTY_SQUIRE_ACCOUNT_ID === undefined
) {
  try {
    const session = await (await openSessionStorage()).read();
    if (session !== null) {
      process.env.TRUSTY_SQUIRE_MACHINE_TOKEN ??= session.machine_token;
      process.env.TRUSTY_SQUIRE_ACCOUNT_ID ??= session.account_id;
      process.env.TRUSTY_SQUIRE_API_BASE ??= session.api_base_url;
    }
  } catch {
    // best-effort — a missing inbox token surfaces as a clean step failure
  }
}

const base = (process.env.TRUSTY_SQUIRE_REGISTRY_URL ?? "https://registry.trustysquire.ai").replace(/\/$/, "");
const bearer = process.env.REGISTRY_ADMIN_BEARER ?? "";
const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("usage: node tools/replay-one.mjs <skill_id> [...]");
  process.exit(2);
}

const runner = createReplayRunner();
for (const id of ids) {
  try {
    let skill;
    if (id.endsWith(".json")) {
      // Hand-authored skill file — for iterating on a rebuild (render).
      skill = parseSkill(JSON.parse(readFileSync(id, "utf8")));
    } else {
      const res = await fetch(`${base}/skills/by-id/${id}`, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      const body = await res.json();
      skill = parseSkill(body.skill ?? body);
    }
    console.error(`\n[replay-one] ${skill.service} (${id}) status=${skill.status} — replaying…`);
    const outcome = await runner({ skill, mode: "full", bypassStatusGuard: true });
    console.error(`[replay-one] ${skill.service} → ${JSON.stringify(outcome).slice(0, 300)}`);
  } catch (err) {
    console.error(`[replay-one] ${id} ERROR ${err}`);
  }
}
