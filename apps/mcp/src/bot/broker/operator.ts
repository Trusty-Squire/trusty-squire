import { captureEvidenceSchema, type CaptureEvidence } from "../credential-capture.js";
import { withBrokerAdmission } from "./admission-context.js";
import { brokerBrowserCustody } from "./custody.js";
import type {
  AuthorizedPreDispatchFailure,
  DispatchJournal,
  ReconciledDispatchOutcome,
} from "./dispatch-journal.js";
import { timingSafeEqual, createHash, createHmac } from "node:crypto";
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
import { BrokerAuthority, type BrokerPrincipal, type TabCapability } from "./authority.js";
import { BrokerRefusal, siteResources } from "./scheduler.js";
import type { BrokerTransportPort } from "./transport.js";
import { forwarderId } from "./lineage.js";
import { provenPreDispatchMutationFailure } from "../mutation-dispatch-evidence.js";
import { withOperatorRequestContext } from "../request-cancellation.js";

class DeliveredPreDispatchFailure {
  constructor(readonly error: "stale_ref") {}
}

const capabilitySchema = z
  .object({
    cellId: z.string(),
    browserEpoch: z.string(),
    sessionId: z.string(),
    targetId: z.string(),
    leaseGeneration: z.string(),
  })
  .strict();
const callSchema = z
  .object({
    name: z.string(),
    args: z.record(z.unknown()),
    capability: capabilitySchema.optional(),
  })
  .strict();
const recoverySchema = callSchema.extend({
  requestId: z.string().min(1).optional(),
  preDispatchFailure: z
    .object({
      requestId: z.string().min(1),
      error: z.literal("stale_ref"),
      dispatch: z.literal("not_dispatched"),
    })
    .strict()
    .optional(),
});
const startConfirmationSchema = z.object({ capability: capabilitySchema }).strict();
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function journalForwarderId(principal: BrokerPrincipal): string {
  if (principal.forwarderId === undefined)
    throw new BrokerRefusal("unauthorized", "Forwarder lineage is required for journal custody");
  return principal.forwarderId;
}

function dispatchDetail(
  principal: BrokerPrincipal,
  operation: string,
  inputHashValue: string,
  start = false,
  dispatchTracked = false,
) {
  return {
    forwarderId: journalForwarderId(principal),
    ...(start ? { start: true as const } : {}),
    operation,
    inputHash: inputHashValue,
    ...(dispatchTracked ? { dispatchTracked: true as const } : {}),
  };
}

function brokerCommandDispatchTracked(name: string): boolean {
  return /^(?:operate_(?:login|click|type|select|press|navigate|fill_credential|recipe_run))$/.test(
    name,
  );
}

async function withBrokerAuditContext<T>(
  api: ApiClient,
  taskId: string,
  invocationId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return await api.withAuditContext({ taskId, invocationId, purpose: taskId }, operation);
}

export function reconciliationOutcome(
  operation: string,
  result: unknown,
): ReconciledDispatchOutcome {
  if (operation !== "operate_pay" || result === null || typeof result !== "object") {
    if (
      result !== null &&
      typeof result === "object" &&
      "write_id" in result &&
      "stored" in result
    ) {
      const stored = "stored_credential" in result ? result.stored_credential : undefined;
      const capture = captureEvidenceSchema.safeParse({
        write_id: result.write_id,
        stored: result.stored,
        storage:
          result.stored === true ? "stored" : "storage" in result ? result.storage : "unknown",
        ...(stored !== null && typeof stored === "object" && "reference" in stored
          ? { reference: stored.reference }
          : {}),
      });
      if (capture.success && capture.data.storage === "not_attempted")
        return { status: "not_dispatched", error: "pre_dispatch_failure", capture: capture.data };
      if (capture.success)
        return result.stored === true
          ? { status: "completed", capture: capture.data }
          : { status: "unknown", reason: "execution_error", capture: capture.data };
    }
    return { status: "completed" };
  }
  const payment = result as Record<string, unknown>;
  if (payment.status === "payment_submitted") return { status: "done" };
  if (payment.status !== "payment_3ds_required" && payment.status !== "payment_outcome_unknown")
    return { status: "completed" };
  const outcome: ReconciledDispatchOutcome = { status: payment.status };
  if (payment.next !== null && typeof payment.next === "object") {
    const next = payment.next as Record<string, unknown>;
    if (
      next.tool === "operate_payment_status" &&
      typeof next.wait_seconds === "number" &&
      Number.isSafeInteger(next.wait_seconds) &&
      next.wait_seconds >= 0
    )
      outcome.next = { tool: "operate_payment_status", wait_seconds: next.wait_seconds };
  }
  return outcome;
}

