// The connect sign-in ceremony, owned end to end by the broker daemon.
//
// `connect` used to host the ceremony itself: it opened the tab, ran the noVNC
// helpers as its own children, polled the install claim, and learned about
// Finish from a loopback callback or by observing the tab. Every one of those
// lived inside a foreground command that an agent's bounded tool call can end,
// freeze or re-run mid-sign-in, and Chrome's Local Network Access gate blocks
// the loopback callback outright. So the daemon — already the long-lived owner
// of Chrome and the display — runs it instead, and completes on server-side
// facts only: `/status` delivers the claim (the daemon writes the session) and
// reports the person's Finish (the daemon closes the window). `connect` asks
// for the ceremony, prints where it is, and returns.
//
// One ceremony at a time per broker. A second `connect` while it is live gets
// the same sign-in back instead of a competing tab on the same display.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CeremonyDisplayClip } from "../ceremony-window.js";
import type { CeremonyBrowserPlacement, SharedCeremonyExposure } from "../google-login.js";
import type { OAuthProviderId } from "../oauth-providers.js";
import type { SessionData } from "../../session.js";
import {
  ceremonyFinalizePlanSchema,
  agentConfigPlanSchema,
  type AgentConfigPlan,
  type CeremonyFinalizePlan,
  type InstallClaim,
} from "../../install/ceremony-finalize.js";
import type { OperatorBroker } from "./operator.js";

const oauthProvider = z.enum(["google", "github"]);

export const ceremonyStartSchema = z
  .object({
    action: z.literal("start"),
    confirmUrl: z.string().url(),
    setupCode: z.string().min(1),
    apiBase: z.string().url(),
    // What is left of the pairing token's life, counted by connect from the
    // moment its initiate response arrived (never a wall-clock difference).
    ttlMs: z.number().int().positive(),
    // Whether the person running connect is at the machine's own screen. Only
    // connect can answer that; the daemon's environment cannot.
    callerHasDisplay: z.boolean(),
    // The person's own tunnel (TS_LOGIN_PUBLIC_HOSTNAME / TS_LOGIN_LOCAL_PORT),
    // read from connect's environment. Absent: the daemon's own, or a quick
    // tunnel.
    namedTunnel: z
      .object({ hostname: z.string().min(1), port: z.number().int().min(1).max(65_535) })
      .strict()
      .optional(),
    // Present only for `--force-relogin=github`: the window stays open until
    // the GitHub session reaches the profile, not only until Finish.
    requestedProvider: z.literal("github").optional(),
    // Old provider sessions to sign out in the ceremony tab first, because
    // the standalone cookie clear found the profile busy.
    forceReloginProviders: z.array(oauthProvider).optional(),
    finalize: ceremonyFinalizePlanSchema,
  })
  .strict();
export type CeremonyStartRequest = z.infer<typeof ceremonyStartSchema>;

const ceremonyRequestSchema = z.union([
  ceremonyStartSchema,
  z.object({ action: z.literal("get") }).strict(),
  z.object({ action: z.literal("join"), agentConfigs: z.array(agentConfigPlanSchema).min(1) }).strict(),
]);
export type CeremonyRequest = z.infer<typeof ceremonyRequestSchema>;

/** What a ceremony call answers. */
export type CeremonyView =
  | { state: "none" }
  | {
      state: "live";
      confirm_url: string;
      browser_location: Exclude<CeremonyBrowserPlacement, { kind: "unreachable" }>;
      // True when this call joined a ceremony that was already running.
      reused: boolean;
    }
  // The tab opened but nothing here can show it to anyone.
  | { state: "unshowable"; confirm_url: string; reason: string };

/** The `/status` answers the ceremony acts on. */
export type InstallStatus =
  | { status: "pending" }
  | { status: "expired" }
  | {
      status: "claimed";
      agent_session_token: string;
      account_id: string;
      install_preferences?: InstallClaim["preferences"];
      finished: boolean;
    }
  | { status: "delivered"; finished: boolean };

