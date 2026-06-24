// Robot-fleet credential lookup for the verifier's inline OAuth login drive.
//
// The verify pool's Google passwords live in the OPERATOR-LOCAL file
// ~/.trusty-squire/verify-passwords.json (keyed by robot email) — the same file
// tools/google-login-fleet.mjs warms from. This is operator infrastructure, NOT
// the user vault: it never ships in the npm tarball (housekeeper is excluded)
// and is only read on the operator's own heal box. A per-robot env override
// (VERIFY_<ID>_PW) takes precedence so CI can inject without a file on disk.
//
// Purpose: when replay's OAuth walk lands a freshly-created robot account on the
// Google identifier page (first-time-for-this-relying-party flow), the verifier
// can type the credential through inline — exactly what the full discover bot
// does — instead of bailing `needs_login` and burning the attempt.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function poolBaseDir(): string {
  return process.env.TRUSTY_SQUIRE_VERIFY_POOL_DIR ?? join(homedir(), ".trusty-squire");
}

function loadPasswordFile(): Record<string, string> {
  try {
    const raw = readFileSync(join(poolBaseDir(), "verify-passwords.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      return parsed as Record<string, string>;
    }
  } catch {
    // Missing/unreadable file → no inline-login credential available; the caller
    // falls through to the existing needs_login path. Never throws.
  }
  return {};
}

// Returns the robot's Google password, or null when neither the env override nor
// the credential file has one. The value is never logged by callers.
export function passwordForRobot(input: { id: string; email: string }): string | null {
  const envKey = `VERIFY_${input.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PW`;
  const fromEnv = process.env[envKey];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const fromFile = loadPasswordFile()[input.email];
  return fromFile !== undefined && fromFile.length > 0 ? fromFile : null;
}
