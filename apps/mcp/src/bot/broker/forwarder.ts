import { awaitOperatorPreparation } from "../request-cancellation.js";
import { connectOrLaunchBroker } from "./discovery.js";
import { randomUUID } from "node:crypto";
import type { SessionGuard } from "../../session-guard.js";
import type { BrokerClient, BrokerNotifier } from "./transport.js";
import { BrokerRefusal } from "./refusal.js";
import { ProvenPreDispatchMutationError } from "../mutation-dispatch-evidence.js";
import type { BrokerWireMethod, CloseRequest, CommandRequest, OpenRequest } from "./protocol.js";

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

/** A refused start never minted an owned session. Follow-up operate_* calls
 * on that id must replay the wall, not `stale_lease`. Finish matches the
 * broker-side refused-start receipt (closed, nothing dispatched). */
function refusedStartFinishReceipt(sessionId: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    operation_id: randomUUID(),
    execution: "completed",
    mutation: "not_dispatched",
    cleanup: "closed",
    closed: true,
    url: "",
  };
}

function parseOpenReply(raw: unknown): {
  observation: Record<string, unknown>;
  sessionId?: string;
  owned: boolean;
} {
  if (!isRecord(raw))
    throw new ForwardedResultError("Broker returned a non-object open reply", {
      cleanup: "unknown",
      closed: false,
    });
  const observation = isRecord(raw.observation) ? raw.observation : undefined;
  const returnedSessionId = observation?.session_id;
  const owned = typeof raw.sessionId === "string" && raw.sessionId.length > 0;
  const refusedStart = isRecord(observation?.needs_user);
  const validStartResult =
    typeof returnedSessionId === "string" &&
    returnedSessionId.length > 0 &&
    (owned ? returnedSessionId === raw.sessionId : refusedStart);
  if (!validStartResult || observation === undefined)
    throw new ForwardedResultError("Broker did not return a valid startup result", {
      ...(owned ? { session_id: raw.sessionId } : {}),
      cleanup: owned ? "open" : "unknown",
      closed: false,
    });
  return {
    observation,
    owned,
    ...(owned ? { sessionId: raw.sessionId as string } : {}),
  };
}

/** The MCP process holds only plain session ids. Never reconnect/replay a
 * dispatched request after transport loss: its side effect may have happened.
 * The wire is Contract B: connect / open / command / close. */
