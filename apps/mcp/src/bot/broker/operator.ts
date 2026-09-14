import { brokerNotifier } from "./transport.js";
import { withBrokerAdmission } from "./admission-context.js";
import { brokerBrowserCustody } from "./custody.js";
import { timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import { ApiClient, type ApiClientConfig } from "../../api-client.js";
import { buildToolRegistry, findTool } from "../../tools/index.js";
import {
  finishProvisionSession,
  forceFinishProvisionSession,
  sessionForCall,
  withProvisionSessionCall,
} from "../session/lifecycle.js";
import {
  preparePublicOAuthLoginTarget,
  withPreparedOAuthLoginTarget,
  type PreparedOAuthLoginTarget,
} from "../provision-session.js";
import { BrokerAuthority, type BrokerPrincipal } from "./authority.js";
import { BrokerRefusal } from "./refusal.js";
import type { BrokerTransportPort } from "./transport.js";
import { provenPreDispatchMutationFailure } from "../mutation-dispatch-evidence.js";
import { withOperatorRequestContext } from "../request-cancellation.js";

class DeliveredPreDispatchFailure {
  constructor(readonly error: "stale_ref") {}
}

function maskSessionOutput<T>(
  session: { browser: { maskOperatorOutput?: (value: T) => T } },
  value: T,
): T {
  const mask = session.browser.maskOperatorOutput;
  return typeof mask === "function" ? mask.call(session.browser, value) : value;
}

const callSchema = z
  .object({
    name: z.string(),
    args: z.record(z.unknown()),
    capability: z.string().optional(),
  })
  .strict();
function remapSession(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((item) => remapSession(item, from, to));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "session_id" && item === from ? to : remapSession(item, from, to),
      ]),
    );
  return value;
}

function isOperatorCommand(name: string): boolean {
  return name.startsWith("operate_") || name === "inject_card";
}

/** Existing handlers run inside the broker with a pinned API client and capability. */
export class OperatorBroker implements BrokerTransportPort {
  readonly authority: BrokerAuthority;
  private readonly apis = new Map<string, ApiClient>();
  private readonly tools = buildToolRegistry();
  private readonly requestControllers = new Map<
    string,
    { principalId: string; controller: AbortController }
  >();
  // Missing registrations are retained per authenticated connection. Never
  // evict them for capacity: that could resurrect a cancelled queued mutation.
  private readonly pendingCancellations = new Map<string, Set<string>>();
  private token: Buffer;
  constructor(private readonly config: ApiClientConfig & { accountId: string }) {
    this.authority = new BrokerAuthority(config.accountId);
    this.token = createHash("sha256").update(config.agentSessionToken).digest();
  }
  refreshCredentials(session: { account_id?: string; agent_session_token?: string }): void {
    if (session.account_id !== this.config.accountId || !session.agent_session_token)
      throw new BrokerRefusal("account_mismatch", "Reconnect must preserve the enrolled account");
    const inventory = this.authority.inventory();
    if (inventory.sessions || inventory.closing || inventory.admitting)
      throw new BrokerRefusal("maintenance", "Credential refresh requires drained sessions");
    this.config.agentSessionToken = session.agent_session_token;
    this.token = createHash("sha256").update(session.agent_session_token).digest();
    this.apis.clear();
  }
  async authenticate(
    token: string,
    agentId?: string,
  ): Promise<Omit<BrokerPrincipal, "clientId"> | null> {
    if (!timingSafeEqual(createHash("sha256").update(token).digest(), this.token)) return null;
    return {
      accountId: this.config.accountId,
      agentId: agentId ?? this.config.agentIdentity ?? "local-agent",
    };
  }
  async call(
    principal: BrokerPrincipal,
    method: string,
    params: Record<string, unknown>,
    requestId: string,
  ): Promise<unknown> {
    return await this.withRegisteredRequest(principal, requestId, (signal) =>
      this.callRegistered(principal, method, params, requestId, signal),
    );
  }

  async callRegistered(
    principal: BrokerPrincipal,
    method: string,
    params: Record<string, unknown>,
    requestId: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    return await this.callOwned(principal, method, params, requestId, signal);
  }

