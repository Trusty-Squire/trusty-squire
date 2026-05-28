// shouldRunInteractive — the gate that decides whether the install
// CLI walks the user through a clack picker or falls through to the
// flag-driven path. Critical contract: CI/non-TTY contexts must never
// hit the picker (clack would just hang waiting for keystrokes that
// never come).

import { describe, expect, it } from "vitest";
import { shouldRunInteractive } from "../interactive.js";

describe("shouldRunInteractive", () => {
  it("runs the picker in a regular interactive terminal", () => {
    expect(
      shouldRunInteractive({ hasTty: true, skipBrowser: false, forceRelogin: false }),
    ).toBe(true);
  });

  it("skips the picker when stdin isn't a TTY (CI / piped input)", () => {
    expect(
      shouldRunInteractive({ hasTty: false, skipBrowser: false, forceRelogin: false }),
    ).toBe(false);
  });

  it("skips the picker when --skip-browser is set (implies scripted)", () => {
    // CI workflows that pass --skip-browser want a deterministic
    // flag-only path. Showing the picker there would block forever.
    expect(
      shouldRunInteractive({ hasTty: true, skipBrowser: true, forceRelogin: false }),
    ).toBe(false);
  });

  it("still runs the picker on --force-relogin (it's just a state reset, not a script signal)", () => {
    expect(
      shouldRunInteractive({ hasTty: true, skipBrowser: false, forceRelogin: true }),
    ).toBe(true);
  });
});
