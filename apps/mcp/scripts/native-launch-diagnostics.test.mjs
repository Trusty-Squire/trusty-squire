import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  nativeLaunchSpecFromInstalledConfig,
  runNativeLaunchDiagnostic,
  sanitizeNativeDiagnosticText,
} from "./native-launch-diagnostics.mjs";

const fixture = fileURLToPath(new URL("./fixtures/native-launch-fixture.mjs", import.meta.url));
const run = (mode, overrides = {}) =>
  runNativeLaunchDiagnostic({
    command: process.execPath,
    args: [fixture, mode],
    expectedVersion: "1.2.3",
    timeoutMs: 2_000,
    ...overrides,
  });

describe("native MCP launch diagnostics", () => {
  it("derives the diagnostic launch from the exact installed host config", () => {
    expect(
      nativeLaunchSpecFromInstalledConfig(
        { command: "npx", args: ["-y", "@trusty-squire/mcp@1.2.3", "server"] },
        "1.2.3",
      ),
    ).toEqual({
      command: "npx",
      args: ["-y", "@trusty-squire/mcp@1.2.3", "server"],
      expectedVersion: "1.2.3",
    });
  });

  it("records the selected command, initialized version, epoch, and clean client close", async () => {
    const result = await run("ready");
    expect(result).toMatchObject({
      kind: "native-mcp-launch-diagnostic",
      expected_version: "1.2.3",
      outcome: "ready",
      initialized: {
        protocol_version: "2024-11-05",
        server_name: "fixture-mcp",
        server_version: "1.2.3",
      },
      terminal: { exit_code: 0, signal: null },
    });
    expect(result.connection_epoch).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.completed_at).toBeGreaterThanOrEqual(result.started_at);
    expect(result.terminal.stderr).not.toContain("re_secret_token");
    expect(result.terminal.stderr).not.toContain("ts_agent_secretvalue");
    expect(result.terminal.stderr).toContain("?[redacted]");
  });

  it("distinguishes an initialized version mismatch from a launch failure", async () => {
    await expect(run("version-mismatch")).resolves.toMatchObject({
      outcome: "version_mismatch",
      initialized: { server_version: "0.0.1" },
    });
    await expect(run("dependency-error")).resolves.toMatchObject({
      outcome: "launch_failure",
      initialized: null,
      terminal: { exit_code: 1 },
    });
  });

  it("distinguishes clean pre-initialize closure and non-JSON protocol output", async () => {
    await expect(run("transport-close")).resolves.toMatchObject({
      outcome: "transport_closed",
      terminal: { exit_code: 0 },
    });
    await expect(run("protocol-error")).resolves.toMatchObject({
      outcome: "protocol_error",
      terminal: { stdout_non_protocol: expect.stringContaining("non-json") },
    });
  });

  it("bounds an unresponsive native launch", async () => {
    const result = await run("timeout", { timeoutMs: 100 });
    expect(result.outcome).toBe("timeout");
    expect(result.completed_at - result.started_at).toBeLessThan(2_500);
  });

  it("sanitizes query strings and credential-shaped stderr", () => {
    expect(
      sanitizeNativeDiagnosticText(
        "https://host.test/x?secret=yes Bearer abcdef re_123456789 ts_agent_123456789",
      ),
    ).toBe("https://host.test/x?[redacted] Bearer [redacted] [redacted-token] [redacted-token]");
  });
});
