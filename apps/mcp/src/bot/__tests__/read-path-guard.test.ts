// Read-path guard.
//
// #663 removed every operator seal, redaction, and read refusal: the operator
// returns what the page renders. That property has no runtime assertion — it
// is the ABSENCE of code — so the only way to keep it is to check the SOURCE
// for the machinery coming back. Deliberately source-level, on purpose.
//
// The check is by MODULE SPECIFIER, not by the names of the symbols #663
// happened to delete. A future seal will not be called `redactObservationText`;
// it will be a fresh detector imported into a read module, and the import is
// the thing every version of that mistake has in common.
//
// Every rule here is a pure function of source TEXT, so each one has negative
// coverage below: the test mutates a real module's text the way a regression
// would and asserts the rule goes red. A guard nobody has watched fail is a
// guard nobody knows works.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function source(relative: string): string {
  return readFileSync(path.join(srcDir, relative), "utf8");
}

// Comments discuss the removed machinery by name on purpose (the #663
// rationale lives in them). Only real code counts as it coming back.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// Every `from "..."` specifier in a file, imports and re-exports alike.
function importSpecifiers(text: string): string[] {
  return [...stripComments(text).matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]!);
}

// A module specifier that would bring a credential detector, or anything
// seal/redact/mask-shaped, into a read path.
function detectorSpecifiers(text: string): string[] {
  return importSpecifiers(text).filter(
    (specifier) => specifier.includes("credential-shape") || /seal|redact|mask/i.test(specifier),
  );
}

