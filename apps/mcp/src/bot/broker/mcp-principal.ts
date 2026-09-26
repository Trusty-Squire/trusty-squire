import { randomUUID } from "node:crypto";
import { withServingAccountId, type SessionGuard } from "../../session-guard.js";
import { BrokerRefusal } from "./refusal.js";
import type { OperatorBroker } from "./operator.js";
import { withBrokerNotifier, type BrokerNotifier } from "./transport.js";
import type { BrokerAccount } from "./protocol.js";
import type { BrokerPrincipal } from "./authority.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One MCP socket owns one principal. No broker wire or browser handle crosses it. */
export class InProcessOperatorPrincipal {
  private readonly sessions = new Set<string>();
  private readonly refusedStarts = new Map<string, Record<string, unknown>>();
  private closed = false;

  constructor(
    readonly principal: BrokerPrincipal,
    private readonly operator: OperatorBroker,
    private readonly guard: SessionGuard,
  ) {}

  private async account(): Promise<BrokerAccount | undefined> {
    const session = await this.guard.bind();
    return session?.account_id && session.agent_session_token && session.api_base_url
      ? {
          accountId: session.account_id,
          agentSessionToken: session.agent_session_token,
          apiBaseUrl: session.api_base_url,
        }
      : undefined;
  }

  async invoke(
    name: string,
    originalArgs: Record<string, unknown>,
    requestId = randomUUID(),
    signal?: AbortSignal,
    notifyUser?: BrokerNotifier,
  ): Promise<unknown> {
    if (this.closed) throw new BrokerRefusal("broker_lost", "MCP connection is closed");
    if (signal?.aborted) throw signal.reason;
    const refusedId = originalArgs.session_id;
    if (typeof refusedId === "string" && this.refusedStarts.has(refusedId)) {
      const refusal = this.refusedStarts.get(refusedId)!;
      if (name !== "operate_finish") return refusal;
      this.refusedStarts.delete(refusedId);
      return {
        session_id: refusedId,
        operation_id: randomUUID(),
        execution: "completed",
        mutation: "not_dispatched",
        cleanup: "closed",
        closed: true,
        url: "",
      };
    }
    const account = await this.account();
    let args = originalArgs;
    if (
      name !== "operate_start" &&
      args.session_id === undefined &&
      typeof args.url !== "string" &&
      this.sessions.size === 1
    )
      args = { ...args, session_id: this.sessions.values().next().value };
    const dispatch = async (
      method: "open" | "command" | "close",
      params: Record<string, unknown>,
      id = requestId,
    ) => {
      const onAbort = () => this.operator.cancel(this.principal, id);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (signal?.aborted) throw signal.reason;
        return await withServingAccountId(
          account?.accountId ?? null,
          async () =>
            await withBrokerNotifier(notifyUser, async () =>
              method === "close"
                ? await this.operator.call(this.principal, method, params, id)
                : await this.operator.withRegisteredRequest(
                    this.principal,
                    id,
                    async (registeredSignal) => {
                      if (signal?.aborted) onAbort();
                      return await this.operator.call(
                        this.principal,
                        method,
                        params,
                        id,
                        registeredSignal,
                      );
                    },
                  ),
            ),
        );
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    };
    const open = async (params: Record<string, unknown>, id = requestId) => {
      const reply = await dispatch("open", { ...params, ...(account ? { account } : {}) }, id);
      if (!record(reply) || !record(reply.observation))
        throw new BrokerRefusal("invalid_broker_result", "Broker returned an invalid open reply");
      if (typeof reply.sessionId === "string") this.sessions.add(reply.sessionId);
      else if (
        typeof reply.observation.session_id === "string" &&
        record(reply.observation.needs_user)
      )
        this.refusedStarts.set(reply.observation.session_id, reply.observation);
      return reply;
    };
    if (name === "operate_start") {
      if (typeof args.service_url !== "string")
        throw new BrokerRefusal("invalid_arguments", "operate_start requires service_url");
      const reply = await open({
        serviceUrl: args.service_url,
        ...(args.format === "full" || args.format === "compact" ? { format: args.format } : {}),
        ...(typeof args.proxy === "string" ? { proxy: args.proxy } : {}),
      });
      return reply.observation;
    }
    if (
      name === "operate_drive" &&
      typeof args.url === "string" &&
      typeof args.session_id !== "string"
    ) {
      const reply = await open(
        { serviceUrl: args.url, initialObservation: "drive" },
        `${requestId}:open`,
      );
      if (typeof reply.sessionId !== "string") {
        const observation = reply.observation as Record<string, unknown>;
        const needs = record(observation.needs_user) ? observation.needs_user : {};
        return {
          status: "needs_value",
          field: typeof needs.wall === "string" ? needs.wall : "google_session",
          observation,
          trajectory: [],
          done: "nothing yet",
          remaining: args.goal ?? "",
          steps: 0,
          seconds: 0,
          jev_calls: 0,
          ...(typeof needs.message === "string" ? { question: needs.message, options: {} } : {}),
        };
      }
      args = { ...args, session_id: reply.sessionId };
      delete args.url;
    }
    const sessionId = args.session_id;
    if (typeof sessionId !== "string" || !this.sessions.has(sessionId))
      throw new BrokerRefusal("stale_lease", "Session is not owned by this MCP connection");
    if (name === "operate_finish") {
      const reply = await dispatch("close", { sessionId, args, ...(account ? { account } : {}) });
      if (!record(reply)) throw new BrokerRefusal("invalid_broker_result", "Invalid close reply");
      if (reply.closed === true) this.sessions.delete(sessionId);
      return reply.result;
    }
    const params = { sessionId, name, args, ...(account ? { account } : {}) };
    const busy = this.operator.busyReadResult(this.principal, params);
    const reply = busy ?? (await dispatch("command", params));
    if (!record(reply)) throw new BrokerRefusal("invalid_broker_result", "Invalid command reply");
    if (record(reply.preDispatchFailure) && reply.preDispatchFailure.error === "stale_ref")
      throw new BrokerRefusal("stale_ref", "Mutation was not dispatched");
    return reply.result;
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.operator.disconnect(this.principal, true);
  }
}
