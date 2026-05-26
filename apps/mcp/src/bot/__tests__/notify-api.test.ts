// notify-api.ts — fire-and-forget POST to /v1/notify/heightened-auth.
//
// The contract: never throw, never block the calling code path, no-op
// silently when the machine token is missing. These tests pin all
// three so the agent's `void notifyHeightenedAuth(...)` calls stay
// safe even if the API is down or the user is running without a
// machine token (BYOK mode).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyHeightenedAuth } from "../notify-api.js";

describe("notifyHeightenedAuth", () => {
  const origToken = process.env.TRUSTY_SQUIRE_MACHINE_TOKEN;
  const origBase = process.env.TRUSTY_SQUIRE_API_BASE;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (origToken === undefined) delete process.env.TRUSTY_SQUIRE_MACHINE_TOKEN;
    else process.env.TRUSTY_SQUIRE_MACHINE_TOKEN = origToken;
    if (origBase === undefined) delete process.env.TRUSTY_SQUIRE_API_BASE;
    else process.env.TRUSTY_SQUIRE_API_BASE = origBase;
  });

  it("no-ops without a machine token", async () => {
    delete process.env.TRUSTY_SQUIRE_MACHINE_TOKEN;
    const ok = await notifyHeightenedAuth({
      service: "IPInfo",
      digit: "8",
      windowSeconds: 120,
    });
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs digit + service to the configured API base with bearer auth", async () => {
    process.env.TRUSTY_SQUIRE_MACHINE_TOKEN = "tsm_test_token";
    process.env.TRUSTY_SQUIRE_API_BASE = "https://api.example.com";
    fetchMock.mockResolvedValue({ ok: true });

    const ok = await notifyHeightenedAuth({
      service: "IPInfo",
      digit: "42",
      windowSeconds: 120,
    });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/notify/heightened-auth");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer tsm_test_token",
    });
    expect(JSON.parse(init.body)).toEqual({
      service: "IPInfo",
      digit: "42",
      window_seconds: 120,
    });
  });

  it("returns false on a 5xx response", async () => {
    process.env.TRUSTY_SQUIRE_MACHINE_TOKEN = "tsm_test_token";
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    const ok = await notifyHeightenedAuth({
      service: "IPInfo",
      digit: "8",
      windowSeconds: 120,
    });
    expect(ok).toBe(false);
  });

  it("swallows network errors and returns false", async () => {
    process.env.TRUSTY_SQUIRE_MACHINE_TOKEN = "tsm_test_token";
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const ok = await notifyHeightenedAuth({
      service: "IPInfo",
      digit: "8",
      windowSeconds: 120,
    });
    expect(ok).toBe(false);
  });

  it("transmits digit:null for the unreadable-challenge branch", async () => {
    process.env.TRUSTY_SQUIRE_MACHINE_TOKEN = "tsm_test_token";
    fetchMock.mockResolvedValue({ ok: true });
    await notifyHeightenedAuth({
      service: "IPInfo",
      digit: null,
      windowSeconds: 120,
    });
    const init = fetchMock.mock.calls[0]![1];
    expect(JSON.parse(init.body).digit).toBeNull();
  });

  it("falls back to the production API base when not configured", async () => {
    process.env.TRUSTY_SQUIRE_MACHINE_TOKEN = "tsm_test_token";
    delete process.env.TRUSTY_SQUIRE_API_BASE;
    fetchMock.mockResolvedValue({ ok: true });
    await notifyHeightenedAuth({
      service: "IPInfo",
      digit: "8",
      windowSeconds: 120,
    });
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://trusty-squire-api.fly.dev/v1/notify/heightened-auth");
  });

  it("rc.13 — uses the param machineToken + apiBase over env (session.json path)", async () => {
    // The MCP install writes machine_token to ~/.config/trusty-squire/
    // session.json and does NOT export it as an env var. tools/
    // provision-any.ts plumbs it as a param. Param must win.
    delete process.env.TRUSTY_SQUIRE_MACHINE_TOKEN;
    delete process.env.TRUSTY_SQUIRE_API_BASE;
    fetchMock.mockResolvedValue({ ok: true });

    const ok = await notifyHeightenedAuth({
      service: "Resend",
      digit: "39",
      windowSeconds: 120,
      machineToken: "tsm_from_session",
      apiBase: "https://session-api.example.com",
    });

    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://session-api.example.com/v1/notify/heightened-auth");
    expect(init.headers.authorization).toBe("Bearer tsm_from_session");
  });

  it("rc.13 — param machineToken takes precedence over env token", async () => {
    // Both set: param wins. Guards against the dev path (env-set)
    // overriding session.json's token when a caller plumbs it.
    process.env.TRUSTY_SQUIRE_MACHINE_TOKEN = "tsm_from_env";
    fetchMock.mockResolvedValue({ ok: true });

    await notifyHeightenedAuth({
      service: "Resend",
      digit: "39",
      windowSeconds: 120,
      machineToken: "tsm_from_param",
    });

    const init = fetchMock.mock.calls[0]![1];
    expect(init.headers.authorization).toBe("Bearer tsm_from_param");
  });
});
