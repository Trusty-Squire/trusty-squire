import { symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerPrincipal } from "../bot/broker/authority.js";
import { BrokerRefusal } from "../bot/broker/refusal.js";
import { listenBroker } from "../bot/broker/transport.js";
import { CHROME_PROFILE_DIR, profilePathIdentity } from "../bot/profile.js";
import { openSessionStorage } from "../session.js";
import {
  BrowserBusy,
  BrowserNeedsUser,
  browserBusy,
  openTab,
  UnservableProfileError,
} from "../browser-busy.js";

interface WireCall {
  method: string;
  params: Record<string, unknown>;
}

/** Real IPC and the real Contract B framing; only the broker's work is stubbed. */
async function listenAsBroker(
  socket: string,
  answer: (call: WireCall) => unknown,
): Promise<{ calls: WireCall[]; close: () => Promise<void> }> {
  const calls: WireCall[] = [];
  const listener = await listenBroker(socket, {
    authenticate: async (): Promise<Omit<BrokerPrincipal, "clientId">> => ({
      accountId: "account",
      agentId: "agent",
    }),
    call: async (_principal, method, params) => {
      calls.push({ method, params });
      return answer({ method, params });
    },
    disconnect: async () => undefined,
  });
  return { calls, close: async () => await listener.close() };
}

function servedProfile(): string {
  return profilePathIdentity(CHROME_PROFILE_DIR);
}

function expectBusy(error: unknown): BrowserBusy {
  expect(error).toBeInstanceOf(BrowserBusy);
  if (!(error instanceof BrowserBusy)) throw new Error("expected BrowserBusy");
  return error;
}

