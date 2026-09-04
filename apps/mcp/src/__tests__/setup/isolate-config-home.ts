// Every test file runs with its own throwaway HOME.
//
// This is a hard containment rule, not a convenience. The box this package is
// developed on runs several LIVE `mcp server` processes, and their state is all
// under the developer's home:
//   * $XDG_CONFIG_HOME/trusty-squire/session.json — the operator's real
//     session. A test that reached it (directly, or through any code path that
//     calls openSessionStorage without a path override) would read and, worse,
//     rewrite a real session underneath running servers. One did exactly that.
//   * ~/.trusty-squire/chrome-profile — the single real browser profile. Its
//     claim file is what `ProfileBusyError` guards; a test taking or clearing
//     that claim fights a live provision for the operator's browser.
//   * ~/.trusty-squire/server-instances — the live servers' heartbeat records.
//
// Individual tests may still override HOME/XDG_CONFIG_HOME for their own
// fixtures; this only guarantees the DEFAULT never resolves to a real home.

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Pin Playwright's browser cache to the REAL home before moving HOME. The
// downloaded browsers are read-only shared state, not operator state, and a
// sandboxed HOME would otherwise send every Chromium fixture looking for an
// executable that isn't there.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(homedir(), ".cache", "ms-playwright");

const sandbox = mkdtempSync(join(tmpdir(), "ts-mcp-home-"));
process.env.HOME = sandbox;
process.env.XDG_CONFIG_HOME = join(sandbox, ".config");
// CHROME_PROFILE_DIR reads this at module load; setupFiles run before the test
// module graph, so setting it here is what actually takes effect.
process.env.TRUSTY_SQUIRE_PROFILE_DIR = join(sandbox, ".trusty-squire", "chrome-profile");

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});
