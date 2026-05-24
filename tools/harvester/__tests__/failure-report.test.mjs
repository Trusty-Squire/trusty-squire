import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildFailureReport,
  writeFailureReport,
} from "../failure-report.mjs";

let tmpDir;
let debugDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fr-test-"));
  debugDir = path.join(tmpDir, ".debug");
  await fs.mkdir(debugDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const sampleService = {
  slug: "railway",
  name: "Railway",
  signup_url: "https://railway.com/login",
};

const sampleFinal = {
  status: "captcha_blocked",
  error: "turnstile challenge did not resolve",
};

const sampleSteps = [
  "  step: Browser: launched mode=xvfb proxy=direct channel=chrome",
  "  step: Prewarming https://railway.com (referrer-chain)",
  "  step: Navigating to https://railway.com/login",
  "  step: Inventory: 25 element(s) (13 low-ranked button(s) dropped)",
  "  step: Asking Claude to plan the signup form fill...",
  "  step: Plan: 1 action(s), confidence=high — Click 'Log in using email'",
  "  step: Click div > div > div > button >> nth=2 (Click 'Log in using email')",
  "  step: Fill email → input[name=\"email\"]",
  "  step: Pre-submit captcha (turnstile): NOT solved (timeout)",
];

describe("buildFailureReport", () => {
  it("produces the expected schema for a halt-eligible failure", () => {
    const report = buildFailureReport({
      service: sampleService,
      final: sampleFinal,
      steps: sampleSteps,
      classification: "failed",
      attemptNumber: 1,
      consecutiveFailures: 3,
      mcpVersionResolved: "0.6.14-rc.33",
      runStartedAt: new Date("2026-05-24T17:21:00Z"),
      issueNumber: 16,
      repo: "Trusty-Squire/trusty-squire",
      debugDir,
    });

    expect(report.service).toBe("railway");
    expect(report.service_name).toBe("Railway");
    expect(report.signup_url).toBe("https://railway.com/login");
    expect(report.mcp_version_resolved).toBe("0.6.14-rc.33");
    expect(report.bot_status).toBe("captcha_blocked");
    expect(report.error_message).toBe("turnstile challenge did not resolve");
    expect(report.classification).toBe("failed");
    expect(report.attempt_number).toBe(1);
    expect(report.consecutive_failures).toBe(3);
    expect(report.step_trail).toEqual(sampleSteps);
    expect(report.github_issue_url).toBe(
      "https://github.com/Trusty-Squire/trusty-squire/issues/16",
    );
    expect(typeof report.ts).toBe("string");
    expect(report.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("extracts planner-relevant steps via captured_planner_output", () => {
    const report = buildFailureReport({
      service: sampleService,
      final: sampleFinal,
      steps: sampleSteps,
      classification: "failed",
      attemptNumber: 1,
      consecutiveFailures: 1,
      mcpVersionResolved: "0.6.14-rc.33",
      runStartedAt: new Date(),
      issueNumber: 16,
      repo: "Trusty-Squire/trusty-squire",
      debugDir,
    });

    expect(report.captured_planner_output.length).toBeGreaterThan(0);
    expect(report.captured_planner_output.some((s) => s.includes("Asking Claude to plan"))).toBe(true);
    expect(report.captured_planner_output.some((s) => s.includes("Plan: 1 action"))).toBe(true);
    expect(report.captured_planner_output.some((s) => s.includes("Fill email"))).toBe(true);
    expect(report.captured_planner_output.some((s) => s.includes("Pre-submit captcha"))).toBe(true);
    // Browser launch / Prewarming / Navigating are NOT planner-relevant
    expect(report.captured_planner_output.some((s) => s.includes("Browser: launched"))).toBe(false);
  });

  it("scans debug_artifacts for files modified after runStartedAt", async () => {
    const earlier = new Date(Date.now() - 60_000);
    const later = new Date();
    // Create one "old" file (predates run) and two "new" ones
    await fs.writeFile(path.join(debugDir, "old.png"), "old");
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(path.join(debugDir, "new1.png"), "new1");
    await fs.writeFile(path.join(debugDir, "new2.png"), "new2");

    // Set the old file's mtime well into the past so it falls outside
    // the runStartedAt window.
    const pastMs = Date.now() - 120_000;
    await fs.utimes(path.join(debugDir, "old.png"), pastMs / 1000, pastMs / 1000);

    const report = buildFailureReport({
      service: sampleService,
      final: sampleFinal,
      steps: [],
      classification: "failed",
      attemptNumber: 1,
      consecutiveFailures: 1,
      mcpVersionResolved: "0.6.14-rc.33",
      runStartedAt: new Date(Date.now() - 30_000),
      issueNumber: 16,
      repo: "Trusty-Squire/trusty-squire",
      debugDir,
    });

    expect(report.debug_artifacts.length).toBe(2);
    expect(report.debug_artifacts.every((p) => /new[12]\.png$/.test(p))).toBe(true);
  });

  it("returns empty debug_artifacts when the directory doesn't exist", () => {
    const report = buildFailureReport({
      service: sampleService,
      final: sampleFinal,
      steps: [],
      classification: "failed",
      attemptNumber: 1,
      consecutiveFailures: 1,
      mcpVersionResolved: "0.6.14-rc.33",
      runStartedAt: new Date(),
      issueNumber: 16,
      repo: "Trusty-Squire/trusty-squire",
      debugDir: path.join(tmpDir, "nonexistent"),
    });

    expect(report.debug_artifacts).toEqual([]);
  });

  it("handles missing issueNumber (issue not yet created)", () => {
    const report = buildFailureReport({
      service: sampleService,
      final: sampleFinal,
      steps: [],
      classification: "failed",
      attemptNumber: 1,
      consecutiveFailures: 1,
      mcpVersionResolved: "0.6.14-rc.33",
      runStartedAt: new Date(),
      issueNumber: null,
      repo: "Trusty-Squire/trusty-squire",
      debugDir,
    });

    expect(report.github_issue_url).toBeNull();
  });

  it("handles partial bot result (status only, no error)", () => {
    const report = buildFailureReport({
      service: sampleService,
      final: { status: "needs_manual" },
      steps: [],
      classification: "needs-manual",
      attemptNumber: 1,
      consecutiveFailures: 1,
      mcpVersionResolved: "0.6.14-rc.33",
      runStartedAt: new Date(),
      issueNumber: 16,
      repo: "Trusty-Squire/trusty-squire",
      debugDir,
    });

    expect(report.bot_status).toBe("needs_manual");
    expect(report.error_message).toBeNull();
  });
});

describe("writeFailureReport", () => {
  // We override HALTS_DIR via XDG-style mock by writing to a tempDir
  // and reading what landed. Easier: just call buildFailureReport,
  // verify writeFailureReport produces a real file at the expected
  // location, then clean up.
  it("writes the report under ~/.trusty-squire/halts/ with ts+slug filename", async () => {
    const homeBackup = os.homedir();
    // Override homedir for this test only by mocking the env. The
    // failure-report module reads homedir() at module-load time, so
    // we instead validate the WRITTEN file lands somewhere sensible
    // and JSON-round-trips.
    const report = buildFailureReport({
      service: sampleService,
      final: sampleFinal,
      steps: sampleSteps,
      classification: "failed",
      attemptNumber: 1,
      consecutiveFailures: 3,
      mcpVersionResolved: "0.6.14-rc.33",
      runStartedAt: new Date(),
      issueNumber: 16,
      repo: "Trusty-Squire/trusty-squire",
      debugDir,
    });

    const writtenPath = await writeFailureReport(report);
    expect(writtenPath).toMatch(/halts\/\d+-railway\.json$/);

    const roundTrip = JSON.parse(await fs.readFile(writtenPath, "utf8"));
    expect(roundTrip.service).toBe("railway");
    expect(roundTrip.bot_status).toBe("captcha_blocked");

    // Clean up
    await fs.unlink(writtenPath);
  });
});
