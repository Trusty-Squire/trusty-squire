// Machine-readable connect report. One typed value answers the whole
// question (state, sign-in URL, account, holder, browser location); the
// human sentences render from it. `connect --json` prints this object.
//
// Connect runs before any MCP server exists, so the CLI carries the
// contract. A later MCP reader must call the same function, not restated
// prose.

import { hostname } from "node:os";
import type { OAuthProviderId } from "../bot/oauth-providers.js";
import { currentProfileHolderPid, readLockHolder } from "../bot/profile.js";
import type { SessionData } from "../session.js";

export const CONNECT_STATES = ["connected", "needs-sign-in", "busy", "no-browser"] as const;
export type ConnectState = (typeof CONNECT_STATES)[number];

export type ConnectReasonCode =
  | "already_provisioned"
  | "ceremony_complete"
  | "ceremony_required"
  | "skip_browser"
  | "unverified_probe"
  | "probe_failed"
  | "no_google_session"
  | "requested_provider_missing"
  | "profile_busy"
  | "display_unshowable"
  | "install_unclaimed"
  | "browser_confirm_failed"
  | "account_switch_refused"
  | "cookie_clear_failed";

export type ConnectHolder =
  | { kind: "none" }
  | { kind: "self"; code: "this_process"; pid: number }
  | {
      kind: "other";
      code: "singleton_lock" | "profile_lock" | "broker_lease";
      pid?: number;
      host?: string;
    }
  | { kind: "unknown"; reason: "holder_unreadable" | "cross_host" | "identity_unknown" };

export type ConnectBrowserLocation =
  | { kind: "host_screen"; display?: string }
  | { kind: "virtual"; display?: string }
  | { kind: "none" }
  | { kind: "unreachable"; reason: string }
  | { kind: "unknown"; reason: string };

export interface ConnectAccount {
  id: string;
  providers: OAuthProviderId[];
}

/**
 * The five fields Beeline drives from, plus the reason code that
 * distinguishes not-connected cases without matching English.
 *
 * Every field is always present. `sign_in_url` is a URL only in
 * `needs-sign-in` when we have exactly one; otherwise null. `account`
 * is set only when `state` is `connected`.
 */
export interface ConnectReport {
  state: ConnectState;
  reason: ConnectReasonCode;
  sign_in_url: string | null;
  account: ConnectAccount | null;
  holder: ConnectHolder;
  browser_location: ConnectBrowserLocation;
}

export type ConnectOutcome =
  | { kind: "provisioned"; account_id: string; providers: OAuthProviderId[] }
  | { kind: "unverified"; account_id: string }
  | { kind: "ceremony_waiting"; confirm_url: string; skip_browser: boolean }
  | {
      kind: "ceremony_complete";
      account_id: string;
      providers: OAuthProviderId[] | null;
      requested_provider?: OAuthProviderId;
      skip_browser: boolean;
    }
  | { kind: "profile_busy" }
  | { kind: "display_unshowable"; detail: string }
  | { kind: "install_unclaimed" }
  | { kind: "browser_confirm_failed"; detail: string }
  | { kind: "account_switch_refused" }
  | { kind: "cookie_clear_failed" };

export interface ConnectReportInput {
  outcome: ConnectOutcome;
  holder: ConnectHolder;
  browser_location: ConnectBrowserLocation;
}

function emptyReport(
  state: ConnectState,
  reason: ConnectReasonCode,
  input: ConnectReportInput,
  extras: Pick<ConnectReport, "sign_in_url" | "account"> = {
    sign_in_url: null,
    account: null,
  },
): ConnectReport {
  return {
    state,
    reason,
    sign_in_url: extras.sign_in_url,
    account: extras.account,
    holder: input.holder,
    browser_location: input.browser_location,
  };
}

function connectedAccount(account_id: string, providers: OAuthProviderId[]): ConnectAccount {
  return { id: account_id, providers };
}

/**
 * Classify connect from already-known facts. Does not launch a browser,
 * probe a profile, or invent a gate — it only names the state the
 * existing success / preflight / busy / display answers already decided.
 */
