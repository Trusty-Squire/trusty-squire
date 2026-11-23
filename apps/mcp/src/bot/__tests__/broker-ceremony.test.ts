// The broker daemon owns connect's sign-in ceremony end to end. These pin the
// completion contract on server-side facts only: `/status` delivering the
// claim writes the session, `/status` reporting Finish closes the window, and
// nothing about it depends on the connect that asked still running.

import { describe, expect, it, vi } from "vitest";
import {
  BrokerCeremonyHost,
  operatorCeremonyTab,
  pollInstallStatus,
  type CeremonyHostDeps,
  type CeremonyStartRequest,
  type CeremonyTab,
  type InstallStatus,
} from "../broker/ceremony.js";
import { logoutProvidersThroughSession } from "../google-login.js";
import { controlLabelV2 } from "../compact-observation-v2.js";
import type { SessionData } from "../../session.js";

const CONFIRM_URL = "https://trustysquire.ai/install?token=code-1";
const VNC_URL = "https://tunnel.invalid/#p=pw";

function startRequest(overrides: Partial<CeremonyStartRequest> = {}): CeremonyStartRequest {
  return {
    action: "start",
    confirmUrl: CONFIRM_URL,
    setupCode: "code-1",
    apiBase: "https://api.invalid",
    ttlMs: 600_000,
    callerHasDisplay: false,
    finalize: {
      baseSession: { api_base_url: "https://api.invalid", saved_at: "2026-11-22T00:00:00.000Z" },
      applyServerPrefs: true,
      agentConfigs: [{ target: "codex", agentIdentity: "codex" }],
    },
    ...overrides,
  };
}

const CLAIMED: InstallStatus = {
  status: "claimed",
  agent_session_token: "agent-token",
  account_id: "acct-1",
  finished: false,
};

interface Harness {
  host: BrokerCeremonyHost;
  deps: CeremonyHostDeps;
  tabs: {
    commands: { name: string; args: Record<string, unknown> }[];
    close: ReturnType<typeof vi.fn>;
  }[];
  stopExposure: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
  writeAgentConfigs: ReturnType<typeof vi.fn>;
  statuses: InstallStatus[];
  setStatus: (status: InstallStatus | Error) => void;
  lines: string[];
  expired: { fire: (() => void) | null };
}

function harness(overrides: Partial<CeremonyHostDeps> = {}): Harness {
  let current: InstallStatus | Error = { status: "pending" };
  const statuses: InstallStatus[] = [];
  const tabs: Harness["tabs"] = [];
  const stopExposure = vi.fn(async () => undefined);
  const lines: string[] = [];
  const expired: Harness["expired"] = { fire: null };
  const session: SessionData = {
    api_base_url: "https://api.invalid",
    saved_at: "t",
    agent_session_token: "agent-token",
    account_id: "acct-1",
  };
  const finalize = vi.fn<CeremonyHostDeps["finalize"]>(async () => session);
  const writeAgentConfigs = vi.fn<CeremonyHostDeps["writeAgentConfigs"]>(async () => undefined);
  const deps: CeremonyHostDeps = {
    profileDir: "/profiles/fixture",
    openTab: async () => {
      const tab = {
        commands: [] as { name: string; args: Record<string, unknown> }[],
        close: vi.fn(async () => undefined),
      };
      tabs.push(tab);
      return {
        command: async (name, args) => {
          tab.commands.push({ name, args });
          return name === "operate_ceremony_window" && args.action === "show_phone"
            ? { left: 0, top: 0, width: 400, height: 800 }
            : { ok: true };
        },
        close: tab.close,
      } satisfies CeremonyTab;
    },
    logoutProviders: vi.fn(async () => undefined),
    expose: async ({ onExpired, windowControl }) => {
      expired.fire = onExpired;
      await windowControl.showPhone();
      return { kind: "exposed", url: VNC_URL, stop: stopExposure };
    },
    pollStatus: async () => {
      if (current instanceof Error) throw current;
      statuses.push(current);
      // The token is delivered exactly once, like the real route.
      const answer = current;
      if (current.status === "claimed")
        current = { status: "delivered", finished: current.finished };
      return answer;
    },
    finalize,
    writeAgentConfigs,
    detectProviders: async () => ["google"],
    log: (line) => lines.push(line),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    ...overrides,
  };
  return {
    host: new BrokerCeremonyHost(deps),
    deps,
    tabs,
    stopExposure,
    finalize,
    writeAgentConfigs,
    statuses,
    setStatus: (status) => {
      current = status;
    },
    lines,
    expired,
  };
}

