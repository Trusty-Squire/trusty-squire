import { withBrokerAdmission } from "./admission-context.js";
import { brokerBrowserCustody } from "./custody.js";
import type { DispatchJournal, ReconciledDispatchOutcome } from "./dispatch-journal.js";
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
import { BrokerAuthority, type BrokerPrincipal, type TabCapability } from "./authority.js";
import { BrokerRefusal, siteResources } from "./scheduler.js";
import type { BrokerTransportPort } from "./transport.js";
import { forwarderId } from "./lineage.js";

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
) {
  return {
    forwarderId: journalForwarderId(principal),
    ...(start ? { start: true as const } : {}),
    operation,
    inputHash: inputHashValue,
  };
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
  if (operation !== "operate_pay" || result === null || typeof result !== "object")
    return { status: "completed" };
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
    !(name === "operate_extract" && args.store === undefined)
  );
}

/** Existing handlers and per-session payment state run unchanged INSIDE the
 * broker. Every MCP connection gets its own pinned API client and capability. */
export class OperatorBroker implements BrokerTransportPort {
  readonly authority: BrokerAuthority;
  private readonly apis = new Map<string, ApiClient>();
  private readonly inputBindingKeys = new Map<string, Buffer>();
  private readonly tools = buildToolRegistry();
  private token: Buffer;
  constructor(
    private readonly config: ApiClientConfig & { accountId: string },
    cellId: string,
    private readonly journal?: DispatchJournal,
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
    if (method !== "tool") throw new BrokerRefusal("unknown_method", "Unknown broker method");
    const input = callSchema.parse(params);
    const tool = findTool(input.name, this.tools);
    if (tool === null || !tool.name.startsWith("operate_"))
      throw new BrokerRefusal("unknown_tool", "Tool is not an operator command");
    const args = tool.inputSchema.parse(input.args) as Record<string, unknown>;
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
          if (mutationCapableStart) await this.journal?.record(id, requestId, "entered", dispatch);
          observation = await withBrokerAdmission(
            { sessionId: id, reserve },
            async () =>
              await withBrokerAuditContext(
                pinnedApi,
                tool.name,
                requestId,
                async () => await tool.handler(args, pinnedApi),
              ),
          );
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
            await this.journal?.record(id, requestId, "outcome", {
              ...dispatch,
              outcome: reconciliationOutcome(tool.name, observation),
            });
          const targetId = await session.browser.brokerTargetId();
          return {
            targetId,
            invoke: async (name, commandArgs, _signal, commandId) => {
              if (!session.browser.isConnected())
                throw new BrokerRefusal(
                  "browser_lost",
                  "Browser transport lost; do not replay mutations",
                );
              const command = findTool(name, this.tools);
              if (command === null)
                throw new BrokerRefusal("unknown_tool", "Unknown operator command");
              const translated = { ...commandArgs, session_id: internalId };
              const execute = async () =>
                await withBrokerAuditContext(
                  pinnedApi,
                  name,
                  commandId,
                  async () => await command.handler(translated, pinnedApi),
                );
              const mutating = brokerCommandMutates(name, commandArgs);
              const commandDispatch = dispatchDetail(
                principal,
                name,
                this.inputHash(principal, { name, args: commandArgs }),
              );
              if (mutating) await this.journal?.record(id, commandId, "entered", commandDispatch);
              const result =
                name === "operate_finish"
                  ? await execute()
                  : await withProvisionSessionCall(internalId, execute);
              await this.journal?.record(
                id,
                "payment-custody",
                session.pendingThreeDs === null ? "settled" : "entered",
                {
                  forwarderId: journalForwarderId(principal),
                },
              );
              if (mutating)
                await this.journal?.record(id, commandId, "outcome", {
                  ...commandDispatch,
                  outcome: reconciliationOutcome(name, result),
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
    const result = await this.authority.invoke(
      principal,
      capability,
      requestId,
      tool.name,
      args,
      extra,
      lane,
    );
    if (tool.name === "operate_finish") await this.authority.close(principal, capability);
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
    const input = callSchema.parse(params);
    const tool = findTool(input.name, this.tools);
    if (tool === null || !tool.name.startsWith("operate_"))
      throw new BrokerRefusal("unknown_tool", "Tool is not an operator command");
    const args = tool.inputSchema.parse(input.args) as Record<string, unknown>;
    const completed = await this.journal?.recoveryOutcome(
      journalForwarderId(principal),
      typeof args.session_id === "string"
        ? {
            operation: tool.name,
            sessionId: args.session_id,
            inputHash: this.inputHash(principal, { name: tool.name, args }),
          }
        : {
            operation: tool.name,
            inputHash: this.inputHash(principal, {
              name: tool.name,
              args,
              capability: input.capability,
            }),
          },
    );
    if (completed === undefined) return null;
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