export function buildConnectReport(input: ConnectReportInput): ConnectReport {
  const { outcome } = input;
  switch (outcome.kind) {
    case "provisioned":
      return emptyReport("connected", "already_provisioned", input, {
        sign_in_url: null,
        account: connectedAccount(outcome.account_id, outcome.providers),
      });
    case "ceremony_complete": {
      const gate = decideConnectComplete(outcome.providers, outcome.requested_provider);
      if (gate.ok) {
        return emptyReport("connected", "ceremony_complete", input, {
          sign_in_url: null,
          account: connectedAccount(outcome.account_id, outcome.providers ?? []),
        });
      }
      if (gate.reason === "probe_failed") {
        return emptyReport("busy", "probe_failed", input);
      }
      if (gate.reason === "no_google_session" && outcome.skip_browser) {
        return emptyReport("no-browser", "no_google_session", input);
      }
      return emptyReport("needs-sign-in", gate.reason, input);
    }
    case "unverified":
      return emptyReport("busy", "unverified_probe", input);
    case "ceremony_waiting":
      return emptyReport(
        "needs-sign-in",
        outcome.skip_browser ? "skip_browser" : "ceremony_required",
        input,
        { sign_in_url: outcome.confirm_url, account: null },
      );
    case "profile_busy":
      return emptyReport("busy", "profile_busy", {
        ...input,
        holder:
          input.holder.kind === "none"
            ? { kind: "unknown", reason: "identity_unknown" }
            : input.holder,
      });
    case "display_unshowable":
      return emptyReport("no-browser", "display_unshowable", {
        ...input,
        browser_location:
          input.browser_location.kind === "unreachable"
            ? input.browser_location
            : { kind: "unreachable", reason: outcome.detail },
      });
    case "install_unclaimed":
      return emptyReport("needs-sign-in", "install_unclaimed", input);
    case "browser_confirm_failed":
      return emptyReport("no-browser", "browser_confirm_failed", input);
    case "account_switch_refused":
      return emptyReport("needs-sign-in", "account_switch_refused", input);
    case "cookie_clear_failed":
      return emptyReport("busy", "cookie_clear_failed", input);
  }
}

export function alreadyConnectedMessage(
  providers: OAuthProviderId[],
  agentDisplayName: string,
): string {
  return `Already connected (${providers.join(" + ")}). ${agentDisplayName} config refreshed.`;
}

export type ConnectIncompleteReason =
  | "probe_failed"
  | "no_google_session"
  | "requested_provider_missing";

export function connectIncompleteMessage(
  reason: ConnectIncompleteReason,
  skipBrowser: boolean,
): string {
  const retry = "npx @trusty-squire/mcp connect --force-relogin";
  const skipBrowserNote = skipBrowser
    ? " --skip-browser signs you in outside the bot's Chrome, so its profile never " +
      "gains the session; re-run connect without it on a machine with a display " +
      "(headless hosts get a noVNC URL)."
    : "";
  switch (reason) {
    case "probe_failed":
      return (
        `This machine is bound to your account, but I couldn't verify a live Google session ` +
        `in the bot's Chrome profile, so I won't call this connected. ` +
        `Close any other Trusty Squire session and re-run ${retry}.`
      );
    case "no_google_session":
      return (
        `This machine is bound to your account, but the bot's Chrome profile has no live ` +
        `Google session, so the operator cannot act as you.${skipBrowserNote} ` +
        `Re-run ${retry}.`
      );
    case "requested_provider_missing":
      return (
        `This machine is connected, but the provider sign-in you asked to refresh didn't ` +
        `complete. Re-run ${retry}=github and finish the GitHub step in the browser.`
      );
  }
}

export function preflightUnverifiedMessage(detail: string): string {
  return (
    `This machine is bound to your account, but I couldn't verify a live provider session ` +
    `in the bot's Chrome profile (${detail}), so I won't call this connected. ` +
    `Your agent config was refreshed.`
  );
}

export function decideProvisioned(
  session: SessionData | null,
  tokenValid: boolean,
  providers: OAuthProviderId[],
): { providers: OAuthProviderId[] } | null {
  if (
    session === null ||
    session.machine_token === undefined ||
    session.agent_session_token === undefined ||
    session.account_id === undefined
  ) {
    return null;
  }
  if (!tokenValid) return null;
  if (!providers.includes("google")) return null;
  return { providers };
}

export type ConnectPreflight =
  | { kind: "ceremony" }
  | { kind: "provisioned"; providers: OAuthProviderId[] }
  | { kind: "unverified" };

type VerifiedConnectPreflight = Exclude<ConnectPreflight, { kind: "unverified" }>;

