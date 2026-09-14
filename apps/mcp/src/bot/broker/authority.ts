import { composeOperatorSignals } from "../request-cancellation.js";
import { randomUUID } from "node:crypto";
import { BrokerRefusal } from "./refusal.js";

export interface BrokerPrincipal {
  accountId: string;
  agentId: string;
  clientId: string;
}
export interface BrokerSessionPort {
  targetId: string;
  prepare?(name: string, args: Record<string, unknown>): Promise<unknown> | unknown;
  invoke(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    requestId: string,
    prepared?: unknown,
  ): Promise<unknown>;
  /** True only after owned tabs and pending outcome custody are resolved. */
  close(reason?: "finish" | "disconnect" | "expiry"): Promise<boolean>;
  orphan(): Promise<void>;
}

/** How long a dropped connection's sessions survive before they are closed. */
export const CONNECTION_SESSION_GRACE_MS = 5_000;

interface Admission {
  clientId: string;
  abort: AbortController;
}
interface Actor {
  principal: BrokerPrincipal;
  sessionId: string;
  port: BrokerSessionPort;
  abort: AbortController;
  tail: Promise<void>;
  pending: number;
  closePromise?: Promise<boolean>;
}

/** This object lives only in the broker. No Page, Browser or CDP handle crosses
 * the transport. A principal is established by authenticated connection setup.
 * A session is named by a plain session id and owned by the connection that
 * opened it: there are no capabilities, leases, or detached states. */
export class BrokerAuthority {
  private readonly actors = new Map<string, Actor>();
  private readonly admissions = new Map<string, Admission>();
  private readonly pendingGraceCloses = new Set<string>();

  constructor(readonly accountId: string) {}

  private assertPrincipal(principal: BrokerPrincipal): void {
    if (principal.accountId !== this.accountId)
      throw new BrokerRefusal("unauthorized", "Client is not admitted to this identity cell");
  }

  private resolve(principal: BrokerPrincipal, sessionId: string): Actor {
    this.assertPrincipal(principal);
    const actor = this.actors.get(sessionId);
    if (actor === undefined || actor.principal.clientId !== principal.clientId)
      throw new BrokerRefusal("stale_lease", "Session does not name an owned live session");
    return actor;
  }

  /** Start a session on the shared browser. In-flight admissions are tracked so
   * a dropped connection aborts its own starting session instead of adopting
   * one nobody is waiting for. */
  async open(
    principal: BrokerPrincipal,
    create: (sessionId: string, signal: AbortSignal) => Promise<BrokerSessionPort>,
    cleanupFailedAdmission?: (sessionId: string) => Promise<boolean>,
    orphanFailedAdmission?: (sessionId: string) => Promise<void>,
    requestSignal?: AbortSignal,
  ): Promise<string> {
    this.assertPrincipal(principal);
    const id = randomUUID();
    const abort = new AbortController();
    const composed = composeOperatorSignals([
      abort.signal,
      ...(requestSignal ? [requestSignal] : []),
    ]);
    const signal = composed.signal;
    this.admissions.set(id, { clientId: principal.clientId, abort });
    let port: BrokerSessionPort | undefined;
    try {
      port = await create(id, signal);
      const actor: Actor = {
        principal: { ...principal },
        sessionId: id,
        port,
        abort,
        tail: Promise.resolve(),
        pending: 0,
      };
      this.actors.set(id, actor);
      if (signal.aborted) {
        await this.closeActor(actor);
        throw new BrokerRefusal("cancelled", "Client disconnected during admission");
      }
      return id;
    } catch (error) {
      if (port === undefined) {
        const closed = (await cleanupFailedAdmission?.(id)) ?? false;
        if (!closed) await orphanFailedAdmission?.(id);
      }
      throw error;
    } finally {
      composed.dispose();
      this.admissions.delete(id);
    }
  }

  busyReadReceipt(
    principal: BrokerPrincipal,
    sessionId: string,
  ): Record<string, unknown> | undefined {
    const actor = this.resolve(principal, sessionId);
    if (actor.pending === 0) return undefined;
    return {
      session_id: sessionId,
      status: "session_busy",
      execution: "pending",
      mutation: "unknown",
      cleanup: "open",
      closed: false,
    };
  }

