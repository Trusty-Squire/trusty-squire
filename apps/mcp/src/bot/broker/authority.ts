import { withBrokerIdentityLane } from "./identity-lane.js";
import { randomUUID } from "node:crypto";
import { BrokerRefusal, ScopeScheduler } from "./scheduler.js";

export interface BrokerPrincipal {
  accountId: string;
  agentId: string;
  forwarderId?: string;
  clientId: string;
  supervisor?: true;
}
export interface TabCapability {
  cellId: string;
  browserEpoch: string;
  sessionId: string;
  targetId: string;
  leaseGeneration: string;
}
export interface BrokerSessionPort {
  targetId: string;
  invoke(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    requestId: string,
  ): Promise<unknown>;
  /** True only after owned tabs and pending outcome custody are resolved. */
  close(reason?: "finish" | "disconnect" | "expiry"): Promise<boolean>;
}
export const FORWARDER_HANDOFF_TIMEOUT_MS = 120_000;
export const DETACHED_EXPIRY_CLOSE_TIMEOUT_MS = 10_000;
// Match the durable start-delivery retention window: a socket restart must not
// destroy the live capability while its acknowledged start is still recoverable.
export const FORWARDER_RECONNECT_GRACE_MS = 5 * 60_000;
interface ForwarderConnection {
  clientId: string;
  detach?: { promise: Promise<void>; resolve: () => void };
}
interface Admission {
  principal: BrokerPrincipal;
  abort: AbortController;
  reconnectDeadline?: number;
}
interface Actor {
  principal: BrokerPrincipal;
  capability: TabCapability;
  port: BrokerSessionPort;
  abort: AbortController;
  state: "active" | "detached" | "closing" | "quarantined";
  tail: Promise<void>;
  replies: Map<string, { input: string; result: Promise<unknown> }>;
  pending: number;
  closePromise?: Promise<boolean>;
  closeReason?: "finish" | "disconnect";
  reconnectDeadline?: number;
  expiryQuarantined?: boolean;
}

/** This object lives only in the broker. No Page, Browser or CDP handle crosses
 * the transport. A principal is established by authenticated connection setup. */
export class BrokerAuthority {
  private epochValue: string = randomUUID();
  get epoch(): string {
    return this.epochValue;
  }
  rotateEpoch(): void {
    if (this.actors.size !== 0 || this.admissions.size !== 0)
      throw new BrokerRefusal("maintenance", "Session custody has not drained");
    this.epochValue = randomUUID();
  }
  private readonly actors = new Map<string, Actor>();
  private readonly admissions = new Map<string, Admission>();
  private readonly forwarderConnections = new Map<string, ForwarderConnection>();
  private readonly fencedClients = new Set<string>();
  private readonly scheduler = new ScopeScheduler();
  private readonly lanes = new ScopeScheduler();
  private detachedExpiryHandler:
    | ((capability: TabCapability, principal: BrokerPrincipal) => Promise<void> | void)
    | undefined;

  constructor(
    readonly accountId: string,
    readonly cellId: string,
    private readonly maxSessions = 3,
    private readonly detachedExpiryCloseTimeoutMs = DETACHED_EXPIRY_CLOSE_TIMEOUT_MS,
  ) {}

  setDetachedExpiryHandler(
    handler: (capability: TabCapability, principal: BrokerPrincipal) => Promise<void> | void,
  ): void {
    this.detachedExpiryHandler = handler;
  }

  private assertPrincipal(principal: BrokerPrincipal): void {
    if (
      principal.accountId !== this.accountId ||
      this.fencedClients.has(principal.clientId) ||
      (principal.forwarderId !== undefined &&
        this.forwarderConnections.get(principal.forwarderId)?.clientId !== principal.clientId)
    ) {
      throw new BrokerRefusal("unauthorized", "Client is not admitted to this identity cell");
    }
  }

