// rc.6 CLI polish — pins the rendered output of ui.ts helpers with
// colors stripped (chalk level=0) so the test asserts the structural
// content (prefix glyphs, layout, link wrapping) without locking us
// into specific color codes.
//
// What this covers:
//   - Glyph prefixes (▸ ✓ ⚠ ✗ ℹ) match the design system
//   - Section header renders as "N/M · Label"
//   - Divider renders as a hairline `─` run
//   - link() produces OSC 8 escape codes when stdout is TTY, raw
//     URL when piped
//   - panel() emits a single-border box with the supplied body

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import chalk from "chalk";
import * as ui from "../ui.js";

// Capture lines written via console.warn / console.error so we can
// assert on the rendered text. Vitest mocks reset between tests.
let warned: string[] = [];
let errored: string[] = [];

beforeAll(() => {
  // Strip ANSI so snapshots are deterministic across CI/local + TTY/pipe.
  chalk.level = 0;
});

beforeEach(() => {
  warned = [];
  errored = [];
  vi.spyOn(console, "warn").mockImplementation((msg?: unknown) => {
    warned.push(String(msg ?? ""));
  });
  vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
    errored.push(String(msg ?? ""));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ui glyph prefixes", () => {
  it("step uses ▸", () => {
    ui.step("Issuing token");
    expect(warned[0]).toBe("▸ Issuing token");
  });

  it("success uses ✓", () => {
    ui.success("done");
    expect(warned[0]).toBe("✓ done");
  });

  it("warn uses ⚠", () => {
    ui.warn("residential proxy not set");
    expect(warned[0]).toBe("⚠ residential proxy not set");
  });

  it("fail uses ✗", () => {
    ui.fail("install aborted");
    expect(warned[0]).toBe("✗ install aborted");
  });

  it("info uses ℹ", () => {
    ui.info("optional advisory");
    expect(warned[0]).toBe("ℹ optional advisory");
  });
});

describe("ui.section — numbered section header", () => {
  it("renders as 'N/M · Label' with a leading blank line", () => {
    ui.section(1, 2, "Account");
    // Two warns: blank, then header
    expect(warned).toEqual(["", "1/2 · Account"]);
  });
});

describe("ui.heading", () => {
  it("renders the title between blank lines", () => {
    ui.heading("Trusty Squire");
    expect(warned).toEqual(["", "Trusty Squire", ""]);
  });
});

describe("ui.divider — hairline rule", () => {
  it("emits a row of ─ characters", () => {
    ui.divider();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/^─+$/);
  });
});

describe("ui.link — OSC 8 hyperlinks", () => {
  const originalIsTTY = process.stdout.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
  });

  it("returns raw 'label (url)' when stdout is NOT a TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    const out = ui.link("https://example.com/x", "Example");
    expect(out).toBe("Example (https://example.com/x)");
  });

  it("returns the raw URL when piped without a label", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    const out = ui.link("https://example.com/x");
    expect(out).toBe("https://example.com/x");
  });

  it("wraps in OSC 8 escapes when stdout IS a TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    const out = ui.link("https://example.com/x");
    // OSC 8 sequence: \x1b]8;;<url>\x1b\\<text>\x1b]8;;\x1b\\
    expect(out).toContain("\x1b]8;;https://example.com/x\x1b\\");
    expect(out).toContain("https://example.com/x");
    expect(out).toMatch(/\x1b\]8;;\x1b\\$/);
  });
});

describe("ui.panel", () => {
  it("renders a hairline box around the body", () => {
    ui.panel("hello");
    expect(warned).toHaveLength(1);
    const out = warned[0]!;
    // single-border (─│) per Linear/Obsidian aesthetic
    expect(out).toContain("─");
    expect(out).toContain("│");
    expect(out).toContain("hello");
  });
});