  invoke(
    principal: BrokerPrincipal,
    sessionId: string,
    requestId: string,
    name: string,
    args: Record<string, unknown>,
    requestSignal?: AbortSignal,
  ): Promise<unknown> {
    const actor = this.resolve(principal, sessionId);
    if (["operate_observe", "operate_screenshot"].includes(name) && actor.pending > 0)
      return Promise.resolve({
        session_id: sessionId,
        status: "session_busy",
        execution: "pending",
        mutation: "unknown",
        cleanup: "open",
        closed: false,
      });
    const invocationLease = actor.abort;
    const composed = composeOperatorSignals([
      invocationLease.signal,
      ...(requestSignal ? [requestSignal] : []),
    ]);
    const signal = composed.signal;
    const previousTail = actor.tail;
    const preparation =
      actor.port.prepare === undefined
        ? undefined
        : Promise.resolve().then(() => {
            if (signal.aborted) throw new BrokerRefusal("cancelled", "Preparation cancelled");
            return actor.port.prepare!(name, args);
          });
    actor.pending += 1;
    const invokePrepared = async (prepared: unknown): Promise<unknown> => {
      if (signal.aborted) throw new BrokerRefusal("cancelled", "Command fenced before dispatch");
      return await actor.port.invoke(name, args, signal, requestId, prepared);
    };
    const result =
      preparation === undefined
        ? previousTail.then(() => invokePrepared(undefined))
        : preparation.then(
            (prepared) => previousTail.then(() => invokePrepared(prepared)),
            (error: unknown) =>
              previousTail.then(() => {
                throw error;
              }),
          );
    actor.tail = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        actor.pending -= 1;
        composed.dispose();
      });
    return result;
  }

  /** Terminal intent fences immediately; lifecycle owns draining and cleanup.
   * It must never sit behind the mutation tail it is trying to cancel. */
  async finish(
    principal: BrokerPrincipal,
    sessionId: string,
    requestId: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const actor = this.resolve(principal, sessionId);
    actor.abort.abort(new BrokerRefusal("cancelled", "Session finishing"));
    return await actor.port.invoke("operate_finish", args, new AbortController().signal, requestId);
  }

  /** Terminal cleanup already removed the session; drop its broker bookkeeping. */
  retire(principal: BrokerPrincipal, sessionId: string): void {
    const actor = this.actors.get(sessionId);
    if (actor !== undefined && actor.principal.clientId === principal.clientId)
      this.actors.delete(sessionId);
  }

  async close(
    principal: BrokerPrincipal,
    sessionId: string,
    terminalProven = false,
  ): Promise<boolean> {
    if (terminalProven && !this.actors.has(sessionId)) return true;
    return await this.closeActor(this.resolve(principal, sessionId), "finish");
  }

  private closeActor(
    actor: Actor,
    reason: "finish" | "disconnect" = "disconnect",
  ): Promise<boolean> {
    if (actor.closePromise !== undefined) return actor.closePromise;
    actor.abort.abort();
    actor.closePromise = (async () => {
      await actor.tail.catch(() => undefined);
      const proven = await actor.port.close(reason).catch(() => false);
      if (proven) this.actors.delete(actor.sessionId);
      return proven;
    })();
    return actor.closePromise;
  }

  private async closeOwnedSessions(clientId: string, reason: "finish" | "disconnect") {
    await Promise.all(
      [...this.actors.values()]
        .filter((actor) => actor.principal.clientId === clientId)
        .map(async (actor) => await this.closeActor(actor, reason)),
    );
  }

  async disconnect(principal: BrokerPrincipal, explicit = false): Promise<void> {
    this.assertPrincipal(principal);
    for (const admission of this.admissions.values())
      if (admission.clientId === principal.clientId) admission.abort.abort();
    if (explicit || this.actors.size === 0) {
      await this.closeOwnedSessions(principal.clientId, "disconnect");
      return;
    }
    // A dropped socket gets a short grace so a tab family is not torn down for
    // a momentary blip. The reconnecting client starts fresh either way.
    const clientId = principal.clientId;
    this.pendingGraceCloses.add(clientId);
    const timer = setTimeout(() => {
      void this.closeOwnedSessions(clientId, "disconnect").finally(() =>
        this.pendingGraceCloses.delete(clientId),
      );
    }, CONNECTION_SESSION_GRACE_MS);
    timer.unref();
  }

  inventory(): { sessions: number; admitting: number; closing: number } {
    return {
      sessions: this.actors.size,
      admitting: this.admissions.size,
      closing: this.pendingGraceCloses.size,
    };
  }
}
