import { brokerNotifier } from "./transport.js";
import { withBrokerAdmission } from "./admission-context.js";
import { brokerBrowserCustody } from "./custody.js";
import { z } from "zod";
import { ApiClient, type ApiClientConfig } from "../../api-client.js";
import { setServingAccountId } from "../../session-guard.js";
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
import { attachOperatorRequestAbort, withOperatorRequestContext } from "../request-cancellation.js";
import type { BrokerAccount, CloseResult, CommandResult, OpenResult } from "./protocol.js";

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
    account: z
      .object({
        accountId: z.string().min(1),
        agentSessionToken: z.string().min(1),
        apiBaseUrl: z.string().min(1),
      })
      .optional(),
  })
  .strict();
// The tool's own input schema stays the single validator (exactly as before
// the collapse); the open request only names the three launch fields plus
// the connect ceremony's own marker. `ceremony` is the ONE new field
// (captain ruling 031): it is set only by the connect ceremony
// (google-login.ts) — the agent-facing `operate_start` schema has no such
// field, and no forwarder path can inject it.
const openSchema = z
  .object({
    serviceUrl: z.string().min(1),
    format: z.enum(["compact", "full"]).optional(),
    proxy: z.string().optional(),
    initialObservation: z.literal("drive").optional(),
    ceremony: z.boolean().optional(),
    account: z
      .object({
        accountId: z.string().min(1),
        agentSessionToken: z.string().min(1),
        apiBaseUrl: z.string().min(1),
      })
      .optional(),
  })
  .strict();
const closeSchema = z
  .object({
    sessionId: z.string().min(1),
    args: z.record(z.unknown()).optional(),
    account: z
      .object({
        accountId: z.string().min(1),
        agentSessionToken: z.string().min(1),
        apiBaseUrl: z.string().min(1),
      })
      .optional(),
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

/** Derive the operate_start arguments an `open` request maps to. Exported for
 * tests: identity adoption is a behavior OF the ceremony open, not a flag of
 * its own — a ceremony open without an explicit proxy reuses `liveProxyUrl`
 * (whatever identity the shared browser is already live under), an explicit
 * proxy always wins, and a plain open stays bare. */
export function deriveOpenToolArgs(
  input: {
    serviceUrl: string;
    format?: "compact" | "full" | undefined;
    proxy?: string | undefined;
    ceremony?: boolean | undefined;
  },
  liveProxyUrl: string | undefined,
): Record<string, unknown> {
  const liveProxy = input.ceremony === true && input.proxy === undefined ? liveProxyUrl : undefined;
  return {
    service_url: input.serviceUrl,
    ...(input.format !== undefined ? { format: input.format } : {}),
    ...(input.proxy !== undefined ? { proxy: input.proxy } : {}),
    ...(input.proxy === undefined && liveProxy !== undefined ? { proxy: liveProxy } : {}),
  };
}

function closedResult(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "closed" in value &&
    (value as { closed?: unknown }).closed === true
  );
}

/** Existing handlers run inside the broker with a per-call API client and
 * capability. The broker itself holds no account: an account is named by the
 * calls that act as one, so a machine that is still being enrolled can reach
 * the shared browser. */
export class OperatorBroker implements BrokerTransportPort {
  readonly authority: BrokerAuthority;
  private readonly apis = new Map<string, Map<string, ApiClient>>();
  private readonly tools = buildToolRegistry();
  private readonly requestControllers = new Map<
    string,
    { principalId: string; controller: AbortController }
  >();
  constructor(
    private readonly config: {
      registryBaseUrl: string;
      /** How the broker builds the API client for an account a call named.
       * The default is a real `ApiClient`; a caller-owned browser/session
       * harness supplies its own. */
      apiFactory?: (config: ApiClientConfig) => ApiClient;
    },
  ) {
    this.authority = new BrokerAuthority();
  }

  /**
   * The API client for one call's named account, cached per connection so a
   * session reuses one client while its account and token are unchanged. A
   * re-enrollment changes the token, which yields a fresh client rather than
   * replaying a revoked one.
   */
  private apiFor(principal: BrokerPrincipal, account: BrokerAccount | undefined): ApiClient | null {
    if (account === undefined) return null;
    const key = JSON.stringify([account.accountId, account.agentSessionToken, account.apiBaseUrl]);
    let owned = this.apis.get(principal.clientId);
    if (owned === undefined) {
      owned = new Map<string, ApiClient>();
      this.apis.set(principal.clientId, owned);
    }
    let api = owned.get(key);
    if (api === undefined) {
      const build = this.config.apiFactory ?? ((config: ApiClientConfig) => new ApiClient(config));
      api = build({
        apiBaseUrl: account.apiBaseUrl,
        registryBaseUrl: this.config.registryBaseUrl,
        agentSessionToken: account.agentSessionToken,
        accountId: account.accountId,
        agentIdentity: principal.agentId,
      });
      owned.set(key, api);
    }
    return api;
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
    attachOperatorRequestAbort(controller.signal, (reason) => {
      if (!controller.signal.aborted) controller.abort(reason);
    });
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
    // A ceremony open is identity-neutral: when the shared browser is
    // already live under some identity, the opener reuses it instead of
    // requesting a bare one — a bare request would be refused
    // incompatible_runtime while other sessions are live, or would recycle
    // the shared Chrome underneath them when none are.
    const args = tool.inputSchema.parse(
      deriveOpenToolArgs(input, brokerBrowserCustody()?.liveProxyUrl?.()),
    ) as Record<string, unknown>;
    if (requestSignal?.aborted) throw requestSignal.reason;
    const account = input.account;
    const pinnedApi = this.apiFor(principal, account);
    // The handler runs tools that resolve the serving account (inbox consent,
    // registry attribution). Publishing the account this call named keeps that
    // resolution at the point of use instead of at daemon startup.
    setServingAccountId(account?.accountId ?? null);
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
            // The connect re-auth ceremony needs no admission carve-out: starts
            // are deliberately not Google-gated at all.
            await withBrokerAdmission(
              { sessionId: id, ...(account === undefined ? {} : { account }) },
              async () =>
                await tool.handler(args, pinnedApi, {
                  ...(input.initialObservation === undefined
                    ? {}
                    : { initialObservation: input.initialObservation }),
                }),
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
          invoke: async (name, commandArgs, signal, commandId, prepared, callAccount) => {
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
            // The account is resolved per command, from the account THIS call
            // named: a session that outlives a re-enrollment acts as the
            // freshly enrolled account on its next call.
            const commandApi = this.apiFor(principal, callAccount);
            const executeHandler = async () =>
              await command.handler(translated, commandApi, {
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
      input.account,
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
    const result = await this.authority.finish(
      principal,
      input.sessionId,
      requestId,
      args,
      input.account,
    );
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
