import { awaitOperatorPreparation } from "../request-cancellation.js";
import { connectOrLaunchBroker } from "./discovery.js";
import { randomUUID } from "node:crypto";
import type { SessionGuard } from "../../session-guard.js";
import type { BrokerClient, BrokerNotifier } from "./transport.js";
import { BrokerRefusal } from "./refusal.js";
import { ProvenPreDispatchMutationError } from "../mutation-dispatch-evidence.js";

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

/** The MCP process holds only plain session ids. Never reconnect/replay a
 * dispatched request after transport loss: its side effect may have happened. */
export class OperatorForwarder {
  private connection: Promise<BrokerClient> | undefined;
  private client: BrokerClient | undefined;
  private connecting = false;
  private readonly sessions = new Set<string>();
  constructor(
    private readonly path: string,
    private readonly guard: SessionGuard,
  ) {}
  private connect(): Promise<BrokerClient> {
    if (this.connection === undefined) {
      this.connecting = true;
      this.connection = (async () => {
        const session = await this.guard.bind();
        if (session?.agent_session_token === undefined)
          throw new BrokerRefusal("unauthorized", "Connect before using the broker");
        const client = await connectOrLaunchBroker(this.path, session.agent_session_token);
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = false;
      });
    }
    return this.connection;
  }
  private isSessionId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
  }
  async invoke(
    name: string,
    args: Record<string, unknown>,
    requestId: string = randomUUID(),
    signal?: AbortSignal,
    notifyUser?: BrokerNotifier,
  ): Promise<unknown> {
    let dispatchedClient: BrokerClient | undefined;
    const checkCancelled = (): void => {
      if (signal?.aborted)
        throw signal.reason ?? new BrokerRefusal("cancelled", "Request cancelled before dispatch");
    };
    const cancel = (): void => {
      void dispatchedClient?.call("cancel", { requestId }).catch(() => undefined);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      checkCancelled();
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
      // A fresh connection owns no sessions: its ids belong to the lost socket
      // and the broker refuses them.
      if (reconnecting) this.sessions.clear();
      if (name !== "operate_start" && args.session_id === undefined && this.sessions.size === 1)
        args = { ...args, session_id: this.sessions.values().next().value };
      const id = typeof args.session_id === "string" ? args.session_id : undefined;
      const sessionId = id !== undefined && this.sessions.has(id) ? id : undefined;
      if (
        name !== "operate_start" &&
        sessionId === undefined &&
        name !== "operate_finish"
      )
        throw new BrokerRefusal("stale_lease", "Session is not owned by this MCP connection");
      checkCancelled();
      dispatchedClient = client;
      const rawReply = await client.call(
        "tool",
        {
          name,
          args,
          ...(sessionId === undefined ? {} : { capability: sessionId }),
        },
        requestId,
        notifyUser,
      );
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
      )
        throw new ProvenPreDispatchMutationError("stale_ref");
      const replyCapability = this.isSessionId(reply.capability) ? reply.capability : undefined;
      if (name === "operate_start") {
        const result = isRecord(reply.result) ? reply.result : undefined;
        const returnedSessionId = result?.session_id;
        const refusedStart = isRecord(result?.needs_user);
        const validStartResult =
          typeof returnedSessionId === "string" &&
          returnedSessionId.length > 0 &&
          (replyCapability !== undefined
            ? returnedSessionId === replyCapability
            : refusedStart);
        if (!validStartResult)
          throw new ForwardedResultError("Broker did not return a valid startup result", {
            ...(replyCapability === undefined ? {} : { session_id: replyCapability }),
            cleanup: replyCapability === undefined ? "unknown" : "open",
            closed: false,
          });
        if (replyCapability !== undefined) this.sessions.add(replyCapability);
      } else if (replyCapability !== undefined) {
        this.sessions.add(replyCapability);
      }
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