// The names bound by `import { a, b as c } from "x"` for one specifier.
function namedImportsFrom(text: string, specifier: string): string[] {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+"${escaped}"`, "g");
  const names: string[] = [];
  for (const match of stripComments(text).matchAll(pattern)) {
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

// Every line of real code that CALLS isMaskedDisplay. #663 kept the predicate
// as a RANKING signal (a masked-looking candidate loses to a revealed sibling)
// and deleted its use as a refusal. Pinning the call sites is what stops the
// one allowed detector from quietly becoming a refusal again.
function maskedDisplayCallLines(text: string): string[] {
  return stripComments(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\bisMaskedDisplay\s*\(/.test(line));
}

// Every module the agent's view of a page flows through. `browser.ts` owns the
// screenshot capture and the DOM reads; `provision-session.ts` owns observe,
// observe-query and the screenshot wrapper; `compact-observation-v2.ts` formats
// the action map; the extraction pair reads credentials off the page;
// `provision-drive.ts` is the tool surface over all of it.
const READ_PATH_MODULES = [
  "bot/browser.ts",
  "bot/compact-observation-v2.ts",
  "bot/extraction.ts",
  "bot/credential-extraction-flow.ts",
  "bot/provision-session.ts",
  "tools/provision-drive.ts",
];

// The two modules that legitimately import a detector, with the EXACT bindings
// each is allowed. Extraction's whole job is finding a credential on a page, so
// it may ask what a string looks like; it may not refuse to return one.
// Anything not listed fails — including a second detector added beside these.
const ALLOWED_DETECTOR_IMPORTS: Record<string, Record<string, string[]>> = {
  "bot/provision-session.ts": {
    "./credential-shape.js": [
      "looksLikeCodeIdentifier",
      "isCredentialNoise",
      "findCredentialTokens",
      "findOtpCredential",
      "keyFamilyPrefix",
      "pickRelaxedNearCopyCredential",
    ],
  },
  "tools/provision-drive.ts": {
    "../bot/credential-shape.js": ["isMaskedDisplay"],
  },
};

describe("no read-path module imports an unapproved detector", () => {
  for (const relative of READ_PATH_MODULES) {
    it(`${relative} imports only its approved detector bindings`, () => {
      const text = source(relative);
      const allowed = ALLOWED_DETECTOR_IMPORTS[relative] ?? {};
      // Every detector-shaped specifier must be one we approved…
      expect(detectorSpecifiers(text).sort()).toEqual(Object.keys(allowed).sort());
      // …and it must bring exactly the bindings we approved, no more.
      for (const [specifier, bindings] of Object.entries(allowed)) {
        expect(namedImportsFrom(text, specifier).sort()).toEqual([...bindings].sort());
      }
    });
  }
});

describe("the allowed detector stays a ranking signal, never a refusal", () => {
  it("isMaskedDisplay is called only inside the candidate ranking", () => {
    // Both call sites are the two halves of one sort: unmasked candidates
    // first, masked ones after. A third call site — or either of these moved
    // into a branch that returns a blocked_reason — fails here.
    expect(maskedDisplayCallLines(source("tools/provision-drive.ts"))).toEqual([
      "...candidates.filter(([, v]) => !isMaskedDisplay(v)),",
      "...candidates.filter(([, v]) => isMaskedDisplay(v)),",
    ]);
  });
});

describe("no read module re-declares a symbol #663 deleted", () => {
  // Belt to the specifier check's braces: these exact names were the seal, the
  // redaction table, and the read refusals. None has a reason to reappear.
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

  for (const relative of READ_PATH_MODULES) {
    it(`${relative} is free of them`, () => {
      const code = stripComments(source(relative));
      expect(DELETED_SYMBOLS.filter((symbol) => code.includes(symbol))).toEqual([]);
    });
  }
});

// ── negative coverage: each rule, watched failing ────────────────────────

describe("the guard actually catches the regressions it claims to", () => {
  it("catches a fresh detector import added to any read module", () => {
    for (const relative of READ_PATH_MODULES) {
      const mutated = `import { isCredentialShape } from "./credential-shape.js";\n${source(relative)}`;
      const allowed = Object.keys(ALLOWED_DETECTOR_IMPORTS[relative] ?? {}).sort();
      expect(detectorSpecifiers(mutated).sort()).not.toEqual(allowed);
    }
  });

  it("catches a seal/redact/mask-shaped module imported into a read module", () => {
    for (const specifier of ["./observation-redact.js", "./seal-policy.js", "./value-mask.js"]) {
      const mutated = `import { screen } from "${specifier}";\n${source("bot/compact-observation-v2.ts")}`;
      expect(detectorSpecifiers(mutated)).toEqual([specifier]);
    }
  });

  it("catches a SECOND binding smuggled onto an approved detector import", () => {
    const mutated = source("tools/provision-drive.ts").replace(
      'import { isMaskedDisplay } from "../bot/credential-shape.js";',
      'import { isMaskedDisplay, looksLikeCredentialValue } from "../bot/credential-shape.js";',
    );
    expect(namedImportsFrom(mutated, "../bot/credential-shape.js")).toEqual([
      "isMaskedDisplay",
      "looksLikeCredentialValue",
    ]);
  });

  it("catches the ranking predicate converted back into a refusal", () => {
    const mutated = source("tools/provision-drive.ts").replace(
      "const handle = stashSecretSlot(args.session_id, args.into_slot, full);",
      'if (isMaskedDisplay(full)) return { blocked_reason: "still masked" };\n' +
        "    const handle = stashSecretSlot(args.session_id, args.into_slot, full);",
    );
    expect(maskedDisplayCallLines(mutated)).toHaveLength(3);
  });

  it("catches a deleted seal symbol reintroduced as real code", () => {
    const mutated = `${source("bot/compact-observation-v2.ts")}\nexport function redactObservationText(v: string) { return v; }\n`;
    expect(stripComments(mutated).includes("redactObservationText")).toBe(true);
  });

  it("does not fire on a comment that merely names the machinery", () => {
    const commented = `// import { isCredentialShape } from "./credential-shape.js";\n${source("bot/browser.ts")}`;
    expect(detectorSpecifiers(commented)).toEqual([]);
  });
});
