// Machine-readable connect report. One typed value answers the whole
// question (state, sign-in URL, account, holder, browser location); the
// human sentences render from it.
//
// `connect --json` writes NEWLINE-DELIMITED JSON: one complete, self-sufficient
// report per line, written when the run's answer changes, and the last line
// carries `terminal: true`. Connect blocks for minutes waiting on a human, and
// a stream that only speaks once it settles is silent for exactly the window in
// which the sign-in URL and the noVNC address are live — which left a caller
// scraping stderr prose, the thing this surface exists to delete.
//
// Connect runs before any MCP server exists, so the CLI carries the
// contract. A later MCP reader must call the same function, not restated
// prose.

import { writeSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import type { CeremonyBrowserPlacement } from "../bot/google-login.js";
import type { OAuthProviderId } from "../bot/oauth-providers.js";
import {
  isPidAlive,
  processBirthIdentityState,
  profileOperationLockOwner,
  readLockHolder,
} from "../bot/profile.js";
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
  | "cached_cookie_evidence"
  | "run_failed";

// Two locks can hold the bot profile and they answer different questions:
// Chrome's SingletonLock names a live browser, the operation lease names a
// Squire run that claimed the profile for work (a `--force-relogin` wipe holds
// it with no browser running at all). Both are holders; the code says which.
export type ConnectHolder =
  | { kind: "none" }
  | { kind: "other"; code: "singleton_lock" | "operation_lease"; pid: number }
  | { kind: "unknown"; reason: "cross_host" };

// The placement half is whatever the code that PLACED the ceremony browser
// reported; the other two members are the runs that placed no browser and
// the runs whose placement never came back.
export type ConnectBrowserLocation =
  | CeremonyBrowserPlacement
  | { kind: "none" }
  | { kind: "unknown"; reason: string };

export interface ConnectAccount {
  id: string;
  // What the run's provider probe actually saw. `[]` means it read the profile
  // and found nothing; `null` means it could not read the profile at all, which
  // is a different answer and must not be flattened into "none".
  providers: OAuthProviderId[] | null;
}

interface ConnectReportFields {
  // False while the run is still going, true on the line that ends it. Every
  // line is complete on its own; this says whether another one is coming.
  terminal: boolean;
  reason: ConnectReasonCode | null;
  account: ConnectAccount | null;
  holder: ConnectHolder;
  browser_location: ConnectBrowserLocation;
}

/**
 * The five fields Beeline drives from, plus the reason code for the cases
 * those five cannot tell apart between them.
 *
 * Every field is always present, on every line. `needs-sign-in` CARRIES its
 * URL — the type says so, so no run can report an outstanding sign-in with
 * nowhere to send anyone. A `no-browser` run may also still hold a live URL (the ceremony
 * could not be shown here, but the install is still open). `account` is set
 * whenever the run proved which account this machine is bound to, which is
 * not only when it ends `connected`, and its `providers` says what the probe
 * saw — `null` when it could not look; `reason` is null when the other fields
 * already say everything there is to say.
 */
export type ConnectReport =
  | (ConnectReportFields & { state: "needs-sign-in"; sign_in_url: string })
  | (ConnectReportFields & {
      state: Exclude<ConnectState, "needs-sign-in">;
      sign_in_url: string | null;
    });

export type ConnectOutcome =
  // The only non-terminal outcome: the pairing link is valid and the run is
  // about to wait on a human. It goes out before the wait, and again whenever
  // the browser's placement becomes known, so a caller holds both live
  // addresses while they still reach something.
  | { kind: "sign_in_open"; confirm_url: string }
  | { kind: "provisioned"; account_id: string; providers: OAuthProviderId[] }
  | { kind: "unverified"; account_id: string | null }
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
    terminal: true,
    reason,
    sign_in_url: extras.sign_in_url ?? null,
    account: extras.account ?? null,
    holder: input.holder,
    browser_location: input.browser_location,
  };
}

function signInOutstanding(
  input: ConnectReportInput,
  sign_in_url: string,
  terminal: boolean,
): ConnectReport {
  return {
    state: "needs-sign-in",
    terminal,
    reason: null,
    sign_in_url,
    account: null,
    holder: input.holder,
    browser_location: input.browser_location,
  };
}

