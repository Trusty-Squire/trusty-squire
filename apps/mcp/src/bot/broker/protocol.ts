// Contract B — the broker wire protocol (frozen).
//
// The wire used to carry six bespoke methods: `hello`, `tool`, `cancel`,
// `client_close`, `maintenance`, `resume`. They actually express four
// operations:
//
//   hello                        -> connect
//   tool{name:"operate_start"}   -> open
//   tool{name,args}              -> command   (the only place a tool name appears)
//   tool{name:"operate_finish"}  -> close{ sessionId, args }
//   client_close                 -> close{}   (ends the connection: the lease boundary)
//   maintenance / resume         -> the connect-only `maintain` intent on connect
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
   * Connect-only concern: drain the shared browser for the plain-login
   * maintenance window ("maintenance" + "resume" folded into the connect path).
   * It is deliberately not a general client operation.
   */
  maintain?: boolean;
}
export interface ConnectResult {
  version: 1;
  clientId: string;
  /** Present only when the connection requested `maintain`. */
  maintenance?: "ready" | "draining";
}

/** open: start one operator session on the shared browser. */
export interface OpenRequest {
  serviceUrl: string;
  format?: "compact" | "full";
  proxy?: string;
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
 * status: "is the browser in use", answered ONCE by the side that can see all
 * four layers at the same instant — tab families, the profile lease and its
 * holder, the connect maintenance window, and custody. A client cannot fold
 * these from outside: a live socket says nothing about whose Chrome holds the
 * lease, and the maintenance window is broker-local state. Read-only.
 */
export type BrokerBusyLayer = "profile" | "maintenance" | "custody";
export interface StatusResult {
  busy: boolean;
  /** Present only when busy. */
  layer?: BrokerBusyLayer;
  code?: string;
  detail?: string;
  /** The process actually holding the profile, when the profile layer answers. */
  holder?: { pid?: number; host?: string };
  /**
   * Live tab families. Informational: the broker multiplexes them on one
   * shared Chrome, so a running family never makes the browser unavailable.
   */
  tabFamilies: number;
}

/** Notifications travel on the originating command's stream, unchanged. */
export interface BrokerNotification {
  message: string;
  data?: Record<string, unknown>;
}
