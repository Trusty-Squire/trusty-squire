import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const MAX_DIAGNOSTIC_BYTES = 8 * 1024;

export function nativeLaunchSpecFromInstalledConfig(config, expectedVersion) {
  assert.ok(config && typeof config === "object", "Installed MCP config missing");
  assert.equal(typeof config.command, "string", "Installed MCP command missing");
  assert.ok(
    Array.isArray(config.args) && config.args.every((arg) => typeof arg === "string"),
    "Installed MCP args missing",
  );
  assert.equal(typeof expectedVersion, "string", "Expected MCP version missing");
  return { command: config.command, args: [...config.args], expectedVersion };
}

export function sanitizeNativeDiagnosticText(value) {
  return String(value)
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/giu, "$1?[redacted]")
    .replace(/\bBearer\s+[^\s"']+/giu, "Bearer [redacted]")
    .replace(/\b(?:tsm|ts_agent|re)_[A-Za-z0-9_-]{8,}\b/gu, "[redacted-token]")
    .slice(-MAX_DIAGNOSTIC_BYTES);
}

const waitForExit = (child, timeoutMs) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ exit_code: child.exitCode, signal: child.signalCode });
      return;
    }
    let forcedTimer;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      forcedTimer = setTimeout(
        () => resolve({ exit_code: child.exitCode, signal: child.signalCode ?? "SIGKILL" }),
        1_000,
      );
    }, timeoutMs);
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timer);
      if (forcedTimer !== undefined) clearTimeout(forcedTimer);
      resolve({ exit_code: exitCode, signal });
    });
  });

function classifyEarlyExit({ exitCode, malformedOutput, stderr }) {
  if (malformedOutput) return "protocol_error";
  if (
    exitCode !== 0 ||
    /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ENOENT|Cannot find (?:package|module)/iu.test(stderr)
  ) {
    return "launch_failure";
  }
  return "transport_closed";
}

/**
 * Launch an exact configured MCP command in an isolated environment, perform
 * only the initialize handshake, and return a metadata-only diagnostic. This
 * never calls a tool and therefore never launches a browser or mutates provider
 * state. The caller owns choosing an isolated HOME/XDG configuration.
 */
export async function runNativeLaunchDiagnostic({
  command,
  args = [],
  env = process.env,
  expectedVersion,
  timeoutMs = 35_000,
}) {
  assert.equal(typeof command, "string", "Native launch command missing");
  assert.ok(command.length > 0, "Native launch command missing");
  assert.ok(Array.isArray(args) && args.every((arg) => typeof arg === "string"));
  assert.equal(typeof expectedVersion, "string", "Expected MCP version missing");
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 35_000);

  const startedAt = Date.now();
  const connectionEpoch = randomUUID();
  let stderr = "";
  let stdout = "";
  let malformedOutput = false;
  let initialized;
  let spawnError;
  const child = spawn(command, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > MAX_DIAGNOSTIC_BYTES * 2) stderr = stderr.slice(-MAX_DIAGNOSTIC_BYTES);
  });

  const launchResult = await new Promise((resolve) => {
    let buffered = "";
    const timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    const settle = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    child.once("error", (error) => {
      spawnError = error;
      settle({ kind: "spawn_error" });
    });
    child.once("exit", (exitCode, signal) => settle({ kind: "exit", exitCode, signal }));
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim() === "") continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          malformedOutput = true;
          continue;
        }
        if (String(message.id) !== "1" || !message.result) continue;
        initialized = {
          protocol_version: message.result.protocolVersion ?? null,
          server_name: message.result.serverInfo?.name ?? null,
          server_version: message.result.serverInfo?.version ?? null,
        };
        settle({ kind: "initialized" });
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "trusty-squire-native-diagnostic", version: "1" },
        },
      })}\n`,
    );
  });

  let outcome;
  let terminal;
  if (launchResult.kind === "initialized") {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    );
    child.stdin.end();
    terminal = await waitForExit(child, 5_000);
    outcome = initialized.server_version === expectedVersion ? "ready" : "version_mismatch";
  } else if (launchResult.kind === "timeout") {
    child.kill("SIGTERM");
    terminal = await waitForExit(child, 5_000);
    outcome = "timeout";
  } else if (launchResult.kind === "spawn_error") {
    terminal = { exit_code: null, signal: null };
    outcome = "launch_failure";
  } else {
    terminal = { exit_code: launchResult.exitCode, signal: launchResult.signal };
    outcome = classifyEarlyExit({
      exitCode: launchResult.exitCode,
      malformedOutput,
      stderr,
    });
  }

  return {
    kind: "installed-command-mcp-initialization",
    connection_epoch: connectionEpoch,
    selected_command: sanitizeNativeDiagnosticText(command),
    selected_args: args.map(sanitizeNativeDiagnosticText),
    expected_version: expectedVersion,
    initialized: initialized ?? null,
    outcome,
    terminal: {
      ...terminal,
      stderr: sanitizeNativeDiagnosticText(
        spawnError instanceof Error ? `${stderr}\n${spawnError.message}` : stderr,
      ),
      stdout_non_protocol: malformedOutput ? sanitizeNativeDiagnosticText(stdout) : undefined,
    },
    started_at: startedAt,
    completed_at: Date.now(),
  };
}
