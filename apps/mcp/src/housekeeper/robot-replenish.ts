import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadIdentities, loadUsage } from "./identity-pool.js";

export interface ReplenishVerifyPoolOpts {
  log: (line: string) => void;
  force?: boolean;
  maxPerPass?: number;
  rotateAll?: boolean;
}

// Replenish the verify-robot pool by rotating worn identities out and warming
// freshly minted replacements. Default mode preserves the historical opt-in
// gate (ROBOT_AUTO_REPLENISH=1). `force` is for on-demand exhaustion handling:
// if the system has the unattended admin token, needing a fresh robot is itself
// sufficient authorization to replenish.
export async function replenishVerifyPool(opts: ReplenishVerifyPoolOpts): Promise<string> {
  const log = opts.log;
  const force = opts.force === true;
  if (!force && !/^(1|true|on)$/i.test(process.env.ROBOT_AUTO_REPLENISH ?? "")) return "";

  const tsDir = join(homedir(), ".trusty-squire");
  if (!existsSync(join(tsDir, "admin-oauth.json")) && !existsSync(join(tsDir, "admin-sa.json"))) {
    log(
      "pool replenish: skipped — no unattended admin token " +
        "(~/.trusty-squire/admin-oauth.json). See HOUSEKEEPER-OPERATIONS.md.",
    );
    return "";
  }

  const spentGe = Number(process.env.ROBOT_REPLENISH_SPENT_GE ?? 8);
  const maxPerPass = opts.maxPerPass ?? Number(process.env.ROBOT_REPLENISH_MAX_PER_PASS ?? 2);
  const rotateAll = opts.rotateAll === true;
  let worn = 0;
  try {
    const ids = loadIdentities();
    const usage = loadUsage();
    worn = rotateAll
      ? ids.length
      : ids.filter(
          (i) => new Set(usage.filter((u) => u.identityId === i.id).map((u) => u.service)).size >= spentGe,
        ).length;
  } catch (err) {
    log(`pool replenish: pool read failed (non-fatal) — ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
  if (worn === 0) {
    log(
      rotateAll
        ? "pool replenish: skipped — verify pool is empty"
        : `pool replenish: skipped — no robot is worn at >=${spentGe} services`,
    );
    return "";
  }

  const n = Math.min(worn, maxPerPass);
  log(
    rotateAll
      ? `pool replenish: no fresh service robot available — rotating ${n}/${worn} robot(s) (cost-flat, delete-before-create)`
      : `pool replenish: ${worn} robot(s) spent at >=${spentGe} services — rotating ${n} (cost-flat, delete-before-create)`,
  );
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  let fresh: string[] = [];
  try {
    const out = execFileSync("node", ["tools/provision-verify-robot.mjs", "rotate", `--make-room=${n}`], {
      cwd,
      encoding: "utf8",
      timeout: 180_000,
    });
    fresh = [...new Set([...out.matchAll(/warm (verify-\d+)/g)].map((m) => m[1] as string))];
  } catch (err) {
    log(`pool replenish: rotate failed (non-fatal) — ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }

  let warmed = 0;
  for (const id of fresh) {
    try {
      execFileSync("node", ["tools/google-login-fleet.mjs", id], { cwd, encoding: "utf8", timeout: 240_000 });
      warmed += 1;
    } catch (err) {
      log(`pool replenish: warm ${id} failed (non-fatal) — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`pool replenish: rotated ${n}, warmed ${warmed}/${fresh.length} fresh robot(s)`);
  return ` · pool +${warmed} fresh`;
}
