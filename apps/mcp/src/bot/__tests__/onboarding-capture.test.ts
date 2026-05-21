// Covers the integrity-chained capture format (T6/T7):
//   - every dumped round carries capture_format_version, prev_hash, content_hash
//   - the chain links: round N's prev_hash matches round N-1's content_hash
//   - verifyCaptureChain accepts a well-formed chain
//   - verifyCaptureChain rejects: hand-edits (any field), wrong version,
//     gap in the round sequence, parse errors, and chain breakage.

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CAPTURE_FORMAT_VERSION,
  captureOnboardingRound,
  verifyCaptureChain,
  type OnboardingCaseFile,
} from "../onboarding-capture.js";
import type { PostVerifyStep } from "../agent.js";

// Synthetic test fixtures — never any real captures.

function mockRound(round: number, service = "testsvc") {
  return {
    service,
    round,
    oauth: true,
    state: {
      url: `https://example.com/r${round}`,
      title: `Round ${round}`,
      html: `<html>round ${round}</html>`,
      screenshot: "data:image/png;base64,iVBORw0KGgo=",
    },
    inventory: [
      {
        index: 0,
        tag: "button",
        type: null,
        visibleText: "Click me",
        ariaLabel: null,
        role: null,
        selector: `button[data-r="${round}"]`,
        id: null,
        labelText: null,
        placeholder: null,
        name: null,
        value: null,
        visible: true,
        inViewport: true,
        inConsentWidget: false,
      },
    ],
    observed: {
      kind: "click" as const,
      selector: `button[data-r="${round}"]`,
      reason: `synthetic click on round ${round}`,
    } satisfies PostVerifyStep,
  };
}

// Process-level state in onboarding-capture.ts isn't easily resettable;
// each test gets a unique service slug so the chainHead Map's per-key
// state doesn't leak across tests.
let testCounter = 0;
function uniqueService(): string {
  testCounter += 1;
  return `tsvc-${Date.now().toString(36)}-${testCounter}`;
}

function withCaptureDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "onboarding-capture-test-"));
  const prev = process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
  process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = dir;
  try {
    fn(dir);
  } finally {
    if (prev === undefined) {
      delete process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
    } else {
      process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = prev;
    }
  }
}

// ── captureOnboardingRound: format + chain  ─────────────────────────

