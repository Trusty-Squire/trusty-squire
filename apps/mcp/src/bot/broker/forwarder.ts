import { awaitOperatorPreparation } from "../request-cancellation.js";
import { connectOrLaunchBroker } from "./discovery.js";
import { createHash, randomUUID } from "node:crypto";
import type { SessionGuard } from "../../session-guard.js";
import type { BrokerClient, BrokerNotifier } from "./transport.js";
import type { TabCapability } from "./authority.js";
import { BrokerRefusal } from "./scheduler.js";
import { requireLineageCredential } from "./lineage.js";
import { ProvenPreDispatchMutationError } from "../mutation-dispatch-evidence.js";

export interface BrokerRecoveryRequest {
  recover?: boolean;
  preDispatchFailure?: {
    requestId: string;
    error: "stale_ref";
    dispatch: "not_dispatched";
  };
}

export class ForwardedResultError extends BrokerRefusal {
  constructor(
    message: string,
    readonly detail: Record<string, unknown>,
  ) {
    super("invalid_broker_result", message);
    this.name = "ForwardedResultError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** How long a fresh start waits for this lineage's own unsettled dispatched
 * work to settle before reconciling it in-band. Just above the MCP server's
 * 2s settlement window so ordinary cancellations settle on their own. */
const UNSETTLED_WORK_GRACE_MS = 2_500;

interface UnsettledDispatch {
  paymentCapable: boolean;
  settled: Promise<void>;
}

/** The MCP process holds only opaque capabilities. Never reconnect/replay a
 * dispatched request after transport loss: its side effect may have happened. */
export class OperatorForwarder {
  private connection: Promise<BrokerClient> | undefined;
  private client: BrokerClient | undefined;
  private connecting = false;
  private readonly sessions = new Map<string, TabCapability>();
  private readonly unsettledDispatches = new Map<string, UnsettledDispatch>();
  private readonly lineageCredential: string;
  private readonly invocationNamespace = randomUUID();
  constructor(
    private readonly path: string,
    private readonly guard: SessionGuard,
    credential?: string,
  ) {
    this.lineageCredential = credential ?? this.loadCredential();
  }
  private loadCredential(): string {
    return requireLineageCredential();
  }
  private connect(): Promise<BrokerClient> {
    if (this.connection === undefined) {
      this.connecting = true;
      this.connection = (async () => {
        const session = await this.guard.bind();
        if (session?.agent_session_token === undefined)
          throw new BrokerRefusal("unauthorized", "Connect before using the broker");
        const client = await connectOrLaunchBroker(
          this.path,
          session.agent_session_token,
          this.lineageCredential,
        );
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = false;
      });
    }
    return this.connection;
  }
  private async reclaim(client: BrokerClient): Promise<void> {
    const reply = (await client.call("reclaim", {})) as { capabilities?: TabCapability[] };
    for (const capability of reply.capabilities ?? [])
      this.sessions.set(capability.sessionId, capability);
  }
  private callerRequestHash(requestId: string): string {
    return createHash("sha256").update(requestId).digest("hex");
  }
  private idempotencyKey(callerRequestHash: string): string {
    return `${this.invocationNamespace}:${callerRequestHash}`;
  }
  private async recover(
    client: BrokerClient,
    name: string,
    args: Record<string, unknown>,
    capability: TabCapability | undefined,
    recovery: BrokerRecoveryRequest,
    requestId?: string,
  ): Promise<{ requestId: string; result: unknown; capability?: TabCapability } | undefined> {
    const reply = (await client.call("recover", {
      name,
      args,
      ...(capability === undefined ? {} : { capability }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(recovery.preDispatchFailure === undefined
        ? {}
        : { preDispatchFailure: recovery.preDispatchFailure }),
    })) as { requestId?: unknown; result?: unknown; capability?: unknown } | null;
    return typeof reply?.requestId === "string"
      ? {
          requestId: reply.requestId,
          result: reply.result,
          ...(this.isCapability(reply.capability) ? { capability: reply.capability } : {}),
        }
      : undefined;
  }
  private async confirmStartDelivery(
    client: BrokerClient,
    capability: TabCapability,
  ): Promise<void> {
    await client.confirmStartDelivery(capability);
  }
  /** A dispatched-but-never-settled forwarded call wedges this lineage: the
   * broker never replies (cancelled benign browsing whose reply was lost with
   * the old broker), the MCP response already surfaced outcome_unknown, and
   * every fresh start on the same credential would stay fenced until the
   * client process itself is replaced. That escape hatch is only justified
   * for genuinely uncertain PAYMENT custody. When the lineage's only
   * unsettled work is benign non-payment browsing, reconcile the fence
   * in-band and admit the fresh start without a client reconnect. */
  private async reconcileUnsettledForFreshStart(): Promise<void> {
    if (this.unsettledDispatches.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([...this.unsettledDispatches.values()].map((entry) => entry.settled)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, UNSETTLED_WORK_GRACE_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if ([...this.unsettledDispatches.values()].some((entry) => entry.paymentCapable)) return;
    // Benign cancelled browsing only: reconcile the lineage fence in-band.
    this.unsettledDispatches.clear();
  }
  private isCapability(value: unknown): value is TabCapability {
    if (value === null || typeof value !== "object") return false;
    const capability = value as Record<string, unknown>;
    return ["cellId", "browserEpoch", "sessionId", "targetId", "leaseGeneration"].every(
      (key) => typeof capability[key] === "string",
    );
  }
  async invoke(
    name: string,
    args: Record<string, unknown>,
    requestId: string = randomUUID(),
    recovery: BrokerRecoveryRequest = {},
    signal?: AbortSignal,
    notifyUser?: BrokerNotifier,
  ): Promise<unknown> {
    const callerRequestHash = this.callerRequestHash(requestId);
    const idempotencyKey = this.idempotencyKey(callerRequestHash);
    let dispatchedClient: BrokerClient | undefined;
    let settleDispatch: (() => void) | undefined;
    const checkCancelled = (): void => {
      if (signal?.aborted)
        throw signal.reason ?? new BrokerRefusal("cancelled", "Request cancelled before dispatch");
    };
    const cancel = (): void => {
      void dispatchedClient?.call("cancel", { requestId: idempotencyKey }).catch(() => undefined);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      checkCancelled();
      const starting =
        name === "operate_start" ||
        (name === "operate_recipe_run" && args.session_id === undefined);
      let reconnecting = false;
      if (this.connection !== undefined) {
        const existing = await awaitOperatorPreparation(
          this.connection.catch(() => undefined),
          signal,
        );
        checkCancelled();
        if (existing === undefined || !existing.isConnected()) {
          this.connection = undefined;
          this.client = undefined;
          reconnecting = true;
        }
      }
      const client = await awaitOperatorPreparation(this.connect(), signal);
      checkCancelled();
      if (reconnecting) this.sessions.clear();
      await awaitOperatorPreparation(this.reclaim(client), signal);
      checkCancelled();
      if (!starting && args.session_id === undefined && this.sessions.size === 1)
        args = { ...args, session_id: this.sessions.keys().next().value };
      const id = typeof args.session_id === "string" ? args.session_id : undefined;
      const capability = id === undefined ? undefined : this.sessions.get(id);
      const recovered = recovery.recover
        ? await awaitOperatorPreparation(
            this.recover(client, name, args, capability, recovery),
            signal,
          )
        : undefined;
      checkCancelled();
      if (recovered !== undefined) {
        if (recovered.capability !== undefined)
          this.sessions.set(recovered.capability.sessionId, recovered.capability);
        await client.acknowledge(recovered.requestId);
        if (
          name === "operate_finish" &&
          id !== undefined &&
          typeof recovered.result === "object" &&
          recovered.result !== null &&
          "closed" in recovered.result &&
          recovered.result.closed === true
        )
          this.sessions.delete(id);
        return recovered.result;
      }
      if (
        name !== "operate_start" &&
        !(name === "operate_recipe_run" && id === undefined) &&
        capability === undefined &&
        name !== "operate_finish"
      )
        throw new BrokerRefusal("stale_lease", "Session is not owned by this MCP connection");
      if (!starting && name !== "operate_finish" && capability !== undefined)
        await awaitOperatorPreparation(this.confirmStartDelivery(client, capability), signal);
      if (starting) await awaitOperatorPreparation(this.reconcileUnsettledForFreshStart(), signal);
      if (recovery.recover)
        throw new BrokerRefusal("recovery_not_found", "No matching durable outcome is available");
      checkCancelled();
      dispatchedClient = client;
      let settle!: () => void;
      const dispatchSettled = new Promise<void>((resolve) => (settle = resolve));
      settleDispatch = settle;
      this.unsettledDispatches.set(idempotencyKey, {
        paymentCapable: name === "inject_card" || "capture" in args,
        settled: dispatchSettled,
      });
      const brokerCall = client.call(
        "tool",
        {
          name,
          args,
          ...(capability === undefined ? {} : { capability }),
        },
        idempotencyKey,
        notifyUser,
      );
      const rawReply = await brokerCall;
      if (!isRecord(rawReply))
        throw new ForwardedResultError("Broker returned a non-object tool reply", {
          cleanup: "unknown",
          closed: false,
        });
      const reply = rawReply;
      const preDispatchFailure = isRecord(reply.preDispatchFailure)
        ? reply.preDispatchFailure
        : undefined;
      if (
        preDispatchFailure?.error === "stale_ref" &&
        preDispatchFailure.dispatch === "not_dispatched"
      ) {
        await client.acknowledge(idempotencyKey);
        throw new ProvenPreDispatchMutationError("stale_ref");
      }
      const replyCapability = this.isCapability(reply.capability) ? reply.capability : undefined;
      if (name === "operate_start") {
        const result = isRecord(reply.result) ? reply.result : undefined;
        const returnedSessionId = result?.session_id;
        const refusedStart = isRecord(result?.needs_user);
        const validStartResult =
          typeof returnedSessionId === "string" &&
          returnedSessionId.length > 0 &&
          (replyCapability !== undefined
            ? returnedSessionId === replyCapability.sessionId
            : refusedStart);
        if (!validStartResult) {
          const recovered = await this.recover(
            client,
            name,
            args,
            undefined,
            {
              recover: true,
            },
            idempotencyKey,
          ).catch(() => undefined);
          const recoveredResult = isRecord(recovered?.result) ? recovered.result : undefined;
          const recoveredSessionId = recoveredResult?.session_id;
          const recoveredCapability = recovered?.capability;
          if (
            recovered !== undefined &&
            recovered.requestId === idempotencyKey &&
            recoveredCapability !== undefined &&
            typeof recoveredSessionId === "string" &&
            recoveredSessionId === recoveredCapability.sessionId &&
            (replyCapability === undefined ||
              recoveredCapability.sessionId === replyCapability.sessionId)
          ) {
            this.sessions.set(recoveredCapability.sessionId, recoveredCapability);
            await client.acknowledge(recovered.requestId);
            return recoveredResult;
          }
          if (replyCapability !== undefined) {
            this.sessions.set(replyCapability.sessionId, replyCapability);
            throw new ForwardedResultError(
              "Broker retained startup custody but did not return a valid startup result",
              {
                session_id: replyCapability.sessionId,
                cleanup: "open",
                closed: false,
                recovery: {
                  tool: "operate_finish",
                  session_id: replyCapability.sessionId,
                },
              },
            );
          }
          throw new ForwardedResultError("Broker did not return a valid startup result", {
            cleanup: "unknown",
            closed: false,
          });
        }
        if (replyCapability !== undefined)
          this.sessions.set(replyCapability.sessionId, replyCapability);
      } else if (replyCapability !== undefined) {
        this.sessions.set(replyCapability.sessionId, replyCapability);
      }
      await client.acknowledge(idempotencyKey);
      if (
        name === "operate_finish" &&
        id !== undefined &&
        typeof reply.result === "object" &&
        reply.result !== null &&
        "closed" in reply.result &&
        reply.result.closed === true
      )
        this.sessions.delete(id);
      return reply.result;
    } finally {
      settleDispatch?.();
      this.unsettledDispatches.delete(idempotencyKey);
      signal?.removeEventListener("abort", cancel);
    }
  }

  sessionCount(): number {
    return this.sessions.size;
  }
  connected(): boolean {
    return this.client?.isConnected() ?? this.connecting;
  }
  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    const client = this.client ?? (await connection?.catch(() => undefined));
    this.client = undefined;
    await client?.close();
    this.sessions.clear();
  }
}
