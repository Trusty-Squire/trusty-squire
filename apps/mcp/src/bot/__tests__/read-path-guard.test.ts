// Read-path guard.
//
// #663 removed every operator seal, redaction, and read refusal: the operator
// returns what the page renders. That property has no runtime assertion — it
// is the ABSENCE of code — so the only way to keep it is to check the source
// for the machinery coming back. Deliberately source-level, on purpose.
//
// Two checks:
//   1. The pure read-formatting module imports no credential detector and
//      nothing seal/redact/mask-shaped. A detector import there is the first
//      move of re-adding a screen, so it fails here.
//   2. No module on any read path re-declares one of the exact symbols #663
//      deleted. These names are the fingerprints of the removed layer.
//
// What this does NOT ban is the word "mask" everywhere. `isMaskedDisplay`
// survives in the EXTRACT path as a RANKING signal — a masked-looking
// candidate loses to a revealed sibling and is never refused — which is the
// behaviour #663 shipped. Its one import site is pinned exactly, so turning it
// back into a refusal predicate (or adding a second detector beside it) fails.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const botDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(botDir, "..", "..");

function source(relative: string): string {
  return readFileSync(path.join(srcDir, relative), "utf8");
}

// Comments discuss removed machinery by name on purpose (the #663 rationale
// lives in them). Only real code counts as the machinery coming back.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// Every `from "..."` specifier in a file, imports and re-exports alike.
function importSpecifiers(text: string): string[] {
  return [...text.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]!);
}

// The names bound by `import { a, b as c } from "x"` for a given specifier.
function namedImportsFrom(text: string, specifier: string): string[] {
  const pattern = new RegExp(
    `import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+"${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
    "g",
  );
  const names: string[] = [];
  for (const match of text.matchAll(pattern)) {
    for (const raw of match[1]!.split(",")) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)[0]!
        .replace(/^type\s+/, "")
        .trim();
      if (name.length > 0) names.push(name);
    }
  }
  return names;
}

// The observation formatter: turns a page into the compact action map the
// model reads. Nothing here may consult what a value LOOKS like.
const PURE_READ_MODULES = ["bot/compact-observation-v2.ts"];

describe("the compact observation formatter carries no detector", () => {
  for (const relative of PURE_READ_MODULES) {
    it(`${relative} imports no credential detector`, () => {
      const specifiers = importSpecifiers(source(relative));
      expect(specifiers.filter((s) => s.includes("credential-shape"))).toEqual([]);
      expect(specifiers.filter((s) => /seal|redact|mask/i.test(s))).toEqual([]);
    });

    it(`${relative} imports no seal/redact/mask-shaped binding`, () => {
      const text = source(relative);
      const bound = importSpecifiers(text).flatMap((s) => namedImportsFrom(text, s));
      expect(bound.filter((name) => /seal|redact|mask/i.test(name))).toEqual([]);
    });
  }
});

describe("the extract path's one detector import stays a ranking signal", () => {
  it("provision-drive imports exactly isMaskedDisplay from credential-shape", () => {
    expect(
      namedImportsFrom(source("tools/provision-drive.ts"), "../bot/credential-shape.js"),
    ).toEqual(["isMaskedDisplay"]);
  });
});

describe("no read module re-declares a symbol #663 deleted", () => {
  // Exact names from the #663 removal. Each one WAS a seal, a redaction table,
  // or a read refusal; none of them has a legitimate reason to reappear.
  // NOT on this list, deliberately: `carriesPaymentMaterial`. #663 kept it,
  // narrowed to the recordable-token screen over the stderr audit trail and
  // the registry-bound action trace — neither of which is a read by the agent.
  const DELETED_SYMBOLS = [
    "redactObservationText",
    "sealedFieldKeys",
    "SCREENSHOT_REDACTION_SELECTORS",
    "compactV2ThickResult",
    "compactV2PublicValue",
    "screenshot_unavailable_sealed_context",
    "no_legit_credential",
  ];
  const READ_PATH_MODULES = [
    "bot/compact-observation-v2.ts",
    "bot/provision-session.ts",
    "bot/browser.ts",
    "bot/extraction.ts",
    "bot/credential-extraction-flow.ts",
    "tools/provision-drive.ts",
  ];

  for (const relative of READ_PATH_MODULES) {
    it(`${relative} is free of them`, () => {
      const code = stripComments(source(relative));
      expect(DELETED_SYMBOLS.filter((symbol) => code.includes(symbol))).toEqual([]);
    });
  }
});