describe("captureOnboardingRound — format", () => {
  it("dumps a round with capture_format_version + integrity fields", () => {
    withCaptureDir((dir) => {
      const service = uniqueService();
      captureOnboardingRound(mockRound(0, service));

      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      const written = JSON.parse(
        readFileSync(join(dir, files[0]!), "utf8"),
      ) as OnboardingCaseFile;

      expect(written.capture_format_version).toBe(CAPTURE_FORMAT_VERSION);
      expect(written.prev_hash).toBeNull();
      expect(typeof written.content_hash).toBe("string");
      expect(written.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(written.expect).toBeNull();
    });
  });

  it("chains rounds: round 1's prev_hash matches round 0's content_hash", () => {
    withCaptureDir((dir) => {
      const service = uniqueService();
      captureOnboardingRound(mockRound(0, service));
      captureOnboardingRound(mockRound(1, service));

      const files = readdirSync(dir).sort();
      expect(files).toHaveLength(2);

      const r0 = JSON.parse(
        readFileSync(join(dir, files[0]!), "utf8"),
      ) as OnboardingCaseFile;
      const r1 = JSON.parse(
        readFileSync(join(dir, files[1]!), "utf8"),
      ) as OnboardingCaseFile;

      expect(r1.prev_hash).toBe(r0.content_hash);
      expect(r1.content_hash).not.toBe(r0.content_hash);
    });
  });

  it("isolates chains across services in the same run", () => {
    withCaptureDir((dir) => {
      const a = uniqueService();
      const b = uniqueService();
      captureOnboardingRound(mockRound(0, a));
      captureOnboardingRound(mockRound(0, b));
      captureOnboardingRound(mockRound(1, a));

      const aSlug = a.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      // Service a's round 1 should chain to service a's round 0,
      // NOT service b's round 0. Match files whose name starts with
      // `${aSlug}-` so we don't accidentally pick up a service whose
      // slug is a prefix of another (e.g. "tsvc-1" vs "tsvc-10").
      const aR1Files = readdirSync(dir).filter(
        (f) => f.startsWith(`${aSlug}-`) && f.endsWith("r1.json"),
      );
      expect(aR1Files).toHaveLength(1);
      const aR1 = JSON.parse(
        readFileSync(join(dir, aR1Files[0]!), "utf8"),
      ) as OnboardingCaseFile;

      const aR0Files = readdirSync(dir).filter(
        (f) => f.startsWith(`${aSlug}-`) && f.endsWith("r0.json"),
      );
      expect(aR0Files).toHaveLength(1);
      const aR0 = JSON.parse(
        readFileSync(join(dir, aR0Files[0]!), "utf8"),
      ) as OnboardingCaseFile;

      expect(aR1.prev_hash).toBe(aR0.content_hash);
    });
  });

  it("is inert when TRUSTY_SQUIRE_ONBOARDING_CAPTURE is unset", () => {
    // Just confirm no throw and no writes; we can't easily observe
    // the no-write side since there's no temp dir to inspect.
    const prev = process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
    delete process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
    try {
      expect(() => captureOnboardingRound(mockRound(0))).not.toThrow();
    } finally {
      if (prev !== undefined) {
        process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = prev;
      }
    }
  });
});

// ── verifyCaptureChain: pass + reject ───────────────────────────────

describe("verifyCaptureChain", () => {
  // Helper: capture N rounds for a service, return (dir, slug, runId).
  function setupRounds(n: number): { dir: string; service: string; slug: string; runId: string } {
    let captured: { dir: string; service: string; slug: string; runId: string } | undefined;
    withCaptureDir((dir) => {
      const service = uniqueService();
      const slug = service.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      for (let i = 0; i < n; i++) {
        captureOnboardingRound(mockRound(i, service));
      }
      let runId = "no-runs-runid";
      if (n > 0) {
        const files = readdirSync(dir);
        const sample = files[0]!;
        // Format: <slug>-<runId>-r<n>.json — runId is everything between
        // slug+"-" and "-r<n>.json".
        const afterSlug = sample.slice(slug.length + 1);
        runId = afterSlug.slice(0, afterSlug.lastIndexOf("-r"));
      }
      captured = { dir, service, slug, runId };
    });
    return captured!;
  }

  it("accepts a clean 3-round chain", () => {
    const { dir, service, runId } = setupRounds(3);
    const v = verifyCaptureChain(dir, service, runId);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.rounds).toHaveLength(3);
      expect(v.rounds[0]!.prev_hash).toBeNull();
      expect(v.rounds[1]!.prev_hash).toBe(v.rounds[0]!.content_hash);
      expect(v.rounds[2]!.prev_hash).toBe(v.rounds[1]!.content_hash);
    }
  });

  it("rejects no_rounds when the directory has no matching files", () => {
    const { dir, runId } = setupRounds(0);
    const v = verifyCaptureChain(dir, "absent-service", runId);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("no_rounds");
  });

  it("rejects hand-edits to observed step (hash mismatch)", () => {
    const { dir, slug, runId } = setupRounds(2);

    // Tamper round 1's observed step.
    const r1Path = join(dir, `${slug}-${runId}-r1.json`);
    const r1 = JSON.parse(readFileSync(r1Path, "utf8")) as OnboardingCaseFile;
    const tampered = {
      ...r1,
      observed: { ...r1.observed, reason: "MALICIOUS HAND EDIT" },
    };
    writeFileSync(r1Path, JSON.stringify(tampered, null, 2));

    const v = verifyCaptureChain(dir, slug, runId);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("hash_mismatch");
      expect(v.offending_round).toBe(1);
    }
  });

  it("rejects hand-edits to state.url (hash mismatch)", () => {
    const { dir, slug, runId } = setupRounds(1);
    const r0Path = join(dir, `${slug}-${runId}-r0.json`);
    const r0 = JSON.parse(readFileSync(r0Path, "utf8")) as OnboardingCaseFile;
    const tampered = {
      ...r0,
      state: { ...r0.state, url: "https://phishing.example.com" },
    };
    writeFileSync(r0Path, JSON.stringify(tampered, null, 2));

    const v = verifyCaptureChain(dir, slug, runId);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("hash_mismatch");
      expect(v.offending_round).toBe(0);
    }
  });

  it("allows hand-edits to expect (curator slot, intentionally mutable)", () => {
    const { dir, slug, runId } = setupRounds(1);
    const r0Path = join(dir, `${slug}-${runId}-r0.json`);
    const r0 = JSON.parse(readFileSync(r0Path, "utf8")) as OnboardingCaseFile;
    // expect is intentionally outside the hash so curators can fill it in
    const curated = {
      ...r0,
      expect: { kind: "extract", reason: "human-curated label" },
    };
    writeFileSync(r0Path, JSON.stringify(curated, null, 2));

    const v = verifyCaptureChain(dir, slug, runId);
    expect(v.ok).toBe(true);
  });

  it("rejects an unknown capture_format_version", () => {
    const { dir, slug, runId } = setupRounds(1);
    const r0Path = join(dir, `${slug}-${runId}-r0.json`);
    const r0 = JSON.parse(readFileSync(r0Path, "utf8")) as OnboardingCaseFile;
    // Tamper version field — note that the content_hash will now also
    // be wrong, but we want to ensure the version check fires FIRST
    // so the error is intelligible. We replace both fields here.
    const futureFormat = {
      ...r0,
      capture_format_version: 99,
    };
    writeFileSync(r0Path, JSON.stringify(futureFormat, null, 2));

    const v = verifyCaptureChain(dir, slug, runId);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("unknown_version");
  });

  it("rejects a chain with a missing middle round", () => {
    const { dir, slug, runId } = setupRounds(3);
    // Delete r1 to create a gap.
    const r1Path = join(dir, `${slug}-${runId}-r1.json`);
    const { unlinkSync } = require("node:fs") as typeof import("node:fs");
    unlinkSync(r1Path);

    const v = verifyCaptureChain(dir, slug, runId);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("missing_round");
      expect(v.offending_round).toBe(1);
    }
  });

  it("rejects malformed JSON with a parse_error", () => {
    const { dir, slug, runId } = setupRounds(1);
    writeFileSync(
      join(dir, `${slug}-${runId}-r0.json`),
      "{ not valid json",
    );

    const v = verifyCaptureChain(dir, slug, runId);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("parse_error");
      expect(v.offending_round).toBe(0);
    }
  });

  it("rejects a chain where prev_hash doesn't match the previous round", () => {
    const { dir, slug, runId } = setupRounds(2);

    // Tamper r1's prev_hash to point at a wrong (but plausible) hash.
    const r1Path = join(dir, `${slug}-${runId}-r1.json`);
    const r1 = JSON.parse(readFileSync(r1Path, "utf8")) as OnboardingCaseFile;
    const tampered = {
      ...r1,
      prev_hash: "a".repeat(64), // valid sha256 shape, but wrong value
    };
    writeFileSync(r1Path, JSON.stringify(tampered, null, 2));

    const v = verifyCaptureChain(dir, slug, runId);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      // Could be either prev_hash_mismatch or hash_mismatch depending
      // on which check fires first — we accept either since both
      // identify the same security property: hand-edit detected.
      expect(["prev_hash_mismatch", "hash_mismatch"]).toContain(v.reason);
      expect(v.offending_round).toBe(1);
    }
  });

  it("orders rounds numerically, not lexicographically (r10 after r2)", () => {
    const { dir, service, runId } = setupRounds(11);
    const v = verifyCaptureChain(dir, service, runId);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.rounds).toHaveLength(11);
      // String sort would put r10 between r1 and r2; numeric sort
      // keeps r10 at index 10. Verify by checking adjacent prev_hash
      // links — they only chain correctly under numeric ordering.
      for (let i = 1; i < v.rounds.length; i++) {
        expect(v.rounds[i]!.prev_hash).toBe(v.rounds[i - 1]!.content_hash);
      }
    }
  });
});
