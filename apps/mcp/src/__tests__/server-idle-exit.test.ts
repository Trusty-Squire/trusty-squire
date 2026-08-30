// A live box surfaced 33 accumulated `mcp server` processes, some holding
// live operator Chromes — the disconnect-triggered shutdown in server.ts
// (transport.onclose / stdin EOF / SIGTERM, covered by bin-smoke.test.ts)
// never fired because the host abandoned the child without closing its
// stdio or signaling it. shouldIdleExit is the pure decision function behind
// the time-bound backstop for that case.
//
// An open provision session owns its own Chrome and profile. A session left
// open by an abandoned server can only be freed by that server itself exiting.
// shouldIdleExit therefore
// uses a longer bound when a session is open rather than never exiting, but
// still applies real teardown (closeAllProvisionSessions, which kills the
// leased Chrome) once that longer bound is crossed.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { shouldReapOwner } from "../bot/owner-process-reaper.js";
import { shouldReapIdleProvisionSession } from "../bot/provision-session.js";
import { buildServer, createServerCallAdmission, shouldIdleExit } from "../server.js";

describe("server shutdown call admission", () => {
  it("closes admission before draining calls that already entered", async () => {
    const admission = createServerCallAdmission();
    expect(admission.started()).toBe(true);
    expect(admission.started()).toBe(true);

    let drained = false;
    const drain = admission.closeAndDrain().then(() => {
      drained = true;
    });

    expect(admission.started()).toBe(false);
    admission.finished();
    await Promise.resolve();
    expect(drained).toBe(false);
    admission.finished();
    await drain;
    expect(drained).toBe(true);
  });

  it("rejects a tool call that arrives after shutdown closes admission", async () => {
    const admission = createServerCallAdmission();
    const api = { setRequestingAgent: vi.fn() } as unknown as ApiClient;
    const server = await buildServer(api, admission);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "shutdown-admission-test", version: "1" });
    await client.connect(clientTransport);
    await admission.closeAndDrain();
    try {
      const result = await client.callTool({ name: "list_credentials", arguments: {} });
      const text = (result.content as Array<{ text?: string }>)
        .map((entry) => entry.text ?? "")
        .join("");
      expect(JSON.parse(text).error.code).toBe("server_unavailable");
      expect(api.setRequestingAgent).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});

describe("shouldIdleExit", () => {
  const timeoutMs = 1_000;
  const timeoutWithSessionMs = 5_000;

  it("stays false while activity is within the no-session timeout", () => {
    expect(shouldIdleExit(1_500, 1_000, 0, timeoutMs, timeoutWithSessionMs)).toBe(false);
  });

  it("goes true once idle time reaches the no-session timeout", () => {
    expect(shouldIdleExit(2_000, 1_000, 0, timeoutMs, timeoutWithSessionMs)).toBe(true);
  });

  it("stays false with an open session before the (longer) session timeout", () => {
    expect(shouldIdleExit(3_000, 1_000, 1, timeoutMs, timeoutWithSessionMs)).toBe(false);
  });

  it("goes true with an open session once the longer timeout is crossed", () => {
    expect(shouldIdleExit(6_000, 1_000, 1, timeoutMs, timeoutWithSessionMs)).toBe(true);
  });

  it("re-arms after fresh activity moves lastActivityAt forward", () => {
    expect(shouldIdleExit(2_000, 1_900, 0, timeoutMs, timeoutWithSessionMs)).toBe(false);
  });
});

describe("idle provision-session reap decision", () => {
  it("reaps only a terminally idle action boundary", () => {
    expect(shouldReapIdleProvisionSession(5_000, 1_000, 0, false, false, 4_000)).toBe(true);
  });

  it("never crosses an in-flight action boundary", () => {
    expect(shouldReapIdleProvisionSession(50_000, 1_000, 1, false, false, 4_000)).toBe(false);
  });

  it("never reaps an initializing or already-closing session", () => {
    expect(shouldReapIdleProvisionSession(50_000, 1_000, 0, true, false, 4_000)).toBe(false);
    expect(shouldReapIdleProvisionSession(50_000, 1_000, 0, false, true, 4_000)).toBe(false);
  });

  it("re-arms from the most recent completed activity", () => {
    expect(shouldReapIdleProvisionSession(5_000, 4_900, 0, false, false, 4_000)).toBe(false);
  });
});

describe("owner reap decision", () => {
  it("reaps only a birth-verified stale owner", () => {
    expect(shouldReapOwner("stale")).toBe(true);
    expect(shouldReapOwner("matching")).toBe(false);
    expect(shouldReapOwner("unknown")).toBe(false);
  });
});