export function decideConnectPreflight(
  session: SessionData | null,
  tokenValid: boolean,
  providers: null,
): Extract<ConnectPreflight, { kind: "ceremony" } | { kind: "unverified" }>;
export function decideConnectPreflight(
  session: SessionData | null,
  tokenValid: boolean,
  providers: OAuthProviderId[],
): VerifiedConnectPreflight;
export function decideConnectPreflight(
  session: SessionData | null,
  tokenValid: boolean,
  providers: OAuthProviderId[] | null,
): ConnectPreflight {
  if (
    session === null ||
    session.machine_token === undefined ||
    session.agent_session_token === undefined ||
    session.account_id === undefined
  ) {
    return { kind: "ceremony" };
  }
  // Deliberately precede probe-null: an expired agent token must re-pair, not
  // silently refresh config into an install that 401s on every MCP call.
  // Do not flip this ordering.
  if (!tokenValid) return { kind: "ceremony" };
  if (providers === null) return { kind: "unverified" };
  const provisioned = decideProvisioned(session, tokenValid, providers);
  return provisioned === null
    ? { kind: "ceremony" }
    : { kind: "provisioned", providers: provisioned.providers };
}

/**
 * The providers the post-ceremony probe must wait for before it may answer.
 *
 * This is exactly what `decideConnectComplete` goes on to DEMAND, and the two
 * must not drift: Google is required on every run, plus an explicitly
 * requested `--force-relogin=<provider>`. Awaiting only the requested one let
 * the snapshot answer on cookies that were already on disk — a profile with
 * GitHub committed from an earlier run returns `["github"]` on the first read
 * while the Google session the user just created is still inside Chrome's
 * ~30s commit window, and the gate rejects a sign-in that succeeded.
 */
export function providersConnectMustAwait(requestedProvider?: OAuthProviderId): OAuthProviderId[] {
  return requestedProvider === undefined || requestedProvider === "google"
    ? ["google"]
    : ["google", requestedProvider];
}

export function decideConnectComplete(
  providers: OAuthProviderId[] | null,
  requestedProvider?: OAuthProviderId,
): { ok: true } | { ok: false; reason: ConnectIncompleteReason } {
  if (providers === null) return { ok: false, reason: "probe_failed" };
  if (!providers.includes("google")) return { ok: false, reason: "no_google_session" };
  // A scoped --force-relogin=<provider> is an explicit ask; silently landing
  // only Google would report success for work the user didn't get.
  if (requestedProvider !== undefined && !providers.includes(requestedProvider)) {
    return { ok: false, reason: "requested_provider_missing" };
  }
  return { ok: true };
}

export interface BrowserLocationFacts {
  phase: "none" | "skip_browser" | "decided";
  host_screen_live?: boolean;
  placement?: "host_screen" | "virtual" | "unreachable";
  display?: string;
  reason?: string;
}

function optionalDisplay(display: string | undefined): string | undefined {
  const trimmed = display?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Where Squire decided the ceremony browser is showing. A real screen
 * wins; the virtual display is for hosts with no live screen. Callers
 * do not detect screens themselves.
 */
export function observeConnectBrowserLocation(facts: BrowserLocationFacts): ConnectBrowserLocation {
  if (facts.phase === "none" || facts.phase === "skip_browser") return { kind: "none" };
  if (facts.placement === "unreachable") {
    return { kind: "unreachable", reason: facts.reason ?? "display_unshowable" };
  }
  if (facts.placement === "virtual") {
    const display = optionalDisplay(facts.display);
    return display === undefined ? { kind: "virtual" } : { kind: "virtual", display };
  }
  if (facts.placement === "host_screen" || facts.host_screen_live === true) {
    const display = optionalDisplay(facts.display);
    return display === undefined ? { kind: "host_screen" } : { kind: "host_screen", display };
  }
  if (facts.host_screen_live === false) return { kind: "virtual" };
  return { kind: "unknown", reason: facts.reason ?? "display_probe_unavailable" };
}

export function snapshotConnectHolder(profileDir: string): ConnectHolder {
  const lock = readLockHolder(profileDir);
  if (lock !== null && !lock.stale) {
    if (lock.host !== hostname()) return { kind: "unknown", reason: "cross_host" };
    if (lock.pid === process.pid) return { kind: "self", code: "this_process", pid: lock.pid };
    return { kind: "other", code: "singleton_lock", pid: lock.pid, host: lock.host };
  }
  const pid = currentProfileHolderPid(profileDir);
  if (pid === null) return { kind: "none" };
  if (pid === process.pid) return { kind: "self", code: "this_process", pid };
  return { kind: "other", code: "singleton_lock", pid };
}

export function emitConnectReport(report: ConnectReport, json: boolean | undefined): void {
  if (json !== true) return;
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

export function isUnshowableConfirmDetail(detail: string | undefined): boolean {
  if (detail === undefined) return false;
  return (
    detail.includes("nothing here can show") ||
    detail.includes("private display") ||
    detail.includes("nobody can see or complete the sign-in")
  );
}