  claimForwarder(principal: BrokerPrincipal): Promise<void> | void {
    if (principal.accountId !== this.accountId)
      throw new BrokerRefusal("unauthorized", "Client is not admitted to this identity cell");
    const forwarderId = principal.forwarderId;
    if (forwarderId === undefined)
      throw new BrokerRefusal("unauthorized", "Client has no forwarder lineage");
    const holder = this.forwarderConnections.get(forwarderId);
    if (holder === undefined) {
      this.forwarderConnections.set(forwarderId, { clientId: principal.clientId });
      return;
    }
    if (holder.clientId === principal.clientId) return;
    if (holder.detach === undefined)
      throw new BrokerRefusal("forwarder_in_use", "Forwarder identity is already active");
    return this.waitForDetach(holder.detach).then(() => this.claimForwarder(principal));
  }

  beginForwarderRelease(principal: BrokerPrincipal): void {
    const forwarderId = principal.forwarderId;
    if (forwarderId === undefined) return;
    const holder = this.forwarderConnections.get(forwarderId);
    if (
      holder === undefined ||
      holder.clientId !== principal.clientId ||
      holder.detach !== undefined
    )
      return;
    let resolve!: () => void;
    const promise = new Promise<void>((settled) => {
      resolve = settled;
    });
    holder.detach = { promise, resolve };
  }

  private async waitForDetach(detach: ForwarderConnection["detach"]): Promise<void> {
    if (detach === undefined) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        detach.promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new BrokerRefusal(
                  "forwarder_handoff_timeout",
                  "Forwarder cleanup did not complete",
                ),
              ),
            FORWARDER_HANDOFF_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  releaseForwarder(principal: BrokerPrincipal): void {
    const forwarderId = principal.forwarderId;
    if (forwarderId === undefined) return;
    const holder = this.forwarderConnections.get(forwarderId);
    if (holder?.clientId === principal.clientId) {
      this.forwarderConnections.delete(forwarderId);
      holder.detach?.resolve();
    }
  }

  async open(
    principal: BrokerPrincipal,
    resources: readonly string[],
    create: (
      sessionId: string,
      signal: AbortSignal,
      reserve: (resources: readonly string[]) => void,
    ) => Promise<BrokerSessionPort>,
    cleanupFailedAdmission?: (sessionId: string) => Promise<boolean>,
  ): Promise<TabCapability> {
    this.assertPrincipal(principal);
    if (
      this.actors.size + this.admissions.size >=
      this.maxSessions
    ) {
      throw new BrokerRefusal("capacity", "Identity cell is at capacity");
    }
    const id = randomUUID();
    const abort = new AbortController();
    this.admissions.set(id, { principal: { ...principal }, abort });
    let port: BrokerSessionPort | undefined;
    let creating = false;
    try {
      await this.scheduler.reserve(id, resources, abort.signal);
      if (this.admissions.get(id)?.reconnectDeadline === undefined) this.assertPrincipal(principal);
      creating = true;
      port = await create(id, abort.signal, (resources) => this.scheduler.expand(id, resources));
      const capability: TabCapability = {
        cellId: this.cellId,
        browserEpoch: this.epoch,
        sessionId: id,
        targetId: port.targetId,
        leaseGeneration: randomUUID(),
      };
      const actor: Actor = {
        principal: { ...principal },
        capability,
        port,
        abort,
        state: "active",
        tail: Promise.resolve(),
        replies: new Map(),
        pending: 0,
      };
      this.actors.set(id, actor);
      const reconnectDeadline = this.admissions.get(id)?.reconnectDeadline;
      if (reconnectDeadline !== undefined) {
        actor.state = "detached";
        actor.closeReason = "disconnect";
        actor.reconnectDeadline = reconnectDeadline;
      } else if (abort.signal.aborted || this.fencedClients.has(principal.clientId)) {
        await this.closeActor(actor);
        throw new BrokerRefusal("cancelled", "Client disconnected during admission");
      }
      return { ...capability };
    } catch (error) {
      if (port === undefined && !creating) this.scheduler.release(id);
      else if (port === undefined) {
        const reconnectDeadline = this.admissions.get(id)?.reconnectDeadline;
        // The factory may have launched a page before throwing. Never infer
        // successful cleanup from a rejected admission promise.
        const failed: Actor = {
          principal: { ...principal },
          capability: {
            cellId: this.cellId,
            browserEpoch: this.epoch,
            sessionId: id,
            targetId: "unproven-admission",
            leaseGeneration: randomUUID(),
          },
          port: {
            targetId: "unproven-admission",
            invoke: async () => {
              throw error;
            },
            close: async () => (await cleanupFailedAdmission?.(id)) ?? false,
          },
          abort,
          state: reconnectDeadline === undefined ? "quarantined" : "detached",
          tail: Promise.resolve(),
          replies: new Map(),
          pending: 0,
          ...(reconnectDeadline === undefined
            ? {}
            : { closeReason: "disconnect" as const, reconnectDeadline }),
        };
        this.actors.set(id, failed);
      }
      const failed = this.actors.get(id);
      if (
        port === undefined &&
        failed !== undefined &&
        failed.state !== "detached"
      )
        await this.closeActor(failed);
      throw error;
    } finally {
      this.admissions.delete(id);
    }
  }