let root: string;
let socket: string;
let running: { calls: WireCall[]; close: () => Promise<void> } | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ts-browser-busy-"));
  socket = join(root, "broker.sock");
  process.env.TRUSTY_SQUIRE_BROKER_SOCKET = socket;
  await mkdir(servedProfile(), { recursive: true });
  // wireAcquire and the status read both bind the enrolled account first; the
  // test setup sandboxes XDG_CONFIG_HOME, so this writes a throwaway session.
  await (
    await openSessionStorage()
  ).write({
    api_base_url: "http://unused.test",
    saved_at: new Date().toISOString(),
    account_id: "account",
    agent_session_token: "token",
  });
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  delete process.env.TRUSTY_SQUIRE_BROKER_SOCKET;
  await rm(servedProfile(), { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

async function broker(answer: (call: WireCall) => unknown): Promise<WireCall[]> {
  running = await listenAsBroker(socket, answer);
  return running.calls;
}

describe("openTab over the real broker wire", () => {
  it("opens, navigates and closes one session with the frames Contract B defines", async () => {
    const calls = await broker(({ method }) => {
      if (method === "open") return { sessionId: "sess-1", observation: { session_id: "sess-1" } };
      if (method === "command") return { result: { url: "https://example.test/" } };
      return { closed: true };
    });

    const tab = await openTab({ profile: "default", purpose: "signup:vercel" });
    expect(tab.purpose).toBe("signup:vercel");
    expect(tab.profile).toBe(servedProfile());
    await tab.page.goto("https://example.test/");
    await tab.release();
    await tab.release();

    // `connect` is the transport's own handshake and never reaches the port.
    expect(calls.map((call) => call.method)).toEqual(["open", "command", "close"]);
    expect(calls[0]?.params).toEqual({ serviceUrl: "about:blank" });
    expect(calls[1]?.params).toEqual({
      sessionId: "sess-1",
      name: "operate_navigate",
      args: { session_id: "sess-1", url: "https://example.test/" },
    });
    expect(calls[2]?.params).toEqual({
      sessionId: "sess-1",
      args: { session_id: "sess-1" },
    });
  });

  it("maps each not-now refusal from the wire onto its layer, with an action", async () => {
    const cases = [
      { code: "profile_busy", layer: "profile" },
      { code: "maintenance", layer: "maintenance" },
      { code: "broker_unavailable", layer: "custody" },
      { code: "incompatible_runtime", layer: "custody" },
      { code: "launch_timeout", layer: "custody" },
    ];
    for (const { code, layer } of cases) {
      await running?.close();
      await broker(({ method }) => {
        if (method === "open") throw new BrokerRefusal(code, `${code} from wire`);
        return { closed: true };
      });
      await expect(openTab({ profile: "default", purpose: "signup:vercel" })).rejects.toSatisfy(
        (error: unknown) => {
          const busy = expectBusy(error);
          expect(busy.reason.layer).toBe(layer);
          expect(busy.reason.code).toBe(code);
          expect(busy.message).toBe(`${code} from wire`);
          expect(busy.action().length).toBeGreaterThan(0);
          return true;
        },
      );
    }
  });

  it("hands a permanent refusal back whole rather than calling it retry-later", async () => {
    for (const code of ["stale_lease", "cancelled", "unauthorized", "external_browser"]) {
      await running?.close();
      await broker(({ method }) => {
        if (method === "open") throw new BrokerRefusal(code, `${code} is permanent`);
        return { closed: true };
      });
      await expect(openTab({ profile: "default", purpose: "signup:vercel" })).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).not.toBeInstanceOf(BrowserBusy);
          expect(error).toBeInstanceOf(BrokerRefusal);
          expect((error as BrokerRefusal).code).toBe(code);
          return true;
        },
      );
    }
  });

  it("names reconnect when the broker hands the start back to the user", async () => {
    // googleSessionGate returns an observation with no owned session whenever
    // the bot profile has no live provider session — the likeliest first run.
    await broker(({ method }) => {
      if (method === "open") return { observation: { session_id: "x", needs_user: {} } };
      return { closed: true };
    });
    await expect(openTab({ profile: "default", purpose: "signup:vercel" })).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(BrowserNeedsUser);
        if (!(error instanceof BrowserNeedsUser)) throw new Error("expected needs-user");
        expect(error.action()).toContain("connect");
        return true;
      },
    );
  });

  it("refuses a profile this installation does not serve before any wire contact", async () => {
    const calls = await broker(() => ({ closed: true }));
    const other = await mkdtemp(join(tmpdir(), "ts-browser-busy-other-"));
    try {
      await expect(openTab({ profile: other, purpose: "signup:vercel" })).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).toBeInstanceOf(UnservableProfileError);
          expect(error).not.toBeInstanceOf(BrowserBusy);
          if (!(error instanceof UnservableProfileError)) throw new Error("expected refusal");
          expect(error.served).toBe(servedProfile());
          return true;
        },
      );
      expect(calls).toHaveLength(0);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("browserBusy asks the broker rather than inferring", () => {
  it("reports the layer the broker names, with the holder it saw", async () => {
    const calls = await broker(({ method }) =>
      method === "status"
        ? {
            busy: true,
            code: "profile_busy",
            detail: "The Chrome profile lease is already held",
            holder: { pid: 4242, host: hostname() },
          }
        : { closed: true },
    );
    const status = await browserBusy();
    expect(calls.map((call) => call.method)).toEqual(["status"]);
    expect(status).toEqual({
      busy: true,
      reason: {
        layer: "profile",
        code: "profile_busy",
        holder: { pid: 4242, host: hostname() },
      },
    });
    if (!status.busy) throw new Error("expected busy");
    expect(new BrowserBusy(status.reason).action()).toBe(
      "Close the other process using this Chrome profile (pid 4242), then retry.",
    );
  });

  it("reports maintenance, which no caller outside the broker can observe", async () => {
    // A live listener used to be read as "not busy"; across connect's
    // maintenance window that contradicted openTab at the same instant.
    await broker(({ method }) =>
      method === "status"
        ? {
            busy: true,
            code: "maintenance",
            detail: "Connect owns the browser maintenance window",
          }
        : { closed: true },
    );
    const status = await browserBusy();
    if (!status.busy) throw new Error("expected busy");
    expect(status.reason.layer).toBe("maintenance");
    expect(new BrowserBusy(status.reason).action()).toBe(
      "Finish the connect login window that owns maintenance, then retry.",
    );
  });

  it("is not busy when the broker says so", async () => {
    await broker(({ method }) => (method === "status" ? { busy: false } : { closed: true }));
    await expect(browserBusy()).resolves.toEqual({ busy: false });
  });

  it("never answers as if nothing runs when a broker is resident it cannot ask", async () => {
    // `logout` clears the session file without touching the running daemon.
    // Reading the profile lock here would report the broker's OWN Chrome as a
    // foreign process to close — the answer its `status` would have denied.
    await broker(() => ({ closed: true }));
    await (await openSessionStorage()).clear();
    symlinkSync(`${hostname()}-${process.pid}`, join(servedProfile(), "SingletonLock"));
    await expect(browserBusy()).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(BrowserNeedsUser);
      if (!(error instanceof BrowserNeedsUser)) throw new Error("expected needs-user");
      expect(error.action()).toContain("connect");
      return true;
    });
  });

  it("falls back to the profile lock when no broker is resident", async () => {
    symlinkSync(`${hostname()}-${process.pid}`, join(servedProfile(), "SingletonLock"));
    await expect(browserBusy()).resolves.toEqual({
      busy: true,
      reason: {
        layer: "profile",
        code: "profile_busy",
        holder: { pid: process.pid, host: hostname() },
      },
    });
  });

  it("reads free when no broker is resident and no process holds the profile", async () => {
    await expect(browserBusy()).resolves.toEqual({ busy: false });
  });
});
