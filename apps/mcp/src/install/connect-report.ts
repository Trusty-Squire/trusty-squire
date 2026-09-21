// Machine-readable connect report. One typed value answers the whole
// question (state, sign-in URL, account, holder, browser location); the
// human sentences render from it. `connect --json` prints this object once,
// when the run has settled — interim progress never lands on that stream.
//
// Connect runs before any MCP server exists, so the CLI carries the
// contract. A later MCP reader must call the same function, not restated
// prose.

import { writeSync } from "node:fs";
import { hostname } from "node:os";
import type { CeremonyBrowserPlacement } from "../bot/google-login.js";
import type { OAuthProviderId } from "../bot/oauth-providers.js";
import { readLockHolder } from "../bot/profile.js";
import type { SessionData } from "../session.js";

export const CONNECT_STATES = ["connected", "needs-sign-in", "busy", "no-browser"] as const;
export type ConnectState = (typeof CONNECT_STATES)[number];

// What blocks this connect, and ONLY where the other fields cannot say it:
// a holder, a browser location and a sign-in URL already name their own
// cases, so those carry no reason at all.
export type ConnectReasonCode =
  | "provider_session_missing"
  | "requested_provider_missing"
  | "account_mismatch"
  | "profile_unverifiable"
  | "install_expired"
  | "run_failed";

export type ConnectHolder =
  | { kind: "none" }
  | { kind: "other"; code: "singleton_lock"; pid: number }
  | { kind: "unknown"; reason: "cross_host" | "identity_unknown" };

// The placement half is whatever the code that PLACED the ceremony browser
// reported; the other two members are the runs that placed no browser and
// the runs whose placement never came back.
export type ConnectBrowserLocation =
  | CeremonyBrowserPlacement
  | { kind: "none" }
  | { kind: "unknown"; reason: string };

export interface ConnectAccount {
  id: string;
  providers: OAuthProviderId[];
}

interface ConnectReportFields {
  reason: ConnectReasonCode | null;
  account: ConnectAccount | null;
  holder: ConnectHolder;
  browser_location: ConnectBrowserLocation;
}

/**
 * The five fields Beeline drives from, plus the reason code for the cases
 * those five cannot tell apart between them.
 *
 * Every field is always present. `needs-sign-in` CARRIES its URL — the type
 * says so, so no run can report an outstanding sign-in with nowhere to send
 * anyone. A `no-browser` run may also still hold a live URL (the ceremony
 * could not be shown here, but the install is still open). `account` is set
 * only when `state` is `connected`; `reason` is null when the other fields
 * already say everything there is to say.
 */
export type ConnectReport =
  | (ConnectReportFields & { state: "needs-sign-in"; sign_in_url: string })
  | (ConnectReportFields & {
      state: Exclude<ConnectState, "needs-sign-in">;
      sign_in_url: string | null;
    });

export type ConnectOutcome =
  | { kind: "provisioned"; account_id: string; providers: OAuthProviderId[] }
  | { kind: "unverified" }
  | {
      kind: "ceremony_complete";
      account_id: string;
      providers: OAuthProviderId[] | null;
      requested_provider?: OAuthProviderId;
    }
  | { kind: "profile_busy" }
  | { kind: "install_unclaimed"; confirm_url: string }
  | { kind: "install_expired" }
  | { kind: "account_switch_refused" }
  | { kind: "cookie_clear_failed" }
  | { kind: "run_failed" };

export interface ConnectReportInput {
  outcome: ConnectOutcome;
  holder: ConnectHolder;
  browser_location: ConnectBrowserLocation;
}

function settled(
  state: Exclude<ConnectState, "needs-sign-in">,
  reason: ConnectReasonCode | null,
  input: ConnectReportInput,
  extras: { sign_in_url?: string; account?: ConnectAccount } = {},
): ConnectReport {
  return {
    state,
    reason,
    sign_in_url: extras.sign_in_url ?? null,
    account: extras.account ?? null,
    holder: input.holder,
    browser_location: input.browser_location,
  };
}

function signInOutstanding(input: ConnectReportInput, sign_in_url: string): ConnectReport {
  return {
    state: "needs-sign-in",
    reason: null,
    sign_in_url,
    account: null,
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
 * existing success / preflight / busy / placement answers already decided.
 */
export function buildConnectReport(input: ConnectReportInput): ConnectReport {
  const { outcome } = input;
  switch (outcome.kind) {
    case "provisioned":
      return settled("connected", null, input, {
        account: connectedAccount(outcome.account_id, outcome.providers),
      });
    case "ceremony_complete": {
      const gate = decideConnectComplete(outcome.providers, outcome.requested_provider);
      if (gate.ok) {
        return settled("connected", null, input, {
          account: connectedAccount(outcome.account_id, outcome.providers ?? []),
        });
      }
      if (gate.reason === "probe_failed") return settled("busy", "profile_unverifiable", input);
      // The machine IS connected — Google is live and bound; only the scoped
      // refresh the run was asked for didn't land.
      if (gate.reason === "requested_provider_missing") {
        return settled("connected", "requested_provider_missing", input, {
          account: connectedAccount(outcome.account_id, outcome.providers ?? []),
        });
      }
      return settled("no-browser", "provider_session_missing", input);
    }
    case "unverified":
      return settled("busy", "profile_unverifiable", input);
    case "profile_busy":
      return settled("busy", null, input);
    case "install_unclaimed":
      // The run waits no longer than the pairing token lives and reports a
      // lapsed one as `install_expired`, so this URL is still open. It is a
      // needs-sign-in unless nothing here could be shown the page at all.
      return input.browser_location.kind === "unreachable"
        ? settled("no-browser", null, input, { sign_in_url: outcome.confirm_url })
        : signInOutstanding(input, outcome.confirm_url);
    case "install_expired":
      return settled("no-browser", "install_expired", input);
    case "account_switch_refused":
      return settled("no-browser", "account_mismatch", input);
    case "cookie_clear_failed":
      return settled("busy", "profile_unverifiable", input);
    case "run_failed":
      return settled("no-browser", "run_failed", input);
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

export function snapshotConnectHolder(profileDir: string): ConnectHolder {
  const lock = readLockHolder(profileDir);
  if (lock === null) return { kind: "none" };
  if (lock.host !== hostname()) return { kind: "unknown", reason: "cross_host" };
  // A lock whose pid is gone is what `reapLeakedProfileHolder` exists to
  // clear; reporting it as a live holder is the opposite answer.
  if (lock.stale) return { kind: "none" };
  return { kind: "other", code: "singleton_lock", pid: lock.pid };
}

let reported = false;

// A connect run reports once, on whichever terminal path it reaches. The
// caller's contract is `JSON.parse(stdout)`, so the run's outermost handler
// can report unconditionally without risking a second object on the stream.
export function beginConnectRun(): void {
  reported = false;
}

// Written straight to the descriptor: every reporting path exits immediately
// afterwards, and `process.exit` does not drain a buffered stdout write —
// which on a macOS pipe is asynchronous, so the report would be lost exactly
// where a caller is reading it.
export function emitConnectReport(report: ConnectReport, json: boolean | undefined): void {
  if (reported) return;
  reported = true;
  if (json !== true) return;
  writeSync(process.stdout.fd, `${JSON.stringify(report)}\n`);
}