  async withRegisteredRequest<T>(
    principal: BrokerPrincipal,
    requestId: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([principal.clientId, requestId]);
    if (this.requestControllers.has(key))
      throw new BrokerRefusal("duplicate_pending", "Request is already registered");
    const controller = new AbortController();
    const pending = this.pendingCancellations.get(principal.clientId);
    if (pending?.delete(requestId))
      controller.abort(new BrokerRefusal("cancelled", "Caller cancelled before registration"));
    if (pending?.size === 0) this.pendingCancellations.delete(principal.clientId);
    this.requestControllers.set(key, { principalId: principal.clientId, controller });
    try {
      return await operation(controller.signal);
    } finally {
      this.requestControllers.delete(key);
    }
  }

  cancel(principal: BrokerPrincipal, requestId: string): boolean {
    if (requestId.length === 0 || requestId.length > 128) return false;
    const active = this.requestControllers.get(JSON.stringify([principal.clientId, requestId]));
    if (active !== undefined) {
      active.controller.abort(new BrokerRefusal("cancelled", "Caller cancelled the request"));
      return true;
    }
    const pending = this.pendingCancellations.get(principal.clientId);
    if (pending === undefined) {
      this.pendingCancellations.set(principal.clientId, new Set([requestId]));
      return true;
    }
    pending.add(requestId);
    return true;
  }