  private resolve(principal: BrokerPrincipal, capability: TabCapability): Actor {
    this.assertPrincipal(principal);
    const actor = this.actors.get(capability.sessionId);
    if (
      actor === undefined ||
      actor.principal.forwarderId !== principal.forwarderId ||
      actor.principal.agentId !== principal.agentId ||
      capability.cellId !== this.cellId ||
      capability.browserEpoch !== this.epoch ||
      capability.leaseGeneration !== actor.capability.leaseGeneration ||
      capability.targetId !== actor.capability.targetId
    ) {
      throw new BrokerRefusal("stale_lease", "Capability does not name an owned live session");
    }
    if (actor.state === "active" && actor.principal.clientId !== principal.clientId)
      throw new BrokerRefusal("forwarder_in_use", "Forwarder identity is already active");
    actor.principal = { ...principal };
    return actor;
  }

  reclaim(principal: BrokerPrincipal): TabCapability[] {
    this.assertPrincipal(principal);
    const owned = [...this.actors.values()].filter(
      (actor) => actor.principal.forwarderId === principal.forwarderId,
    );
    if (
      owned.some(
        (actor) => actor.state === "active" && actor.principal.clientId !== principal.clientId,
      )
    )
      throw new BrokerRefusal("forwarder_in_use", "Forwarder identity is already active");
    const now = Date.now();
    return owned.flatMap((actor) => {
      if (actor.state === "detached" && (actor.reconnectDeadline ?? 0) <= now) return [];
      if (actor.expiryQuarantined) return [];
      actor.principal = { ...principal };
      if (actor.state === "detached") {
        actor.abort = new AbortController();
        actor.state = "active";
        delete actor.reconnectDeadline;
      } else if (actor.state === "quarantined") {
        // A failed disconnect cleanup can mean an uncertain payment remains in
        // journal custody. Same-lineage status/reconciliation must stay usable,
        // while the journal continues to block every fresh mutation.
        if (actor.closeReason === "disconnect") actor.abort = new AbortController();
        actor.state = "active";
      }
      return [{ ...actor.capability }];
    });
  }

  recoverCapability(principal: BrokerPrincipal, sessionId: string): TabCapability | undefined {
    this.assertPrincipal(principal);
    const actor = this.actors.get(sessionId);
    if (
      actor === undefined ||
      actor.state !== "active" ||
      actor.principal.forwarderId !== principal.forwarderId ||
      actor.principal.agentId !== principal.agentId
    )
      return undefined;
    actor.principal = { ...principal };
    return { ...actor.capability };
  }

  hasCapability(principal: BrokerPrincipal, capability: TabCapability): boolean {
    this.assertPrincipal(principal);
    const actor = this.actors.get(capability.sessionId);
    return (
      actor !== undefined &&
      actor.state === "active" &&
      actor.principal.clientId === principal.clientId &&
      actor.principal.forwarderId === principal.forwarderId &&
      actor.principal.agentId === principal.agentId &&
      capability.cellId === this.cellId &&
      capability.browserEpoch === this.epoch &&
      capability.leaseGeneration === actor.capability.leaseGeneration &&
      capability.targetId === actor.capability.targetId
    );
  }

