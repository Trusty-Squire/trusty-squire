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
import type { CloseResult, CommandResult, OpenResult } from "./protocol.js";

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

const commandSchema = z
  .object({
    sessionId: z.string().min(1),
    name: z.string(),
    args: z.record(z.unknown()),
  })
  .strict();
// The tool's own input schema stays the single validator (exactly as before
// the collapse); the open request only names the three launch fields.
const openSchema = z
  .object({
    serviceUrl: z.string().min(1),
    format: z.enum(["compact", "full"]).optional(),
    proxy: z.string().optional(),
  })
  .strict();
const closeSchema = z
  .object({
    sessionId: z.string().min(1),
    args: z.record(z.unknown()).optional(),
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

function closedResult(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "closed" in value &&
    (value as { closed?: unknown }).closed === true
  );
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
  /** Transport dispatch for the four Contract B operations. Connection-close
   * (a session-less `close`) is the daemon's connect-scoped concern and never
   * reaches here. */
  async call(
    principal: BrokerPrincipal,
    method: string,
    params: Record<string, unknown>,
    requestId: string,
    requestSignal?: AbortSignal,
  ): Promise<unknown> {
    if (method === "open") return await this.open(principal, params, requestId, requestSignal);
    if (method === "command")
      return await this.command(principal, params, requestId, requestSignal);
    if (method === "close") return await this.closeSession(principal, params, requestId);
    throw new BrokerRefusal("unknown_method", "Unknown broker method");
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
    this.requestControllers.set(key, { principalId: principal.clientId, controller });
    try {
      return await operation(controller.signal);
    } finally {
      this.requestControllers.delete(key);
    }
  }

  /** Abort exactly one registered request. The connection, its lease and its
   * other sessions are untouched. */
  cancel(principal: BrokerPrincipal, requestId: string): boolean {
    const active = this.requestControllers.get(JSON.stringify([principal.clientId, requestId]));
    if (active === undefined) return false;
    active.controller.abort(new BrokerRefusal("cancelled", "Caller cancelled the request"));
    return true;
  }

  /** open: start one operator session on the shared browser. */
  async open(
    principal: BrokerPrincipal,
    params: Record<string, unknown>,
    requestId: string,
    requestSignal?: AbortSignal,
  ): Promise<OpenResult> {
    const input = openSchema.parse(params);
    const tool = findTool("operate_start", this.tools);
    if (tool === null || !isOperatorCommand(tool.name))
      throw new BrokerRefusal("unknown_tool", "Tool is not an operator command");
    const args = tool.inputSchema.parse({
      service_url: input.serviceUrl,
      ...(input.format !== undefined ? { format: input.format } : {}),
      ...(input.proxy !== undefined ? { proxy: input.proxy } : {}),
    }) as Record<string, unknown>;
    if (requestSignal?.aborted) throw requestSignal.reason;
    const pinnedApi = this.apiFor(principal);
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
      return {
        observation: remapSession(observation, internalId, sessionId) as OpenResult["observation"],
      };
    }
    const result = remapSession(observation, internalId, sessionId) as Record<string, unknown>;
    return {
      sessionId,
      observation: {
        ...result,
        broker: { targetId, pid: process.pid },
      } as unknown as OpenResult["observation"],
    };
  }

  /** command: one operator verb against an owned session. */
  async command(
    principal: BrokerPrincipal,
    params: Record<string, unknown>,
    requestId: string,
    requestSignal?: AbortSignal,
  ): Promise<CommandResult> {
    const input = commandSchema.parse(params);
    const tool = findTool(input.name, this.tools);
    if (tool === null || !isOperatorCommand(tool.name))
      throw new BrokerRefusal("unknown_tool", "Tool is not an operator command");
    if (tool.name === "operate_start")
      throw new BrokerRefusal("unknown_tool", "Start is the open operation");
    if (tool.name === "operate_finish")
      throw new BrokerRefusal("unknown_tool", "Finish is the close operation");
    const args = tool.inputSchema.parse(input.args) as Record<string, unknown>;
    if (args.session_id !== input.sessionId)
      throw new BrokerRefusal("stale_lease", "An owned session is required");
    const result = await this.authority.invoke(
      principal,
      input.sessionId,
      requestId,
      tool.name,
      args,
      requestSignal,
    );
    if (result instanceof DeliveredPreDispatchFailure)
      return { preDispatchFailure: { error: result.error, dispatch: "not_dispatched" } };
    return { result };
  }

  /** close: finish an owned session (the `operate_finish` operation). */
  async closeSession(
    principal: BrokerPrincipal,
    params: Record<string, unknown>,
    requestId: string,
  ): Promise<CloseResult> {
    const input = closeSchema.parse(params);
    const tool = findTool("operate_finish", this.tools);
    if (tool === null || !isOperatorCommand(tool.name))
      throw new BrokerRefusal("unknown_tool", "Tool is not an operator command");
    const args = tool.inputSchema.parse(input.args ?? {}) as Record<string, unknown>;
    const result = await this.authority.finish(principal, input.sessionId, requestId, args);
    if (result instanceof DeliveredPreDispatchFailure)
      return {
        closed: false,
        preDispatchFailure: { error: result.error, dispatch: "not_dispatched" },
      };
    const closed = closedResult(result);
    if (closed) await this.authority.close(principal, input.sessionId, true);
    return { closed, result };
  }

  busyReadResult(principal: BrokerPrincipal, params: Record<string, unknown>): unknown | undefined {
    const parsed = commandSchema.safeParse(params);
    if (!parsed.success || !["operate_observe", "operate_screenshot"].includes(parsed.data.name))
      return undefined;
    if (parsed.data.args.session_id !== parsed.data.sessionId) return undefined;
    const receipt = this.authority.busyReadReceipt(principal, parsed.data.sessionId);
    return receipt === undefined ? undefined : { result: receipt };
  }

  private apiFor(principal: BrokerPrincipal): ApiClient {
    let api = this.apis.get(principal.clientId);
    if (api === undefined) {
      api = new ApiClient({ ...this.config, agentIdentity: principal.agentId });
      this.apis.set(principal.clientId, api);
    }
    return api;
  }

  async disconnect(principal: BrokerPrincipal, explicit = false): Promise<void> {
    for (const [key, request] of this.requestControllers) {
      if (request.principalId !== principal.clientId) continue;
      request.controller.abort(new BrokerRefusal("cancelled", "Connection retired"));
      this.requestControllers.delete(key);
    }
    await this.authority.disconnect(principal, explicit);
    this.apis.delete(principal.clientId);
  }
}