export function brokerCommandMutates(name: string, args: Record<string, unknown>): boolean {
  return (
    !["operate_observe", "operate_screenshot", "operate_payment_status"].includes(name) &&
    !(name === "operate_extract" && args.store === undefined && args.capture === undefined)
  );
}

/** Existing handlers and per-session payment state run unchanged INSIDE the
 * broker. Every MCP connection gets its own pinned API client and capability. */
export class OperatorBroker implements BrokerTransportPort {
  readonly authority: BrokerAuthority;
  private readonly apis = new Map<string, ApiClient>();
  private readonly inputBindingKeys = new Map<string, Buffer>();
  private readonly tools = buildToolRegistry();
  private readonly requestControllers = new Map<
    string,
    { principalId: string; controller: AbortController }
  >();
  // Missing registrations are retained per authenticated connection. Never
  // evict them for capacity: that could resurrect a cancelled queued mutation.
  private readonly pendingCancellations = new Map<string, Set<string>>();
  private token: Buffer;
  constructor(
    private readonly config: ApiClientConfig & { accountId: string },
    cellId: string,
    private readonly journal?: DispatchJournal,
    private readonly legacyPreDispatchAuthorization?: AuthorizedPreDispatchFailure,
  ) {
    this.authority = new BrokerAuthority(config.accountId, cellId);
    this.authority.setDetachedExpiryHandler(async (capability, principal) => {
      if (principal.forwarderId !== undefined)
        await this.journal?.recordDetachedPaymentUncertainty(
          capability.sessionId,
          principal.forwarderId,
        );
    });
    this.token = createHash("sha256").update(config.agentSessionToken).digest();
  }
  refreshCredentials(session: { account_id?: string; agent_session_token?: string }): void {
    if (session.account_id !== this.config.accountId || !session.agent_session_token)
      throw new BrokerRefusal("account_mismatch", "Reconnect must preserve the enrolled account");
    const inventory = this.authority.inventory();
    if (inventory.active || inventory.quarantined || inventory.admitting)
      throw new BrokerRefusal("maintenance", "Credential refresh requires drained sessions");
    this.config.agentSessionToken = session.agent_session_token;
    this.token = createHash("sha256").update(session.agent_session_token).digest();
    this.apis.clear();
  }
  async authenticate(
    token: string,
    agentId?: string,
    lineageCredential?: string,
    supervisor = false,
  ): Promise<Omit<BrokerPrincipal, "clientId"> | null> {
    if (!timingSafeEqual(createHash("sha256").update(token).digest(), this.token)) return null;
    if (supervisor)
      return {
        accountId: this.config.accountId,
        agentId: "broker-supervisor",
        supervisor: true,
      };
    if (lineageCredential === undefined) return null;
    const id = forwarderId(lineageCredential);
    this.inputBindingKeys.set(id, createHash("sha256").update(lineageCredential).digest());
    return {
      accountId: this.config.accountId,
      agentId: agentId ?? this.config.agentIdentity ?? "local-agent",
      forwarderId: id,
    };
  }
  private inputHash(principal: BrokerPrincipal, input: unknown): string {
    const forwarder = principal.forwarderId;
    const key = forwarder === undefined ? undefined : this.inputBindingKeys.get(forwarder);
    if (key === undefined)
      throw new BrokerRefusal("unauthorized", "Forwarder input binding is not authenticated");
    return createHmac("sha256", key).update(canonicalJson(input)).digest("hex");
  }
  connected(principal: BrokerPrincipal): Promise<void> | void {
    if (principal.supervisor) return;
    return this.authority.claimForwarder(principal);
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
    if (requestId.length === 0 || requestId.length > 128 || principal.supervisor) return false;
    const active = this.requestControllers.get(JSON.stringify([principal.clientId, requestId]));
    if (active !== undefined) {
      active.controller.abort(new BrokerRefusal("cancelled", "Caller cancelled the request"));
      return true;
    }
    let pending = this.pendingCancellations.get(principal.clientId);
    if (pending === undefined) {
      if (this.pendingCancellations.size >= 128)
        throw new BrokerRefusal("capacity", "Pending cancellation connection budget exhausted");
      pending = new Set();
      this.pendingCancellations.set(principal.clientId, pending);
    }
    if (!pending.has(requestId) && pending.size >= 8192)
      throw new BrokerRefusal("capacity", "Pending cancellation budget exhausted");
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
    if (tool === null || !tool.name.startsWith("operate_"))
      throw new BrokerRefusal("unknown_tool", "Tool is not an operator command");
    const args = tool.inputSchema.parse(input.args) as Record<string, unknown>;
    if (tool.name === "operate_finish" && typeof args.session_id === "string") {
      const terminal = await this.journal?.terminalReceipt(
        journalForwarderId(principal),
        args.session_id,
      );
      if (terminal !== undefined)
        return { result: { ...terminal, cleanup: "already_closed", url: "" } };
    }
    const starting =
      tool.name === "operate_start" ||
      (tool.name === "operate_recipe_run" && args.session_id === undefined);
    const dispatch = dispatchDetail(
      principal,
      tool.name,
      this.inputHash(
        principal,
        typeof args.session_id === "string"
          ? { name: tool.name, args }
          : { name: tool.name, args, capability: input.capability },
      ),
      starting,
      tool.name === "operate_recipe_run",
    );
    const completed = await this.journal?.completedOutcome(
      journalForwarderId(principal),
      requestId,
      dispatch,
    );
    if (completed !== undefined)
      return {
        result: {
          reconciliation: {
            request_id: completed.requestId,
            operation: completed.operation,
            ...completed.outcome,
          },
        },
      };
    if (requestSignal.aborted) throw requestSignal.reason;
    let api = this.apis.get(principal.clientId);
    if (api === undefined) {
      api = new ApiClient({ ...this.config, agentIdentity: principal.agentId });
      this.apis.set(principal.clientId, api);
    }
    const pinnedApi = api;
    if (starting) {
      if (await this.journal?.hasPendingStartDelivery(journalForwarderId(principal)))
        throw new BrokerRefusal(
          "outcome_unknown",
          "Prior start result awaits caller delivery; recover it before starting another session",
        );
      if (input.capability !== undefined)
        throw new BrokerRefusal("invalid_arguments", "Start takes no existing capability");
      const hosts = [
        ...(typeof args.service_url === "string" ? [args.service_url] : []),
        ...((args.allowed_hosts ?? []) as string[]),
        ...((args.extra_allowed_hosts ?? []) as string[]),
      ];
      let observation: unknown;
      let internalId = "";
      const capability = await this.authority.open(
        principal,
        siteResources(hosts),
        async (id, signal, reserve) => {
          if (signal.aborted) throw new BrokerRefusal("cancelled", "Start cancelled");
          const mutationCapableStart = tool.name === "operate_recipe_run";
          let startDispatchAttempted = false;
          if (mutationCapableStart) await this.journal?.record(id, requestId, "prepared", dispatch);
          try {
            observation = await withOperatorRequestContext(
              signal,
              async () =>
                await withBrokerAdmission(
                  { sessionId: id, reserve },
                  async () =>
                    await withBrokerAuditContext(
                      pinnedApi,
                      tool.name,
                      requestId,
                      async () => await tool.handler(args, pinnedApi),
                    ),
                ),
              mutationCapableStart
                ? async () => {
                    await this.journal?.record(id, requestId, "dispatch_attempted", dispatch);
                    startDispatchAttempted = true;
                  }
                : undefined,
            );
            if (signal.aborted) throw signal.reason ?? new Error("operator_request_cancelled");
          } catch (error) {
            if (mutationCapableStart) {
              await this.journal?.record(
                id,
                requestId,
                startDispatchAttempted ? "unknown" : "observed_result",
                {
                  ...dispatch,
                  outcome: startDispatchAttempted
                    ? {
                        status: "unknown",
                        reason: signal.aborted ? "cancelled" : "execution_error",
                      }
                    : {
                        status: "not_dispatched",
                        error: signal.aborted ? "cancelled" : "pre_dispatch_failure",
                      },
                },
              );
            }
            throw error;
          }
          internalId = String((observation as { session_id: string }).session_id);
          const session = sessionForCall(internalId);
          if (session === undefined) {
            await finishProvisionSession(internalId);
            if (mutationCapableStart)
              await this.journal?.record(id, requestId, "settled", dispatch);
            return {
              targetId: "no-page",
              invoke: async () => {
                throw new BrokerRefusal("auth_required", "Connect before starting");
              },
              close: async () => true,
              orphan: async () => undefined,
            };
          }
          if (mutationCapableStart)
            await this.journal?.record(id, requestId, "observed_result", {
              ...dispatch,
              outcome: reconciliationOutcome(tool.name, observation),
            });
          const targetId = await session.browser.brokerTargetId();
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
              const executeHandler = async () =>
                await withBrokerAuditContext(pinnedApi, name, commandId, async () =>
                  command.handler(translated, pinnedApi, {
                    signal,
                    notifyUser: async () => undefined,
                  }),
                );
              const execute = async () =>
                prepared === undefined
                  ? await executeHandler()
                  : await withPreparedOAuthLoginTarget(
                      prepared as PreparedOAuthLoginTarget,
                      executeHandler,
                    );
              const mutating = brokerCommandMutates(name, commandArgs);
              const commandDispatch = dispatchDetail(
                principal,
                name,
                this.inputHash(principal, { name, args: commandArgs }),
                false,
                brokerCommandDispatchTracked(name),
              );
              if (mutating) await this.journal?.record(id, commandId, "prepared", commandDispatch);
              let dispatchAttempted = false;
              let captureEvidence: CaptureEvidence | undefined;
              const executeOwned = async () =>
                await withOperatorRequestContext(
                  signal,
                  execute,
                  mutating
                    ? async () => {
                        if (
                          name === "operate_finish" &&
                          (await this.journal?.unresolvedCapture(journalForwarderId(principal), id))
                        )
                          throw new BrokerRefusal(
                            "outcome_unknown",
                            "Recover the original capture write identity before credential finish",
                          );
                        await this.journal?.record(
                          id,
                          commandId,
                          "dispatch_attempted",
                          commandDispatch,
                        );
                        dispatchAttempted = true;
                      }
                    : undefined,
                  {
                    operationId: commandId,
                    onCapture: async (capture, recovery) => {
                      await this.journal?.recordCapture(
                        journalForwarderId(principal),
                        id,
                        commandId,
                        capture,
                        recovery,
                        commandDispatch,
                      );
                      captureEvidence = capture;
                    },
                    onTerminalSettled: () => this.authority.retireFinished(principal, id),
                    onTerminal: async (receipt) => {
                      await this.journal?.recordTerminalReceipt(journalForwarderId(principal), {
                        ...receipt,
                        session_id: id,
                      });
                    },
                  },
                );
              let result: unknown;
              try {
                result =
                  name === "operate_finish"
                    ? await executeOwned()
                    : await withProvisionSessionCall(internalId, executeOwned, signal);
                // The handler returns only after its post-action observation.
                // That observed result is stronger outcome evidence than a
                // cancellation that arrived while the handler was settling.
              } catch (error) {
                const preDispatch = provenPreDispatchMutationFailure(error);
                if (mutating && name === "operate_login" && preDispatch !== null) {
                  await this.journal?.record(id, commandId, "observed_result", {
                    ...commandDispatch,
                    outcome: { status: "not_dispatched", error: preDispatch.code },
                  });
                  return new DeliveredPreDispatchFailure(preDispatch.code);
                }
                const knownNotDispatched =
                  mutating &&
                  commandDispatch.dispatchTracked === true &&
                  !dispatchAttempted &&
                  (signal.aborted || name === "operate_recipe_run");
                if (knownNotDispatched) {
                  await this.journal?.record(id, commandId, "observed_result", {
                    ...commandDispatch,
                    outcome: {
                      status: "not_dispatched",
                      error: signal.aborted ? "cancelled" : "pre_dispatch_failure",
                    },
                  });
                } else if (mutating) {
                  await this.journal?.record(id, commandId, "unknown", {
                    ...commandDispatch,
                    outcome: {
                      status: "unknown",
                      reason: signal.aborted ? "cancelled" : "execution_error",
                      ...(captureEvidence === undefined ? {} : { capture: captureEvidence }),
                    },
                  });
                }
                if (mutating) {
                  const message = error instanceof Error ? error.message : String(error);
                  const code =
                    error instanceof BrokerRefusal ? error.code : "tool_execution_failed";
                  const recovery = knownNotDispatched
                    ? "operate_observe_then_retry"
                    : "repeat_same_arguments_with_trusty-squire/recover=true_do_not_replay";
                  throw new BrokerRefusal(
                    code,
                    `${message}; session_id=${id}; operation=${name}; operation_id=${commandId}; ` +
                      `mutation=${knownNotDispatched ? "not_dispatched" : "unknown"}; recovery=${recovery}`,
                  );
                }
                throw error;
              }
              await this.journal?.record(
                id,
                "payment-custody",
                session.pendingThreeDs === null ? "settled" : "entered",
                {
                  forwarderId: journalForwarderId(principal),
                },
              );
              if (mutating)
                await this.journal?.record(id, commandId, "observed_result", {
                  ...commandDispatch,
                  outcome: {
                    ...reconciliationOutcome(name, result),
                    ...(captureEvidence ? { capture: captureEvidence } : {}),
                  },
                });
              return remapSession(result, internalId, id);
            },
            close: async (reason) => {
              const forwarderId = journalForwarderId(principal);
              const detachedPaymentUncertainty =
                reason === "expiry" &&
                (await this.journal?.hasOnlyDetachedPaymentUncertainty(id, forwarderId));
              if (
                ((await this.journal?.hasOutstanding(id)) && !detachedPaymentUncertainty) ||
                (await this.journal?.hasPendingStartDelivery(forwarderId, id))
              )
                return false;
              const pending = session.pendingThreeDs;
              if (reason === "disconnect" && pending !== null && Date.now() < pending.deadline) {
                const resolution = await session.browser.waitForThreeDsResolution(0);
                if (resolution !== "succeeded" && resolution !== "failed") return false;
              }
              if (sessionForCall(internalId) === undefined) {
                await brokerBrowserCustody()?.release(session.browser);
                return true;
              }
              if (reason === "expiry") return await forceFinishProvisionSession(internalId);
              const result = await finishProvisionSession(internalId);
              if (result.closed)
                await this.journal?.record(id, "payment-custody", "settled", {
                  forwarderId: journalForwarderId(principal),
                });
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
      if (capability.targetId === "no-page") {
        await this.authority.close(principal, capability);
        return { result: observation };
      }
      if (tool.name === "operate_start") {
        try {
          await this.journal?.record(capability.sessionId, requestId, "outcome", {
            ...dispatch,
            outcome: { status: "completed" },
          });
        } catch (error) {
          await this.authority.close(principal, capability);
          throw error;
        }
      }
      const result = remapSession(observation, internalId, capability.sessionId) as Record<
        string,
        unknown
      >;
      return {
        capability,
        result: {
          ...result,
          broker: {
            cellId: capability.cellId,
            browserEpoch: capability.browserEpoch,
            targetId: capability.targetId,
            pid: process.pid,
          },
        },
      };
    }
    const capability = input.capability;
    if (capability === undefined || args.session_id !== capability.sessionId)
      throw new BrokerRefusal("stale_lease", "An owned session capability is required");
    const extra = tool.name === "operate_allow_host" ? siteResources([String(args.host)]) : [];
    const lane =
      tool.name === "operate_login"
        ? "oauth"
        : ["operate_extract", "operate_fill_credential", "operate_pay"].includes(tool.name)
          ? "interactive"
          : undefined;
    const result =
      tool.name === "operate_finish"
        ? await this.authority.finish(principal, capability, requestId, args)
        : await this.authority.invoke(
            principal,
            capability,
            requestId,
            tool.name,
            args,
            extra,
            lane,
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
      await this.authority.close(principal, capability, true);
    return { result };
  }
  async recover(
    principal: BrokerPrincipal,
    params: Record<string, unknown>,
  ): Promise<{
    requestId: string;
    capability?: TabCapability;
    result:
      | {
          reconciliation: ReconciledDispatchOutcome & { request_id: string; operation: string };
        }
      | Record<string, unknown>;
  } | null> {
    const input = recoverySchema.parse(params);
    const tool = findTool(input.name, this.tools);
    if (tool === null || !tool.name.startsWith("operate_"))
      throw new BrokerRefusal("unknown_tool", "Tool is not an operator command");
    const args = tool.inputSchema.parse(input.args) as Record<string, unknown>;
    const explicitFailure = input.preDispatchFailure;
    const sessionId = typeof args.session_id === "string" ? args.session_id : undefined;
    const inputHash = this.inputHash(
      principal,
      sessionId !== undefined
        ? { name: tool.name, args }
        : { name: tool.name, args, capability: input.capability },
    );
    const authorization = this.legacyPreDispatchAuthorization;
    const completed =
      explicitFailure !== undefined &&
      sessionId !== undefined &&
      authorization !== undefined &&
      sessionId === authorization.sessionId &&
      tool.name === authorization.operation &&
      journalForwarderId(principal) === authorization.forwarderId &&
      args.provider === "google" &&
      args.ref === "reconciliation-only:no-dispatch"
        ? await this.journal?.reconcileExplicitPreDispatchFailure(authorization, explicitFailure)
        : input.requestId !== undefined
          ? await this.journal?.completedOutcome(journalForwarderId(principal), input.requestId, {
              operation: tool.name,
              inputHash,
            })
          : await this.journal?.recoveryOutcome(
              journalForwarderId(principal),
              sessionId !== undefined
                ? {
                    operation: tool.name,
                    sessionId,
                    inputHash,
                  }
                : {
                    operation: tool.name,
                    inputHash,
                  },
            );
    if (completed === undefined) return null;
    if (completed.alreadySettled !== true)
      await this.journal?.recordRecovery(journalForwarderId(principal), completed);
    if (completed.start === true) {
      const capability = this.authority.recoverCapability(principal, completed.sessionId);
      if (capability === undefined)
        return {
          requestId: completed.requestId,
          result: {
            reconciliation: {
              request_id: completed.requestId,
              operation: completed.operation,
              ...completed.outcome,
            },
            recovery: {
              status: "session_unavailable",
              next_step:
                "Broker restart ended the session; reconcile this recorded outcome before any new work.",
            },
          },
        };
      return {
        requestId: completed.requestId,
        capability,
        result: {
          session_id: capability.sessionId,
          broker: {
            cellId: capability.cellId,
            browserEpoch: capability.browserEpoch,
            targetId: capability.targetId,
            pid: process.pid,
          },
        },
      };
    }
    return {
      requestId: completed.requestId,
      result: {
        reconciliation: {
          request_id: completed.requestId,
          operation: completed.operation,
          ...completed.outcome,
        },
      },
    };
  }
  async reclaim(principal: BrokerPrincipal): Promise<{ capabilities: TabCapability[] }> {
    return { capabilities: this.authority.reclaim(principal) };
  }
  async confirmStartDelivery(
    principal: BrokerPrincipal,
    params: Record<string, unknown>,
  ): Promise<void> {
    const { capability } = startConfirmationSchema.parse(params);
    if (!this.authority.hasCapability(principal, capability))
      throw new BrokerRefusal("stale_lease", "Capability does not name an owned live session");
    await this.journal?.confirmStartDelivery(capability.sessionId, journalForwarderId(principal));
  }
  async reap(now = Date.now()): Promise<void> {
    await this.journal?.expirePendingStartDeliveries(now);
    await this.authority.expireDetached(now);
    await this.authority.retryQuarantined(
      async (capability, principal) =>
        !(
          principal.forwarderId !== undefined &&
          (await this.journal?.hasPendingStartDelivery(principal.forwarderId, capability.sessionId))
        ),
    );
  }
  async acknowledge(principal: BrokerPrincipal, requestId: string): Promise<void> {
    if (await this.journal?.acknowledge(journalForwarderId(principal), requestId))
      await this.authority.retryQuarantined();
  }
  busyReadResult(
    principal: BrokerPrincipal,
    params: Record<string, unknown>,
    requestId: string,
  ): unknown | undefined {
    const parsed = callSchema.safeParse(params);
    if (!parsed.success || !["operate_observe", "operate_screenshot"].includes(parsed.data.name))
      return undefined;
    const { capability, args } = parsed.data;
    if (capability === undefined || args.session_id !== capability.sessionId) return undefined;
    const receipt = this.authority.busyReadReceipt(principal, capability, requestId);
    return receipt === undefined ? undefined : { result: receipt };
  }

  async canContinueAfterCapture(
    principal: BrokerPrincipal,
    params: Record<string, unknown>,
  ): Promise<boolean> {
    const input = callSchema.safeParse(params);
    if (!input.success) return false;
    const { name, args, capability } = input.data;
    if (
      capability === undefined ||
      args.session_id !== capability.sessionId ||
      name === "operate_start" ||
      name === "operate_finish" ||
      args.capture !== undefined ||
      args.store !== undefined ||
      this.journal === undefined
    )
      return false;
    try {
      if (!this.authority.hasCapability(principal, capability)) return false;
    } catch (error) {
      if (error instanceof BrokerRefusal) return false;
      throw error;
    }
    return await this.journal.hasOnlyCaptureCustody(
      capability.sessionId,
      journalForwarderId(principal),
    );
  }

  async canReconcileCapture(
    principal: BrokerPrincipal,
    params: Record<string, unknown>,
  ): Promise<boolean> {
    const input = callSchema.safeParse(params);
    if (!input.success || input.data.name !== "operate_extract") return false;
    const capability = input.data.capability;
    const capture = input.data.args.capture as Record<string, unknown> | undefined;
    if (
      capability === undefined ||
      input.data.args.session_id !== capability.sessionId ||
      typeof capture?.write_id !== "string" ||
      this.journal === undefined
    )
      return false;
    try {
      if (!this.authority.hasCapability(principal, capability)) return false;
    } catch (error) {
      if (error instanceof BrokerRefusal) return false;
      throw error;
    }
    return await this.journal.hasCaptureWrite(
      journalForwarderId(principal),
      capability.sessionId,
      capture.write_id,
    );
  }

  async canContinuePaymentStatus(
    principal: BrokerPrincipal,
    params: Record<string, unknown>,
  ): Promise<boolean> {
    const input = callSchema.safeParse(params);
    if (!input.success || input.data.name !== "operate_payment_status") return false;
    const capability = input.data.capability;
    if (
      capability === undefined ||
      typeof input.data.args.session_id !== "string" ||
      input.data.args.session_id !== capability.sessionId
    )
      return false;
    try {
      if (!this.authority.hasCapability(principal, capability)) return false;
    } catch (error) {
      if (error instanceof BrokerRefusal) return false;
      throw error;
    }
    if (this.journal === undefined) return false;
    return await this.journal.hasOnlyPaymentCustody(
      capability.sessionId,
      journalForwarderId(principal),
    );
  }
  async disconnect(principal: BrokerPrincipal, explicit = false): Promise<void> {
    this.pendingCancellations.delete(principal.clientId);
    for (const [key, request] of this.requestControllers) {
      if (request.principalId !== principal.clientId) continue;
      request.controller.abort(new BrokerRefusal("cancelled", "Connection retired"));
      this.requestControllers.delete(key);
    }
    this.authority.beginForwarderRelease(principal);
    const forwarder = principal.forwarderId;
    if (!explicit) this.authority.detach(principal);
    else if (forwarder !== undefined && (await this.journal?.hasOutstanding(undefined, forwarder)))
      this.authority.detach(principal, Date.now(), 0);
    else {
      if (forwarder !== undefined) await this.journal?.settleExplicitStartDeliveries(forwarder);
      await this.authority.disconnect(principal);
    }
    this.authority.releaseForwarder(principal);
    this.apis.delete(principal.clientId);
  }
}
