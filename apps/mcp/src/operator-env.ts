// Operator-infra env loader. Lives at src/ (NOT src/housekeeper/, which the
// npm tarball excludes) so both the housekeeper AND the install/login CLI can
// import it.
//
// Loads ~/.config/trusty-squire/harvester.env into process.env. The systemd
// heal timer pulls this in via EnvironmentFile=, but a hand-run shell does NOT
// — so REGISTRY_ADMIN_BEARER / notifier tokens were silently absent unless the
// operator remembered `set -a; source harvester.env`.
//
// Best-effort + NON-overwriting: an already-set env value always wins
// (hand-exported vars, CI), and a missing/unreadable file is a no-op — so end
// users (who have no harvester.env) are unaffected. Parses simple KEY=VALUE
// lines: skips blanks + `#` comments, strips one layer of matching quotes,
// honors XDG_CONFIG_HOME. Reads an operator-placed 600-perm file; it does NOT
// touch the credential vault (write-only by design, cannot feed a process).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function loadHarvesterEnvFile(): void {
  try {
    const configHome =
      process.env.XDG_CONFIG_HOME !== undefined && process.env.XDG_CONFIG_HOME !== ""
        ? process.env.XDG_CONFIG_HOME
        : join(homedir(), ".config");
    const path = join(configHome, "trusty-squire", "harvester.env");
    if (!existsSync(path)) return;
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (key === "UNIVERSAL_BOT_PROXY_URL" || key === "UNIVERSAL_BOT_HEADLESS") continue;
      if (process.env[key] !== undefined) continue; // existing env wins
      let value = line.slice(eq + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // best-effort — downstream "not set" guards surface a genuine gap.
  }
}