describe("broker-owned connect ceremony", () => {
  it("writes the session on the claim and closes the window only on Finish", async () => {
    const h = harness();
    const view = await h.host.call(startRequest());
    expect(view).toEqual({
      state: "live",
      confirm_url: CONFIRM_URL,
      browser_location: { kind: "virtual", url: VNC_URL },
      reused: false,
    });
    expect(h.tabs).toHaveLength(1);

    h.setStatus(CLAIMED);
    await vi.waitFor(() => expect(h.finalize).toHaveBeenCalledTimes(1));
    expect(h.finalize).toHaveBeenCalledWith(
      startRequest().finalize,
      { token: "agent-token", account_id: "acct-1" },
      "/profiles/fixture",
    );
    // Claimed, not finished: the person may still be on the optional GitHub
    // step, so the window stays up.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.stopExposure).not.toHaveBeenCalled();
    expect(h.tabs[0]!.close).not.toHaveBeenCalled();
    expect(h.host.current()).toMatchObject({ state: "live" });

    h.setStatus({ status: "delivered", finished: true });
    await vi.waitFor(() => expect(h.tabs[0]!.close).toHaveBeenCalledTimes(1));
    expect(h.stopExposure).toHaveBeenCalledTimes(1);
    // Helpers go before the tab: they are the daemon's own children.
    expect(h.stopExposure.mock.invocationCallOrder[0]).toBeLessThan(
      h.tabs[0]!.close.mock.invocationCallOrder[0]!,
    );
    expect(h.finalize).toHaveBeenCalledTimes(1);
    expect(h.host.current()).toEqual({ state: "none" });
  });

  it("completes when Finish was pressed before the first poll delivered the token", async () => {
    const h = harness();
    h.setStatus({ ...CLAIMED, finished: true });
    await h.host.call(startRequest());
    await vi.waitFor(() => expect(h.tabs[0]!.close).toHaveBeenCalled());
    expect(h.finalize).toHaveBeenCalledTimes(1);
  });

  it("retains an early Finish claim until its failed finalization succeeds", async () => {
    let release!: () => void;
    const retry = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness();
    h.finalize.mockRejectedValueOnce(new Error("disk unavailable"));
    h.finalize.mockImplementationOnce(async () => {
      await retry;
      return { api_base_url: "https://api.invalid", saved_at: "t", account_id: "acct-1" };
    });
    h.setStatus({ ...CLAIMED, finished: true });
    await h.host.call(startRequest());
    await vi.waitFor(() => expect(h.finalize).toHaveBeenCalledTimes(2));
    expect(h.tabs[0]!.close).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(h.tabs[0]!.close).toHaveBeenCalledOnce());
    expect(h.statuses.filter((status) => status.status === "claimed")).toHaveLength(1);
  });

  it("lands config plans joining during finalization and config draining", async () => {
    let release!: () => void;
    let releaseWrite!: () => void;
    const finalizing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const h = harness();
    h.finalize.mockImplementationOnce(async () => {
      await finalizing;
      return { api_base_url: "https://api.invalid", saved_at: "t", account_id: "acct-1" };
    });
    h.writeAgentConfigs.mockImplementationOnce(async () => {
      await writing;
    });
    h.setStatus({ ...CLAIMED, finished: true });
    await h.host.call(startRequest());
    await vi.waitFor(() => expect(h.finalize).toHaveBeenCalledOnce());
    const hermes = { target: "hermes", configPath: "/custom/hermes.yaml" } as const;
    await h.host.call({ action: "join", agentConfigs: [hermes] });
    release();
    await vi.waitFor(() => expect(h.writeAgentConfigs).toHaveBeenCalledOnce());
    const codex = { target: "codex", configPath: "/custom/codex.toml" } as const;
    await h.host.call({ action: "join", agentConfigs: [codex] });
    expect(h.tabs[0]!.close).not.toHaveBeenCalled();
    releaseWrite();
    await vi.waitFor(() => expect(h.tabs[0]!.close).toHaveBeenCalledOnce());
    expect(h.writeAgentConfigs.mock.calls.map(([configs]) => configs)).toEqual([[hermes], [codex]]);
  });

  it("retains a delayed single-use claim without overlapping polls", async () => {
    vi.useFakeTimers();
    let delayed: Harness | undefined;
    try {
      let deliver!: (status: InstallStatus) => void;
      const response = new Promise<InstallStatus>((resolve) => {
        deliver = resolve;
      });
      const pollStatus = vi.fn(async () => await response);
      delayed = harness({ pollStatus });
      await delayed.host.call(startRequest());
      await vi.advanceTimersByTimeAsync(15_001);
      expect(pollStatus).toHaveBeenCalledOnce();
      expect(delayed.finalize).not.toHaveBeenCalled();
      deliver({ ...CLAIMED, finished: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(delayed.tabs[0]!.close).toHaveBeenCalledOnce();
      expect(pollStatus).toHaveBeenCalledOnce();
      expect(delayed.finalize).toHaveBeenCalledWith(
        expect.anything(),
        {
          token: "agent-token",
          account_id: "acct-1",
        },
        "/profiles/fixture",
      );
    } finally {
      await delayed?.host.shutdown();
      vi.useRealTimers();
    }
  });

  it("closes at expiry even while the only status poll is stalled", async () => {
    const pollStatus = vi.fn(() => new Promise<InstallStatus>(() => undefined));
    const h = harness({ pollStatus });
    await h.host.call(startRequest({ ttlMs: 30 }));
    await vi.waitFor(() => expect(h.tabs[0]!.close).toHaveBeenCalledOnce());
    expect(pollStatus).toHaveBeenCalledOnce();
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it("serializes reconnects behind both helper and tab teardown", async () => {
    let releaseHelpers!: () => void;
    let releaseTab!: () => void;
    const helpers = new Promise<void>((resolve) => {
      releaseHelpers = resolve;
    });
    const tab = new Promise<void>((resolve) => {
      releaseTab = resolve;
    });
    const h = harness();
    await h.host.call(startRequest());
    h.stopExposure.mockImplementationOnce(async () => {
      await helpers;
    });
    h.tabs[0]!.close.mockImplementationOnce(async () => {
      await tab;
    });
    h.setStatus({ status: "expired" });
    await vi.waitFor(() => expect(h.stopExposure).toHaveBeenCalledOnce());
    expect(h.host.current()).toEqual({ state: "none" });
    const join = h.host.call({ action: "join", agentConfigs: [{ target: "hermes" }] });
    await Promise.resolve();
    const first = h.host.call(startRequest({ setupCode: "next-code" }));
    const second = h.host.call(startRequest({ setupCode: "concurrent-code" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.tabs).toHaveLength(1);
    releaseHelpers();
    await vi.waitFor(() => expect(h.tabs[0]!.close).toHaveBeenCalledOnce());
    expect(h.tabs).toHaveLength(1);
    h.setStatus({ status: "pending" });
    releaseTab();
    await expect(join).resolves.toEqual({ state: "none" });
    const [opened, reused] = await Promise.all([first, second]);
    expect(opened).toMatchObject({ state: "live", reused: false });
    expect(reused).toMatchObject({ state: "live", reused: true });
    expect(h.tabs).toHaveLength(2);
    await h.host.shutdown();
  });

  it("hands a second connect the same window instead of opening a competing tab", async () => {
    const h = harness();
    const first = await h.host.call(startRequest());
    const second = await h.host.call(
      startRequest({
        confirmUrl: "https://trustysquire.ai/install?token=code-2",
        setupCode: "code-2",
        finalize: {
          ...startRequest().finalize,
          agentConfigs: [{ target: "claude-code" }],
        },
      }),
    );
    expect(h.tabs).toHaveLength(1);
    expect(second).toEqual({ ...first, reused: true });
    expect(await h.host.call({ action: "get" })).toEqual(first);

    // The joined host agent's config is written with the same claim.
    h.setStatus(CLAIMED);
    await vi.waitFor(() => expect(h.finalize).toHaveBeenCalled());
    const [plan] = h.finalize.mock.calls[0] as unknown as [CeremonyStartRequest["finalize"]];
    expect(plan.agentConfigs.map((config) => config.target)).toEqual(["codex", "claude-code"]);
  });

  it("writes a late joiner's config at once when the claim already landed", async () => {
    const h = harness();
    await h.host.call(startRequest());
    h.setStatus(CLAIMED);
    await vi.waitFor(() => expect(h.finalize).toHaveBeenCalled());
    await h.host.call(
      startRequest({
        finalize: { ...startRequest().finalize, agentConfigs: [{ target: "goose" }] },
      }),
    );
    expect(h.writeAgentConfigs).toHaveBeenCalledWith(
      [{ target: "goose" }],
      expect.objectContaining({ account_id: "acct-1" }),
    );
  });

  it("opens one tab for two connects that start at the same moment", async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.host.call(startRequest()),
      h.host.call(startRequest({ setupCode: "code-2" })),
    ]);
    expect(h.tabs).toHaveLength(1);
    expect(a).toMatchObject({ state: "live", confirm_url: CONFIRM_URL });
    expect(b).toMatchObject({ state: "live", confirm_url: CONFIRM_URL, reused: true });
  });

  it("keeps polling through a failed status request", async () => {
    const h = harness();
    h.setStatus(new Error("network down"));
    await h.host.call(startRequest());
    await vi.waitFor(() =>
      expect(h.lines.some((line) => line.includes("network down"))).toBe(true),
    );
    h.setStatus({ ...CLAIMED, finished: true });
    await vi.waitFor(() => expect(h.tabs[0]!.close).toHaveBeenCalled());
    expect(h.finalize).toHaveBeenCalledTimes(1);
  });

  it("retries landing a delivered claim whose first write failed", async () => {
    const h = harness();
    h.finalize.mockRejectedValueOnce(new Error("disk full"));
    await h.host.call(startRequest());
    h.setStatus(CLAIMED);
    await vi.waitFor(() => expect(h.finalize).toHaveBeenCalledTimes(2));
    expect(h.lines.some((line) => line.includes("disk full"))).toBe(true);
    // The retry used the claim from the single delivery.
    expect(h.statuses.filter((status) => status.status === "claimed")).toHaveLength(1);
  });

  it("closes the window when the install link expires unclaimed", async () => {
    const h = harness();
    await h.host.call(startRequest());
    h.setStatus({ status: "expired" });
    await vi.waitFor(() => expect(h.tabs[0]!.close).toHaveBeenCalled());
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.lines.at(-1)).toMatch(/expired.*no session was written/);
  });

  it("closes the window at the pairing deadline even without Finish", async () => {
    let now = 1_000;
    const h = harness({ now: () => now });
    await h.host.call(startRequest({ ttlMs: 50 }));
    h.setStatus(CLAIMED);
    await vi.waitFor(() => expect(h.finalize).toHaveBeenCalled());
    now += 51;
    await vi.waitFor(() => expect(h.tabs[0]!.close).toHaveBeenCalled());
    expect(h.host.current()).toEqual({ state: "none" });
  });

  it("keeps a GitHub refresh open after Finish until the session reaches the profile", async () => {
    let providers: string[] = ["google"];
    const h = harness({ detectProviders: async () => providers as ("google" | "github")[] });
    await h.host.call(startRequest({ requestedProvider: "github" }));
    h.setStatus({ ...CLAIMED, finished: true });
    await vi.waitFor(() => expect(h.finalize).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.tabs[0]!.close).not.toHaveBeenCalled();
    providers = ["google", "github"];
    await vi.waitFor(() => expect(h.tabs[0]!.close).toHaveBeenCalled());
  });

  it("signs old providers out in the ceremony tab before exposing it", async () => {
    const logoutProviders = vi.fn(async () => undefined);
    const h = harness({ logoutProviders });
    await h.host.call(startRequest({ forceReloginProviders: ["google", "github"] }));
    expect(logoutProviders).toHaveBeenCalledWith(expect.anything(), CONFIRM_URL, [
      "google",
      "github",
    ]);
  });

  it("reports a tab nothing can show as unshowable and closes it", async () => {
    const h = harness({
      expose: async () => ({ kind: "unshowable", reason: "no x11vnc on PATH" }),
    });
    await expect(h.host.call(startRequest())).resolves.toEqual({
      state: "unshowable",
      confirm_url: CONFIRM_URL,
      reason: "no x11vnc on PATH",
    });
    expect(h.tabs[0]!.close).toHaveBeenCalled();
    expect(h.host.current()).toEqual({ state: "none" });
  });

  it("reports a tab on the caller's own screen as host_screen", async () => {
    const h = harness({
      expose: async () => ({ kind: "already_visible", reason: "own screen" }),
    });
    await expect(h.host.call(startRequest({ callerHasDisplay: true }))).resolves.toMatchObject({
      state: "live",
      browser_location: { kind: "host_screen" },
    });
  });

  // The rig runs in the daemon, but the tunnel is the one named in the
  // environment of the connect the person ran.
  it("exposes the display through connect's own named tunnel", async () => {
    const expose = vi.fn<CeremonyHostDeps["expose"]>(async () => ({
      kind: "exposed",
      url: "https://login.example.test/#p=pw",
      stop: async () => undefined,
    }));
    const h = harness({ expose });
    await h.host.call(
      startRequest({ namedTunnel: { hostname: "login.example.test", port: 6080 } }),
    );
    expect(expose.mock.calls[0]![0]).toMatchObject({
      namedTunnel: { hostname: "login.example.test", port: 6080 },
      callerHasDisplay: false,
    });
  });

  it("ends the ceremony when the rig's own lifetime backstop fires", async () => {
    const h = harness();
    await h.host.call(startRequest());
    h.expired.fire?.();
    await vi.waitFor(() => expect(h.tabs[0]!.close).toHaveBeenCalled());
    expect(h.host.current()).toEqual({ state: "none" });
  });

  it("closes a live window when the broker shuts down", async () => {
    const h = harness();
    await h.host.call(startRequest());
    await h.host.shutdown();
    expect(h.stopExposure).toHaveBeenCalled();
    expect(h.tabs[0]!.close).toHaveBeenCalled();
  });

  it("rejects a malformed request before opening anything", async () => {
    const h = harness();
    await expect(h.host.call({ action: "start", confirmUrl: "not a url" })).rejects.toThrow();
    expect(h.tabs).toHaveLength(0);
  });
});

describe("pollInstallStatus", () => {
  const respond = (status: number, body: unknown): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

  it("reads the claim, its preferences and Finish", async () => {
    await expect(
      pollInstallStatus(
        "https://api.invalid",
        "c",
        respond(200, {
          status: "claimed",
          agent_session_token: "tok",
          account_id: "acct",
          install_preferences: { registry_enabled: true },
          finished: true,
        }),
      ),
    ).resolves.toEqual({
      status: "claimed",
      agent_session_token: "tok",
      account_id: "acct",
      install_preferences: { registry_enabled: true },
      finished: true,
    });
  });

  it("reads a delivered record's Finish and a 410 as expired", async () => {
    await expect(
      pollInstallStatus(
        "https://api.invalid",
        "c",
        respond(200, { status: "delivered", finished: false }),
      ),
    ).resolves.toEqual({ status: "delivered", finished: false });
    await expect(
      pollInstallStatus("https://api.invalid", "c", respond(410, { status: "expired" })),
    ).resolves.toEqual({ status: "expired" });
    await expect(
      pollInstallStatus("https://api.invalid", "c", respond(200, { status: "pending" })),
    ).resolves.toEqual({ status: "pending" });
  });

  it("throws on a server error so the ceremony retries", async () => {
    await expect(pollInstallStatus("https://api.invalid", "c", respond(503, {}))).rejects.toThrow(
      /HTTP 503/,
    );
  });
});

describe("operatorCeremonyTab", () => {
  function fakeOperator(opened: { sessionId?: string; observation?: unknown }) {
    return {
      open: vi.fn(async () => ({ observation: {}, ...opened })),
      command: vi.fn(async () => ({ result: { url: CONFIRM_URL } })),
      closeSession: vi.fn(async () => ({ closed: true })),
      disconnect: vi.fn(async () => undefined),
    };
  }

  it("opens the confirm page as a ceremony session and drives it with its own id", async () => {
    const operator = fakeOperator({ sessionId: "s-1" });
    const tab = await operatorCeremonyTab(operator as never)(CONFIRM_URL);
    expect(operator.open).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "connect-ceremony" }),
      { serviceUrl: CONFIRM_URL, ceremony: true },
      expect.any(String),
    );
    await expect(tab.command("operate_observe", {})).resolves.toEqual({ url: CONFIRM_URL });
    expect(operator.command).toHaveBeenCalledWith(
      expect.anything(),
      { sessionId: "s-1", name: "operate_observe", args: { session_id: "s-1" } },
      expect.any(String),
    );
    await tab.close();
    expect(operator.closeSession).toHaveBeenCalledWith(
      expect.anything(),
      { sessionId: "s-1" },
      expect.any(String),
    );
    expect(operator.disconnect).toHaveBeenCalledWith(expect.anything(), true);
  });

  it("fails at once, in the broker's own words, when no live session was minted", async () => {
    const operator = fakeOperator({
      observation: { session_id: "obs", guidance: "No live Google session — sign in first" },
    });
    const error = await operatorCeremonyTab(operator as never)(CONFIRM_URL).catch(
      (err: unknown) => err as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("opened no ceremony tab");
    expect((error as Error).message).toContain("No live Google session — sign in first");
    expect((error as Error).message).toContain("broker.log");
    expect(operator.disconnect).toHaveBeenCalled();
  });
});

describe("logoutProvidersThroughSession", () => {
  it("drives the deferred --force-relogin logout through the ceremony tab's own commands", async () => {
    const signOut = controlLabelV2("Sign out")!;
    const commands: { name: string; args: Record<string, unknown> }[] = [];
    await logoutProvidersThroughSession(
      {
        command: async (name, args) => {
          commands.push({ name, args });
          // Rows travel the REAL wire shape — positional tuples [ref, role,
          // facts?] with a wire role letter and the @slug alias first.
          return name === "operate_observe" ? { safe_table: [[signOut, "b", signOut]] } : {};
        },
      },
      CONFIRM_URL,
      ["google", "github"],
    );
    expect(commands).toEqual([
      { name: "operate_navigate", args: { url: "https://accounts.google.com/Logout" } },
      { name: "operate_navigate", args: { url: "https://github.com/logout" } },
      { name: "operate_observe", args: {} },
      { name: "operate_click", args: { ref: signOut } },
      { name: "operate_navigate", args: { url: CONFIRM_URL } },
    ]);
  });
});