  invoke(
    principal: BrokerPrincipal,
    capability: TabCapability,
    requestId: string,
    name: string,
    args: Record<string, unknown>,
    resources: readonly string[] = [],
    lane?: "oauth" | "interactive",
  ): Promise<unknown> {
    const actor = this.resolve(principal, capability);
    if (actor.state !== "active") throw new BrokerRefusal("session_closing", "Session is fenced");
    const input = JSON.stringify([name, args, resources, lane]);
    // Capture this connection lease. A reconnect installs a fresh controller;
    // queued work from the lost socket must stay aborted rather than becoming
    // executable merely because the actor is active again.
    const invocationLease = actor.abort;
    const previous = actor.replies.get(requestId);
    if (previous !== undefined) {
      if (previous.input !== input)
        throw new BrokerRefusal("request_id_reused", "Request ID has different input");
      return previous.result;
    }
    // Never evict deduplication evidence and make an old submit executable again.
    if (actor.replies.size >= 4096 || actor.pending >= 64) {
      throw new BrokerRefusal("capacity", "Session command budget exhausted");
    }
    actor.pending += 1;
    const result = actor.tail.then(async () => {
      if (actor.state !== "active" || invocationLease.signal.aborted) {
        throw new BrokerRefusal("session_closing", "Command fenced before dispatch");
      }
      this.scheduler.expand(actor.capability.sessionId, resources);
      const laneOwner = randomUUID();
      if (lane !== undefined) await this.lanes.reserve(laneOwner, [lane], invocationLease.signal);
      try {
        if (invocationLease.signal.aborted)
          throw new BrokerRefusal("cancelled", "Command fenced before dispatch");
        const execute = async () =>
          await actor.port.invoke(name, args, invocationLease.signal, requestId);
        return lane === "oauth"
          ? await withBrokerIdentityLane(execute, invocationLease.signal)
          : await execute();
      } finally {
        if (lane !== undefined) this.lanes.release(laneOwner);
      }
    });
    const trackedResult = result.catch((error: unknown) => {
      if (error instanceof BrokerRefusal && error.code === "browser_lost") {
        actor.state = "quarantined";
        actor.abort.abort();
      }
      throw error;
    });
    actor.tail = trackedResult
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        actor.pending -= 1;
      });
    actor.replies.set(requestId, { input, result: trackedResult });
    return trackedResult;
  }

  async close(principal: BrokerPrincipal, capability: TabCapability): Promise<boolean> {
    return await this.closeActor(this.resolve(principal, capability), "finish");
  }

  private closeActor(
    actor: Actor,
    reason: "finish" | "disconnect" = "disconnect",
  ): Promise<boolean> {
    if (actor.closePromise !== undefined) return actor.closePromise;
    actor.state = "closing";
    actor.closeReason = reason;
    actor.abort.abort();
    actor.closePromise = (async () => {
      await actor.tail.catch(() => undefined);
      const proven = await actor.port.close(reason).catch(() => false);
      if (!proven) {
        actor.state = "quarantined";
        delete actor.closePromise;
        return false;
      }
      this.actors.delete(actor.capability.sessionId);
      this.scheduler.release(actor.capability.sessionId);
      return true;
    })();
    return actor.closePromise;
  }

  private async completeWithinDetachedExpiryTimeout<T>(
    work: () => Promise<T>,
  ): Promise<{ completed: true; value: T } | { completed: false }> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(work)
          .then(
            (value) => ({ completed: true as const, value }),
            () => ({ completed: false as const }),
          ),
        new Promise<{ completed: false }>((resolve) => {
          timeout = setTimeout(
            () => resolve({ completed: false }),
            this.detachedExpiryCloseTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private markExpiryQuarantined(actor: Actor): void {
    actor.state = "quarantined";
    actor.expiryQuarantined = true;
    delete actor.reconnectDeadline;
  }

  private async quarantineExpiredActor(actor: Actor): Promise<void> {
    const handled = await this.completeWithinDetachedExpiryTimeout(async () => {
      await this.detachedExpiryHandler?.(actor.capability, actor.principal);
    });
    if (!handled.completed) {
      this.markExpiryQuarantined(actor);
      return;
    }
    const closed = await this.completeWithinDetachedExpiryTimeout(
      async () => await actor.port.close("expiry"),
    );
    if (closed.completed && closed.value) {
      this.actors.delete(actor.capability.sessionId);
      this.scheduler.release(actor.capability.sessionId);
      return;
    }
    this.markExpiryQuarantined(actor);
  }

  private async closeSettledExpiredActor(actor: Actor): Promise<void> {
    const closed = await this.completeWithinDetachedExpiryTimeout(
      async () => await actor.port.close("expiry"),
    );
    if (closed.completed && closed.value) {
      this.actors.delete(actor.capability.sessionId);
      this.scheduler.release(actor.capability.sessionId);
      return;
    }
    this.markExpiryQuarantined(actor);
  }

  async disconnect(principal: BrokerPrincipal): Promise<void> {
    this.assertPrincipal(principal);
    this.fencedClients.add(principal.clientId);
    for (const admission of this.admissions.values()) {
      if (admission.principal.clientId === principal.clientId) admission.abort.abort();
    }
    await Promise.all(
      [...this.actors.values()]
        .filter((actor) => actor.principal.clientId === principal.clientId)
        .map(async (actor) => await this.closeActor(actor)),
    );
  }

  detach(
    principal: BrokerPrincipal,
    now = Date.now(),
    graceMs = FORWARDER_RECONNECT_GRACE_MS,
  ): void {
    this.assertPrincipal(principal);
    this.fencedClients.add(principal.clientId);
    for (const admission of this.admissions.values()) {
      if (admission.principal.clientId !== principal.clientId) continue;
      admission.reconnectDeadline = now + graceMs;
      admission.abort.abort();
    }
    for (const actor of this.actors.values()) {
      if (actor.principal.clientId !== principal.clientId || actor.state !== "active") continue;
      actor.state = "detached";
      actor.closeReason = "disconnect";
      actor.reconnectDeadline = now + graceMs;
      actor.abort.abort();
    }
  }

  async expireDetached(now = Date.now()): Promise<void> {
    const expired = [...this.actors.values()].filter(
      (actor) =>
        actor.state === "detached" &&
        (actor.reconnectDeadline ?? Number.POSITIVE_INFINITY) <= now,
    );
    await Promise.all(
      expired.map(async (actor) => {
        actor.state = "closing";
        actor.closeReason = "disconnect";
        actor.abort.abort();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const drained = await Promise.race([
            actor.tail.then(
              () => true,
              () => true,
            ),
            new Promise<false>((resolve) => {
              timeout = setTimeout(() => resolve(false), this.detachedExpiryCloseTimeoutMs);
            }),
          ]);
          if (!drained) {
            await this.quarantineExpiredActor(actor);
            return;
          }
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
        await this.closeSettledExpiredActor(actor);
      }),
    );
  }

  hasReconnectGrace(now = Date.now()): boolean {
    return (
      [...this.admissions.values()].some(
        (admission) => (admission.reconnectDeadline ?? 0) > now,
      ) ||
      [...this.actors.values()].some(
        (actor) =>
          actor.state === "detached" && (actor.reconnectDeadline ?? 0) > now,
      )
    );
  }

  fenceRuntime(): void {
    for (const actor of this.actors.values()) {
      actor.state = "quarantined";
      actor.abort.abort();
    }
    for (const admission of this.admissions.values()) admission.abort.abort();
  }

  async retryQuarantined(
    shouldClose: (
      capability: TabCapability,
      principal: BrokerPrincipal,
    ) => Promise<boolean> | boolean = () => true,
  ): Promise<void> {
    for (const actor of [...this.actors.values()]) {
      if (actor.state !== "quarantined") continue;
      if (actor.expiryQuarantined) continue;
      if (!(await shouldClose(actor.capability, actor.principal))) continue;
      await this.closeActor(actor, actor.closeReason ?? "disconnect");
    }
  }

  inventory(): { active: number; quarantined: number; admitting: number } {
    return {
      active: [...this.actors.values()].filter((actor) => actor.state === "active").length,
      quarantined: [...this.actors.values()].filter(
        (actor) => actor.state === "quarantined" || actor.state === "detached",
      ).length,
      admitting: this.admissions.size,
    };
  }
}
