// Secrets-never-in-logs backstop. The injecting proxy never logs a secret by
// construction; this proves the pino `redact` config is a real safety net — a
// careless `log.info({ token })` / `{ headers }` / `{ body }` cannot leak a
// value, and the critical paths can't be silently dropped.

import { describe, it, expect } from "vitest";
import pino from "pino";
import { SECRET_REDACT_PATHS } from "../server.js";

function captureLog(obj: Record<string, unknown>): string {
  const out: string[] = [];
  const logger = pino(
    { redact: { paths: [...SECRET_REDACT_PATHS], censor: "[redacted]" } },
    {
      write(s: string): void {
        out.push(s);
      },
    },
  );
  logger.info(obj, "test");
  return out.join("");
}

describe("log redaction (secrets-never-in-logs)", () => {
  it("censors auth headers, credential-shaped fields, and bodies — no SECRET survives", () => {
    const line = captureLog({
      authorization: "Bearer sk-live-SECRET",
      cookie: "ts_session=SECRET",
      headers: { authorization: "Bearer sk-h-SECRET", cookie: "ts_session=SECRET" },
      token: "tsm_SECRET",
      machine_token: "tsm_SECRET2",
      agent_session_token: "mcp_session_SECRET",
      password: "pw-SECRET",
      value: "raw-key-SECRET",
      fields: { value: "field-SECRET" },
      nested: { token: "nested-SECRET", api_key: "ak-SECRET", value: "v-SECRET" },
      body: '{"http":{"headers":{"Authorization":"Bearer sk-SECRET"}}}',
    });
    expect(line).not.toMatch(/SECRET/);
    expect(line).toContain("[redacted]");
  });

  it("keeps non-secret context visible (account ids, status, error messages)", () => {
    const line = captureLog({ accountId: "acct_123", status: 502, error: "upstream_error" });
    expect(line).toContain("acct_123");
    expect(line).toContain("502");
    expect(line).toContain("upstream_error");
  });

  it("includes the critical paths so a security control can't be silently removed", () => {
    for (const p of [
      "authorization",
      "token",
      "secret",
      "password",
      "value",
      "fields",
      "machine_token",
      "agent_session_token",
      "body",
    ]) {
      expect(SECRET_REDACT_PATHS).toContain(p);
    }
  });
});