  private async callOwned(
    principal: BrokerPrincipal,
    method: string,
    params: Record<string, unknown>,
    requestId: string,
    requestSignal: AbortSignal,
  ): Promise<unknown> {
    if (requestSignal.aborted) throw requestSignal.reason;
    if (method !== "tool") throw new BrokerRefusal("unknown_method", "Unknown broker method");
    const input = callSchema.parse(params);
    const tool = findTool(input.name, this.tools);
    if (tool === null || !isOperatorCommand(tool.name))
      throw new BrokerRefusal("unknown_tool", "Tool is not an operator command");
    const args = tool.inputSchema.parse(input.args) as Record<string, unknown>;
    const starting = tool.name === "operate_start";
    if (requestSignal.aborted) throw requestSignal.reason;
    let api = this.apis.get(principal.clientId);
    if (api === undefined) {
      api = new ApiClient({ ...this.config, agentIdentity: principal.agentId });
      this.apis.set(principal.clientId, api);
    }
    const pinnedApi = api;
    if (starting) {
      if (input.capability !== undefined)
        throw new BrokerRefusal("invalid_arguments", "Start takes no existing session");
      let observation: unknown;
      let internalId = "";
      let targetId = "no-page";
      const sessionId = await this.authority.open(
        principal,
        async (id, signal) => {
          if (signal.aborted) throw new BrokerRefusal("cancelled", "Start cancelled");
          observation = await withOperatorRequestContext(
            signal,
            async () =>
              await withBrokerAdmission(
                { sessionId: id },
                async () => await tool.handler(args, pinnedApi),
              ),
          );
          if (signal.aborted) throw signal.reason ?? new Error("operator_request_cancelled");
          internalId = String((observation as { session_id: string }).session_id);
          const session = sessionForCall(internalId);
          if (session === undefined) {
            await finishProvisionSession(internalId);
            return {
              targetId: "no-page",
              invoke: async () => {
                throw new BrokerRefusal("auth_required", "Connect before starting");
              },
              close: async () => true,
              orphan: async () => undefined,
            };
          }
          targetId = await session.browser.brokerTargetId();
          return {
            targetId,
            prepare: async (name, commandArgs) => {
              const ref = commandArgs.ref;
              return name === "operate_login" &&
                typeof commandArgs.provider === "string" &&
                typeof ref === "string"
                ? await withProvisionSessionCall(internalId, async () =>
                    preparePublicOAuthLoginTarget(internalId, ref),
                  )
                : undefined;
            },
            invoke: async (name, commandArgs, signal, commandId, prepared) => {
              if (!session.browser.isConnected())
                throw new BrokerRefusal(
                  "browser_lost",
                  "Browser transport lost; do not replay mutations",
                );
              const command = findTool(name, this.tools);
              if (command === null)
                throw new BrokerRefusal("unknown_tool", "Unknown operator command");
              const translated = { ...commandArgs, session_id: internalId };
              const notifyUser = brokerNotifier();
              const executeHandler = async () =>
                await command.handler(translated, pinnedApi, {
                  signal,
                  ...(notifyUser ? { notifyUser } : {}),
                });
              const execute = async () =>
                prepared === undefined
                  ? await executeHandler()
                  : await withPreparedOAuthLoginTarget(
                      prepared as PreparedOAuthLoginTarget,
                      executeHandler,
                    );
              let dispatchAttempted = false;
              const executeOwned = async () =>
                await withOperatorRequestContext(
                  signal,
                  execute,
                  async () => {
                    dispatchAttempted = true;
                  },
                  {
                    operationId: commandId,
                    onTerminalSettled: () => this.authority.retire(principal, id),
                  },
                );
              try {
                const result =
                  name === "operate_finish"
                    ? await executeOwned()
                    : await withProvisionSessionCall(internalId, executeOwned, signal);
                return maskSessionOutput(session, remapSession(result, internalId, id));
              } catch (error) {
                const preDispatch = provenPreDispatchMutationFailure(error);
                if (!dispatchAttempted && preDispatch !== null)
                  return new DeliveredPreDispatchFailure(preDispatch.code);
                throw error;
              }
            },
            close: async (reason) => {
              if (sessionForCall(internalId) === undefined) {
                await brokerBrowserCustody()?.release(session.browser);
                return true;
              }
              if (reason === "expiry") return await forceFinishProvisionSession(internalId);
              const result = await finishProvisionSession(internalId);
              return result.closed;
            },
            orphan: async () => await brokerBrowserCustody()?.orphan(session.browser),
          };
        },
        async (id) => {
          const sessionId = internalId === "" ? id : internalId;
          const session = sessionForCall(sessionId);
          if (session !== undefined && !(await finishProvisionSession(sessionId)).closed)
            return false;
          return (await brokerBrowserCustody()?.cleanupAdmission(id)) ?? false;
        },
        async (id) => {
          const sessionId = internalId === "" ? id : internalId;
          const session = sessionForCall(sessionId);
          if (session !== undefined) {
            await brokerBrowserCustody()?.orphan(session.browser);
            return;
          }
          await brokerBrowserCustody()?.orphanAdmission(id);
        },
        requestSignal,
      );
      if (targetId === "no-page") {
        await this.authority.close(principal, sessionId);
        return { result: remapSession(observation, internalId, sessionId) };
      }
      const result = remapSession(observation, internalId, sessionId) as Record<
        string,
        unknown
      >;
      return {
        capability: sessionId,
        result: {
          ...result,
          broker: { targetId, pid: process.pid },
        },
      };
    }
    const sessionId = input.capability;
    if (sessionId === undefined || args.session_id !== sessionId)
      throw new BrokerRefusal("stale_lease", "An owned session is required");
    const result =
      tool.name === "operate_finish"
        ? await this.authority.finish(principal, sessionId, requestId, args)
        : await this.authority.invoke(
            principal,
            sessionId,
            requestId,
            tool.name,
            args,
            requestSignal,
          );
    if (result instanceof DeliveredPreDispatchFailure)
      return {
        preDispatchFailure: {
          error: result.error,
          dispatch: "not_dispatched" as const,
        },
      };
    if (
      tool.name === "operate_finish" &&
      result !== null &&
      typeof result === "object" &&
      "closed" in result &&
      result.closed === true
    )
      await this.authority.close(principal, sessionId, true);
    return { result };
  }
  busyReadResult(principal: BrokerPrincipal, params: Record<string, unknown>): unknown | undefined {
    const parsed = callSchema.safeParse(params);
    if (!parsed.success || !["operate_observe", "operate_screenshot"].includes(parsed.data.name))
      return undefined;
    const { capability, args } = parsed.data;
    if (capability === undefined || args.session_id !== capability) return undefined;
    const receipt = this.authority.busyReadReceipt(principal, capability);
    return receipt === undefined ? undefined : { result: receipt };
  }

  async disconnect(principal: BrokerPrincipal, explicit = false): Promise<void> {
    this.pendingCancellations.delete(principal.clientId);
    for (const [key, request] of this.requestControllers) {
      if (request.principalId !== principal.clientId) continue;
      request.controller.abort(new BrokerRefusal("cancelled", "Connection retired"));
      this.requestControllers.delete(key);
    }
    await this.authority.disconnect(principal, explicit);
    this.apis.delete(principal.clientId);
  }
}