/** The broker session tab the ceremony runs in. */
export interface CeremonyTab {
  command(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface CeremonyHostDeps {
  profileDir: string;
  openTab(url: string): Promise<CeremonyTab>;
  logoutProviders(
    tab: CeremonyTab,
    confirmUrl: string,
    providers: readonly OAuthProviderId[],
  ): Promise<void>;
  expose(input: {
    profileDir: string;
    callerHasDisplay: boolean;
    namedTunnel?: { hostname: string; port: number };
    onExpired: () => void;
    windowControl: { showPhone: () => Promise<CeremonyDisplayClip>; restore: () => Promise<void> };
  }): Promise<SharedCeremonyExposure>;
  pollStatus(apiBase: string, setupCode: string): Promise<InstallStatus>;
  finalize(
    plan: CeremonyFinalizePlan,
    claim: InstallClaim,
    profileDir: string,
  ): Promise<SessionData>;
  writeAgentConfigs(configs: readonly AgentConfigPlan[], session: SessionData): Promise<void>;
  detectProviders(profileDir: string): Promise<readonly OAuthProviderId[]>;
  log(line: string): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

interface LiveCeremony {
  request: CeremonyStartRequest;
  finalize: CeremonyFinalizePlan;
  view: Extract<CeremonyView, { state: "live" }>;
  tab: CeremonyTab;
  stopExposure: (() => Promise<void>) | null;
  deadline: number;
  claim: InstallClaim | null;
  session: SessionData | null;
  ended: Promise<void> | null;
}

const POLL_INTERVAL_MS = 3_000;

function sameConfig(a: AgentConfigPlan, b: AgentConfigPlan): boolean {
  return (
    a.target === b.target && a.configPath === b.configPath &&
    a.agentIdentity === b.agentIdentity && a.profileDir === b.profileDir
  );
}

function validClip(clip: unknown): clip is CeremonyDisplayClip {
  if (clip === null || typeof clip !== "object") return false;
  const record = clip as Record<string, unknown>;
  return (
    ["left", "top", "width", "height"].every((key) => Number.isInteger(record[key])) &&
    (record.left as number) >= 0 &&
    (record.top as number) >= 0 &&
    (record.width as number) > 0 &&
    (record.height as number) > 0
  );
}

export class BrokerCeremonyHost {
  private live: LiveCeremony | null = null;
  private starting: Promise<CeremonyView> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;

  constructor(private readonly deps: CeremonyHostDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  /** The broker wire's `ceremony` method. */
  async call(params: Record<string, unknown>): Promise<CeremonyView> {
    const request = ceremonyRequestSchema.parse(params);
    if (request.action === "get") return this.current();
    if (request.action === "join") {
      await this.starting?.catch(() => undefined);
      while (this.live?.ended) await this.live.ended;
      return this.live === null ? { state: "none" } : await this.join(this.live, request.agentConfigs);
    }
    return await this.start(request);
  }

  current(): CeremonyView {
    return this.live === null || this.live.ended !== null ? { state: "none" } : this.live.view;
  }

  /** Start the ceremony, or join the one already running. */
  async start(request: CeremonyStartRequest): Promise<CeremonyView> {
    while (this.live?.ended) await this.live.ended;
    if (this.live !== null) {
      return await this.join(this.live, request.finalize.agentConfigs, request.finalize.twoCaptchaKey);
    }
    if (this.starting !== null) {
      const view = await this.starting.catch(() => null);
      if (view !== null && view.state === "unshowable") return view;
      return await this.start(request);
    }
    const starting = this.open(request);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  /** Daemon stop: close the window and the tab with it. */
  async shutdown(): Promise<void> {
    await this.starting?.catch(() => undefined);
    if (this.live !== null) await this.end(this.live, "broker shutting down");
  }

  // A later connect may be for another host agent; its config is written with
  // the same claim. Its other choices do not override the running ceremony.
  private async join(
    live: LiveCeremony, configs: readonly AgentConfigPlan[], twoCaptchaKey?: string,
  ): Promise<CeremonyView> {
    const added = configs.filter(
      (config) => !live.finalize.agentConfigs.some((known) => sameConfig(known, config)),
    );
    if (live.session !== null && added.length > 0) {
      await this.deps.writeAgentConfigs(added, live.session);
    }
    live.finalize = {
      ...live.finalize,
      agentConfigs: [...live.finalize.agentConfigs, ...added],
      ...(live.finalize.twoCaptchaKey === undefined && twoCaptchaKey !== undefined
        ? { twoCaptchaKey } : {}),
    };
    this.deps.log("[ceremony] a later connect joined the live sign-in");
    return { ...live.view, reused: true };
  }

  private async open(request: CeremonyStartRequest): Promise<CeremonyView> {
    const deadline = this.now() + request.ttlMs;
    const tab = await this.deps.openTab(request.confirmUrl);
    let exposure: SharedCeremonyExposure;
    try {
      if (request.forceReloginProviders?.length) {
        await this.deps.logoutProviders(tab, request.confirmUrl, request.forceReloginProviders);
      }
      let live: LiveCeremony | null = null;
      exposure = await this.deps.expose({
        profileDir: this.deps.profileDir,
        callerHasDisplay: request.callerHasDisplay,
        ...(request.namedTunnel !== undefined ? { namedTunnel: request.namedTunnel } : {}),
        // The rig's own lifetime is a backstop past the pairing window; if it
        // ever fires, the ceremony it belongs to is over.
        onExpired: () => {
          if (live !== null) void this.end(live, "the sign-in window outlived its own bound");
        },
        windowControl: {
          showPhone: async () => {
            const clip = await tab.command("operate_ceremony_window", { action: "show_phone" });
            if (!validClip(clip)) throw new Error("broker did not return ceremony window bounds");
            return clip;
          },
          restore: async () => {
            await tab.command("operate_ceremony_window", { action: "restore" });
          },
        },
      });
      if (exposure.kind === "unshowable") {
        await tab.close().catch(() => undefined);
        this.deps.log(`[ceremony] the sign-in tab cannot be shown here: ${exposure.reason}`);
        return { state: "unshowable", confirm_url: request.confirmUrl, reason: exposure.reason };
      }
      live = {
        request,
        finalize: request.finalize,
        view: {
          state: "live",
          confirm_url: request.confirmUrl,
          browser_location:
            exposure.kind === "exposed"
              ? { kind: "virtual", url: exposure.url }
              : { kind: "host_screen" },
          reused: false,
        },
        tab,
        stopExposure: exposure.kind === "exposed" ? exposure.stop : null,
        deadline,
        claim: null,
        session: null,
        ended: null,
      };
      this.live = live;
    } catch (error) {
      await tab.close().catch(() => undefined);
      throw error;
    }
    this.deps.log(
      `[ceremony] sign-in open (${this.live.view.browser_location.kind}); waiting for the claim and Finish`,
    );
    void this.run(this.live);
    return this.live.view;
  }

  private async run(live: LiveCeremony): Promise<void> {
    const expiry = setTimeout(() => {
      void this.end(live, "the pairing window closed");
    }, Math.max(0, live.deadline - this.now()));
    try {
      let lastError = "";
      while (this.live === live && live.ended === null && this.now() < live.deadline) {
        let status: InstallStatus | null = null;
        try {
          status = await this.deps.pollStatus(live.request.apiBase, live.request.setupCode);
          lastError = "";
        } catch (error) {
          // A dropped request is not the end of a sign-in the person is still
          // doing. Say so once, keep polling until the pairing deadline.
          const message = error instanceof Error ? error.message : String(error);
          if (message !== lastError)
            this.deps.log(`[ceremony] install status poll failed: ${message}`);
          lastError = message;
        }
        if (this.live !== live || live.ended !== null) return;
        if (status?.status === "expired") {
          await this.end(live, live.session === null ? "the install link expired" : "finished");
          return;
        }
        if (status?.status === "claimed") {
          live.claim = {
            token: status.agent_session_token,
            account_id: status.account_id,
            ...(status.install_preferences !== undefined
              ? { preferences: status.install_preferences }
              : {}),
          };
          this.deps.log("[ceremony] account claimed");
        }
        await this.landClaim(live);
        if (live.ended !== null) return;
        const finished =
          status !== null &&
          (status.status === "claimed" || status.status === "delivered") &&
          status.finished;
        if (finished && live.session !== null && (await this.requestedProviderPresent(live))) {
          await this.end(live, "finished");
          return;
        }
        await this.sleep(this.pollIntervalMs);
      }
      if (this.live === live) await this.end(live, "the pairing window closed");
    } finally {
      clearTimeout(expiry);
    }
  }

  // The token is delivered exactly once, so a failed write is retried on every
  // poll rather than abandoned.
  private async landClaim(live: LiveCeremony): Promise<void> {
    if (live.claim === null || live.session !== null) return;
    try {
      const plan = live.finalize;
      const session = await this.deps.finalize(plan, live.claim, this.deps.profileDir);
      let written = plan.agentConfigs;
      while (true) {
        const pending = live.finalize.agentConfigs.filter(
          (config) => !written.some((known) => sameConfig(known, config)),
        );
        if (pending.length === 0) break;
        await this.deps.writeAgentConfigs(pending, session);
        written = [...written, ...pending];
      }
      live.session = session;
      this.deps.log("[ceremony] session written");
    } catch (error) {
      this.deps.log(
        `[ceremony] writing the claimed session failed (will retry): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async requestedProviderPresent(live: LiveCeremony): Promise<boolean> {
    if (live.request.requestedProvider !== "github") return true;
    const providers = await this.deps
      .detectProviders(this.deps.profileDir)
      .catch((): readonly OAuthProviderId[] => []);
    return providers.includes("github");
  }

  private end(live: LiveCeremony, reason: string): Promise<void> {
    live.ended ??= (async () => {
      // Helpers first (they are the daemon's own children); then the tab.
      // The display and the browser stay with the broker.
      await live.stopExposure?.().catch(() => undefined);
      await live.tab.close().catch(() => undefined);
      if (this.live === live) this.live = null;
      this.deps.log(
        `[ceremony] sign-in window closed: ${reason}` +
          (live.session === null ? " (no session was written)" : ""),
      );
    })();
    return live.ended;
  }
}

/** `/status`, read with the fields the ceremony acts on. */
export async function pollInstallStatus(
  apiBase: string,
  setupCode: string,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<InstallStatus> {
  const res = await fetchImpl(`${apiBase}/v1/mcp/install/${encodeURIComponent(setupCode)}/status`);
  if (res.status === 410) return { status: "expired" };
  if (!res.ok) throw new Error(`install status poll failed (HTTP ${res.status})`);
  const body = (await res.json()) as Record<string, unknown>;
  const finished = body.finished === true;
  if (body.status === "claimed" && typeof body.agent_session_token === "string") {
    const preferences = body.install_preferences;
    return {
      status: "claimed",
      agent_session_token: body.agent_session_token,
      account_id: typeof body.account_id === "string" ? body.account_id : "",
      ...(preferences !== null && typeof preferences === "object"
        ? { install_preferences: preferences as InstallClaim["preferences"] }
        : {}),
      finished,
    };
  }
  if (body.status === "delivered") return { status: "delivered", finished };
  if (body.status === "expired") return { status: "expired" };
  return { status: "pending" };
}

/** A ceremony tab is an ordinary operator session the daemon opens for itself. */
export function operatorCeremonyTab(
  operator: Pick<OperatorBroker, "open" | "command" | "closeSession" | "disconnect">,
): (url: string) => Promise<CeremonyTab> {
  return async (url) => {
    const principal = { agentId: "connect-ceremony", clientId: `ceremony-${randomUUID()}` };
    let sessionId: string | undefined;
    try {
      // The ceremony IS what creates the live Google session, and the same
      // flag adopts the browser's live identity — see OpenRequest.
      const opened = await operator.open(
        principal,
        { serviceUrl: url, ceremony: true },
        randomUUID(),
      );
      sessionId = opened.sessionId;
      if (sessionId === undefined) {
        const detail = openHandbackDetail(opened.observation);
        throw new Error(
          `The shared browser opened no ceremony tab (the broker minted no live session).` +
            (detail !== "" ? ` ${detail}` : "") +
            ` Re-run \`npx @trusty-squire/mcp connect\`; if it repeats, check broker.log in the ` +
            `private broker socket directory.`,
        );
      }
    } catch (error) {
      await operator.disconnect(principal, true).catch(() => undefined);
      throw error;
    }
    const owned = sessionId;
    return {
      command: async (name, args) =>
        (
          await operator.command(
            principal,
            { sessionId: owned, name, args: { ...args, session_id: owned } },
            randomUUID(),
          )
        ).result,
      close: async () => {
        await operator
          .closeSession(principal, { sessionId: owned }, randomUUID())
          .catch(() => undefined);
        await operator.disconnect(principal, true);
      },
    };
  };
}

// Pull one human-readable line out of a needs-user hand-back observation so
// the message names what the broker actually asked for, not just that it asked.
function openHandbackDetail(observation: unknown): string {
  if (observation === null || typeof observation !== "object") return "";
  const record = observation as Record<string, unknown>;
  for (const key of ["guidance", "hint", "url"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return `${key}: ${value}`;
  }
  return "";
}