export class OperatorForwarder {
  private connection: Promise<BrokerClient> | undefined;
  private client: BrokerClient | undefined;
  private connecting = false;
  private readonly sessions = new Set<string>();
  private readonly refusedStarts = new Map<string, Record<string, unknown>>();
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
        const client = await connectOrLaunchBroker(
          this.path,
          session.agent_session_token,
          session.account_id,
        );
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = false;
      });
    }
    return this.connection;
  }
  async invoke(
    name: string,
    originalArgs: Record<string, unknown>,
    requestId: string = randomUUID(),
    signal?: AbortSignal,
    notifyUser?: BrokerNotifier,
  ): Promise<unknown> {
    const checkCancelled = (): void => {
      if (signal?.aborted)
        throw signal.reason ?? new BrokerRefusal("cancelled", "Request cancelled before dispatch");
    };
    checkCancelled();
    const requestedEarly =
      typeof originalArgs.session_id === "string" ? originalArgs.session_id : undefined;
    if (name !== "operate_start" && requestedEarly !== undefined) {
      const refused = this.refusedStarts.get(requestedEarly);
      if (refused !== undefined) {
        if (name === "operate_finish") {
          this.refusedStarts.delete(requestedEarly);
          return refusedStartFinishReceipt(requestedEarly);
        }
        return refused;
      }
    }
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
    let args = originalArgs;
    if (
      name !== "operate_start" &&
      args.session_id === undefined &&
      typeof args.url !== "string" &&
      this.sessions.size === 1
    )
      args = { ...args, session_id: this.sessions.values().next().value };
    const requested = typeof args.session_id === "string" ? args.session_id : undefined;
    let sessionId =
      requested !== undefined && this.sessions.has(requested) ? requested : undefined;
    checkCancelled();

    // Cancellation is per request, keyed on the dispatched frame id: the broker
    // aborts exactly that command. The socket stays up, so this connection keeps
    // its other sessions and every other agent sharing the browser is untouched.
    let dispatchedRequestId: string | undefined;
    const abortDispatched = (): void => {
      if (dispatchedRequestId !== undefined) void client.abort(dispatchedRequestId);
    };
    signal?.addEventListener("abort", abortDispatched, { once: true });
    const dispatch = async (
      method: BrokerWireMethod,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      const id =
        method === "open" && name === "operate_drive" ? `${requestId}:open` : requestId;
      dispatchedRequestId = id;
      return await client.call(method, params, id, notifyUser);
    };
    try {
      if (name === "operate_start") {
        if (typeof args.service_url !== "string")
          throw new BrokerRefusal("invalid_arguments", "operate_start requires a service_url");
        const openRequest: OpenRequest = {
          serviceUrl: args.service_url,
          ...(args.format === "compact" || args.format === "full" ? { format: args.format } : {}),
          ...(typeof args.proxy === "string" ? { proxy: args.proxy } : {}),
        };
        const raw = await dispatch("open", { ...openRequest });
        if (!isRecord(raw))
          throw new ForwardedResultError("Broker returned a non-object open reply", {
            cleanup: "unknown",
            closed: false,
          });
        const observation = isRecord(raw.observation) ? raw.observation : undefined;
        const returnedSessionId = observation?.session_id;
        const owned = typeof raw.sessionId === "string" && raw.sessionId.length > 0;
        const refusedStart = isRecord(observation?.needs_user);
        const validStartResult =
          typeof returnedSessionId === "string" &&
          returnedSessionId.length > 0 &&
          (owned ? returnedSessionId === raw.sessionId : refusedStart);
        if (!validStartResult || observation === undefined)
          throw new ForwardedResultError("Broker did not return a valid startup result", {
            ...(owned ? { session_id: raw.sessionId } : {}),
            cleanup: owned ? "open" : "unknown",
            closed: false,
          });
        if (owned && typeof raw.sessionId === "string") this.sessions.add(raw.sessionId);
        else if (refusedStart && typeof returnedSessionId === "string")
          this.refusedStarts.set(returnedSessionId, observation);
        return observation;
      }

      if (
        name === "operate_drive" &&
        typeof args.url === "string" &&
        typeof args.session_id !== "string"
      ) {
        const opened = parseOpenReply(await dispatch("open", { serviceUrl: args.url }));
        if (opened.owned && opened.sessionId !== undefined) this.sessions.add(opened.sessionId);
        if (!opened.owned || opened.sessionId === undefined) {
          const refusedStartId = opened.observation.session_id;
          if (typeof refusedStartId === "string")
            this.refusedStarts.set(refusedStartId, opened.observation);
          const wall =
            isRecord(opened.observation.needs_user) &&
            typeof opened.observation.needs_user.wall === "string"
              ? opened.observation.needs_user.wall
              : "google_session";
          return {
            status: "needs_value",
            field: wall,
            observation: opened.observation,
            trajectory: [],
            done: "nothing yet",
            remaining: typeof args.goal === "string" ? args.goal : "",
            steps: 0,
            seconds: 0,
            jev_calls: 0,
            ...(isRecord(opened.observation.needs_user) &&
            typeof opened.observation.needs_user.message === "string"
              ? { question: opened.observation.needs_user.message, options: {} }
              : {}),
          };
        }
        args = { ...args, session_id: opened.sessionId };
        delete args.url;
        sessionId = opened.sessionId;
      }

      if (name === "operate_finish") {
        if (sessionId === undefined)
          throw new BrokerRefusal("stale_lease", "Session is not owned by this MCP connection");
        const closeRequest: CloseRequest = { sessionId, args };
        const raw = await dispatch("close", { ...closeRequest });
        if (!isRecord(raw))
          throw new ForwardedResultError("Broker returned a non-object close reply", {
            cleanup: "unknown",
            closed: false,
          });
        const preDispatchFailure = isRecord(raw.preDispatchFailure)
          ? raw.preDispatchFailure
          : undefined;
        if (
          preDispatchFailure?.error === "stale_ref" &&
          preDispatchFailure.dispatch === "not_dispatched"
        )
          throw new ProvenPreDispatchMutationError("stale_ref");
        if (raw.closed === true) this.sessions.delete(sessionId);
        return raw.result;
      }

      if (sessionId === undefined)
        throw new BrokerRefusal("stale_lease", "Session is not owned by this MCP connection");
      const commandRequest: CommandRequest = { sessionId, name, args };
      const rawReply = await dispatch("command", { ...commandRequest });
      if (!isRecord(rawReply))
        throw new ForwardedResultError("Broker returned a non-object command reply", {
          cleanup: "unknown",
          closed: false,
        });
      const preDispatchFailure = isRecord(rawReply.preDispatchFailure)
        ? rawReply.preDispatchFailure
        : undefined;
      if (
        preDispatchFailure?.error === "stale_ref" &&
        preDispatchFailure.dispatch === "not_dispatched"
      )
        throw new ProvenPreDispatchMutationError("stale_ref");
      return rawReply.result;
    } finally {
      signal?.removeEventListener("abort", abortDispatched);
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
    this.refusedStarts.clear();
  }
}
