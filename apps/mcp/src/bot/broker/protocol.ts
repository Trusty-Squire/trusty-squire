// Contract B — the broker wire protocol (frozen).
//
// The wire used to carry six bespoke methods: `hello`, `tool`, `cancel`,
// `client_close`, `maintenance`, `resume`. They actually express four
// operations (`maintenance`/`resume` expressed a connect-only drain window
// that no longer exists at all: connect now rides the shared browser as an
// ordinary client instead of draining it):
//
//   hello                        -> connect
//   tool{name:"operate_start"}   -> open
//   tool{name,args}              -> command   (the only place a tool name appears)
//   tool{name:"operate_finish"}  -> close{ sessionId, args }
//   client_close                 -> close{}   (ends the connection: the lease boundary)
//   cancel                       -> the reserved `abort` control frame
//
// Framing, MAX_FRAME, the `{ id, error: { code, message } }` error shape, the
// 512-entry retained-result replay guard, the 5 s connection-session grace
// timer and the reserved `abort` control frame (per-request cancellation keyed
// on the request frame id) are transport/implementation policy, not part of
// this contract. They stay behind it.
//
// The session id is the only handle that crosses the wire; the broker keeps the
// Page and Browser. Notifications travel on the originating command's stream.

import type { Observation } from "../provision-session.js";

/** The four operations the wire expresses, plus the read that answers for them. */
export type BrokerWireMethod = "connect" | "open" | "command" | "close" | "status";

/** connect: authenticate the local MCP process and mint its connection id. */
export interface ConnectRequest {
  token: string;
  agentId: string;
  /**
   * Connect-only concern: this connection will only read `status`. It is a
   * read, so it is kept out of the broker's idle accounting — probing on any
   * cadence must not extend how long the shared Chrome stays resident.
   */
  probe?: boolean;
}
export interface ConnectResult {
  version: 1;
  clientId: string;
}

/** open: start one operator session on the shared browser. */
export interface OpenRequest {
  serviceUrl: string;
  format?: "compact" | "full";
  proxy?: string;
  /** A direct drive takes its first perception through the drive snapshot. */
  initialObservation?: "drive";
  /** This open IS the connect re-auth ceremony. Two things follow from it,
   * and neither is separately selectable:
   *
   * 1. Its start passes the `google_session` admission gate, because the
   *    ceremony is what creates the live Google session — gating it
   *    deadlocked every enrolled machine whose profile had none (the gate's
   *    own remedy, `connect --force-relogin=google`, is the ceremony itself).
   * 2. It adopts whatever identity the shared browser is already live under
   *    instead of requesting one. Without that, an open carrying no proxy
   *    against a proxied Chrome is refused `incompatible_runtime` while other
   *    sessions live, or recycles the shared Chrome underneath them when none
   *    do. An explicit `proxy` still wins.
   *
   * Nothing else changes: the ceremony still gets a full operator session
   * (the deferred --force-relogin logout drive rides it) and still counts in
   * the inventory. Ceremony-only by construction: the only sender is the
   * connect ceremony in google-login.ts, and the agent-facing `operate_start`
   * surface has no such field and no forwarder path that could add one. */
  ceremony?: boolean;
}
export interface OpenResult {
  /**
   * The broker session id. Absent when the broker minted no live session (a
   * `needs_user` hand-back); the observation still carries its own session id.
   */
  sessionId?: string;
  observation: Observation;
}

/** command: one operator verb against an owned session. */
export interface CommandRequest {
  sessionId: string;
  name: string;
  args: Record<string, unknown>;
}
export interface CommandResult {
  result?: unknown;
  /**
   * Present only when the broker proved no mutation was dispatched. The caller
   * may retry the mutation; any other failure must not be replayed.
   */
  preDispatchFailure?: { error: string; dispatch: "not_dispatched" };
}

/** close: finish a session, or end the connection (the lease boundary). */
export interface CloseRequest {
  /** Omitted to end the connection. */
  sessionId?: string;
  /** `operate_finish` payload when closing a session. */
  args?: Record<string, unknown>;
}
export interface CloseResult {
  closed: boolean;
  /** The `operate_finish` tool payload, when a session was finished. */
  result?: unknown;
  preDispatchFailure?: { error: string; dispatch: "not_dispatched" };
}

/**
 * Read-only broker availability. The custody/profile fold is defined in
 * docs/browser-broker.md (Busy façade); a live socket alone cannot answer it.
 */
export interface StatusResult {
  busy: boolean;
  /**
   * The refusal code the same condition would produce on `open`. Present only
   * when busy. The client maps code to layer; the wire does not carry a second
   * copy of that mapping to drift from.
   */
  code?: string;
  detail?: string;
  /** The process actually holding the profile, when the profile layer answers. */
  holder?: { pid?: number; host?: string };
}

/** Notifications travel on the originating command's stream, unchanged. */
export interface BrokerNotification {
  message: string;
  data?: Record<string, unknown>;
}