function connectedAccount(account_id: string, providers: OAuthProviderId[] | null): ConnectAccount {
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
    case "sign_in_open":
      return signInOutstanding(input, outcome.confirm_url, false);
    case "provisioned":
      // The no-ceremony fast path reads the profile's cookie store and opens
      // nothing, so it cannot claim the session is live — the human copy on
      // this branch says the same.
      return settled("connected", "cached_cookie_evidence", input, {
        account: connectedAccount(outcome.account_id, outcome.providers),
      });
    case "ceremony_complete": {
      const gate = decideConnectComplete(outcome.providers, outcome.requested_provider);
      if (gate.ok) {
        return settled("connected", null, input, {
          account: connectedAccount(outcome.account_id, outcome.providers),
        });
      }
      // The ceremony claimed the install and the session was written, so the
      // binding is proven even though the probe could not read the profile.
      if (gate.reason === "probe_failed") {
        return settled("busy", "profile_unverifiable", input, {
          account: connectedAccount(outcome.account_id, outcome.providers),
        });
      }
      // The run fails and exits non-zero on this gate, so the machine channel
      // must not answer `connected`: the browser is not signed in the way the
      // caller asked for, and the reason names the gap.
      if (gate.reason === "requested_provider_missing") {
        return settled("no-browser", "requested_provider_missing", input, {
          account: connectedAccount(outcome.account_id, outcome.providers),
        });
      }
      // The session was written and the agent config rebound before the probe
      // ran, so this machine IS bound to that account — the empty provider
      // list is the observation, not a reason to drop the binding.
      return settled("no-browser", "provider_session_missing", input, {
        account: connectedAccount(outcome.account_id, outcome.providers),
      });
    }
    case "unverified":
      // The preflight probe threw, so no provider session was observed either
      // way — that is `null`, not an empty list.
      return settled("busy", "profile_unverifiable", input, {
        ...(outcome.account_id === null
          ? {}
          : { account: connectedAccount(outcome.account_id, null) }),
      });
    case "profile_busy":
      return settled("busy", null, input);
    case "install_unclaimed":
      // The run waits no longer than the pairing token lives and reports a
      // lapsed one as `install_expired`, so this URL is still open. It is a
      // needs-sign-in unless nothing here could be shown the page at all.
      return input.browser_location.kind === "unreachable"
        ? settled("no-browser", null, input, { sign_in_url: outcome.confirm_url })
        : signInOutstanding(input, outcome.confirm_url, true);
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

/**
 * Who holds the bot profile, as read. `ownBrowserPid` is the ceremony Chrome
 * THIS run launched, when it launched one: that window is not "another
 * session", and answering `other` for it told a caller to wait for itself.
 */
export function snapshotConnectHolder(
  profileDir: string,
  ownBrowserPid: number | null = null,
): ConnectHolder {
  const lock = readLockHolder(profileDir);
  if (lock === null) return leaseHolder(profileDir);
  if (lock.host !== hostname()) return { kind: "unknown", reason: "cross_host" };
  // A lock whose pid is gone is what `reapLeakedProfileHolder` exists to
  // clear; reporting it as a live holder is the opposite answer.
  if (lock.stale) return leaseHolder(profileDir);
  // Our own ceremony window masks nothing: a lease another session holds is
  // still worth naming, so fall through the way the other branches do.
  if (ownBrowserPid !== null && lock.pid === ownBrowserPid) return leaseHolder(profileDir);
  return { kind: "other", code: "singleton_lock", pid: lock.pid };
}

// The lease that `withProfileOperationGuard` refuses on. It outlives the
// browser — a `--force-relogin` wipe deletes the profile directory and its
// SingletonLock with it — so a run refused by the lease has no Chrome lock to
// name, and reading only that lock answered "nobody holds it".
function leaseHolder(profileDir: string): ConnectHolder {
  const owner = profileOperationLockOwner(profileDir, tmpdir());
  if (owner === null) return { kind: "none" };
  if (owner.host !== hostname()) return { kind: "unknown", reason: "cross_host" };
  if (owner.pid === process.pid) return { kind: "none" };
  // Same two questions the browser lock asks: is that process still there,
  // and is it still the one the lease recorded rather than a recycled pid.
  if (!isPidAlive(owner.pid)) return { kind: "none" };
  const birth = { pid: owner.pid, start_time: owner.start_time ?? "unknown" };
  if (processBirthIdentityState(birth) === "stale") return { kind: "none" };
  return { kind: "other", code: "operation_lease", pid: owner.pid };
}

let terminated = false;

// A connect run writes as many lines as its answer changes, then exactly one
// terminal line. Anything after that is dropped, so the run's outermost
// handler can report unconditionally without ending the stream twice.
export function beginConnectRun(): void {
  terminated = false;
}

/**
 * Connect refused the arguments, so there is no connection state to report —
 * a rejected flag is not "no browser here is signed in". Distinguished from a
 * report by carrying `error` where a report carries `state`.
 */
export interface ConnectUsageError {
  error: "usage";
  message: string;
}

// A usage error ends the stream like any terminal report.

export function emitConnectUsageError(message: string, json: boolean | undefined): void {
  if (terminated) return;
  terminated = true;
  if (json !== true) return;
  writeMachineLine({ error: "usage", message } satisfies ConnectUsageError);
}

export function emitConnectReport(report: ConnectReport, json: boolean | undefined): void {
  if (terminated) return;
  terminated = report.terminal;
  if (json !== true) return;
  writeMachineLine(report);
}

// Written straight to the descriptor: every reporting path exits immediately
// afterwards, and `process.exit` does not drain a buffered stdout write —
// which on a macOS pipe is asynchronous, so the line would be lost exactly
// where a caller is reading it.
function writeMachineLine(value: ConnectReport | ConnectUsageError): void {
  try {
    writeSync(process.stdout.fd, `${JSON.stringify(value)}\n`);
  } catch {
    // A caller that closed the pipe (EPIPE) or a full non-blocking one
    // (EAGAIN) is not a reason to fail a run or to replace its real error
    // with a write error the user cannot act on.
  }
}
