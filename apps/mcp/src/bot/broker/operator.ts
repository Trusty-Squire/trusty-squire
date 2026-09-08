import { withBrokerAdmission } from "./admission-context.js";
import { brokerBrowserCustody } from "./custody.js";
import type { DispatchJournal } from "./dispatch-journal.js";
import { timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import { ApiClient, type ApiClientConfig } from "../../api-client.js";
import { buildToolRegistry, findTool } from "../../tools/index.js";
import {
  finishProvisionSession,
  sessionForCall,
  withProvisionSessionCall,
} from "../session/lifecycle.js";
import { BrokerAuthority, type BrokerPrincipal } from "./authority.js";
import { BrokerRefusal, siteResources } from "./scheduler.js";
import type { BrokerTransportPort } from "./transport.js";

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

/** Existing handlers and per-session payment state run unchanged INSIDE the
 * broker. Every MCP connection gets its own pinned API client and capability. */
export class OperatorBroker implements BrokerTransportPort {
  readonly authority: BrokerAuthority;
  private readonly apis = new Map<string, ApiClient>();
  private readonly tools = buildToolRegistry();
  private token: Buffer;
  constructor(
    private readonly config: ApiClientConfig & { accountId: string },
    cellId: string,
    private readonly journal?: DispatchJournal,
  ) {
    this.authority = new BrokerAuthority(config.accountId, cellId);
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
    if (method !== "tool") throw new BrokerRefusal("unknown_method", "Unknown broker method");
    const input = callSchema.parse(params);
    const tool = findTool(input.name, this.tools);
    if (tool === null || !tool.name.startsWith("operate_"))
      throw new BrokerRefusal("unknown_tool", "Tool is not an operator command");
    const args = tool.inputSchema.parse(input.args) as Record<string, unknown>;
    let api = this.apis.get(principal.clientId);
    if (api === undefined) {
      api = new ApiClient({ ...this.config, agentIdentity: principal.agentId });
      this.apis.set(principal.clientId, api);
    }
    const pinnedApi = api;
    if (
      tool.name === "operate_start" ||
      (tool.name === "operate_recipe_run" && args.session_id === undefined)
    ) {
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
          if (mutationCapableStart) await this.journal?.record(id, requestId, "entered");
          observation = await withBrokerAdmission(
            { sessionId: id, reserve },
            async () => await tool.handler(args, pinnedApi),
          );
          if (mutationCapableStart) await this.journal?.record(id, requestId, "settled");
          internalId = String((observation as { session_id: string }).session_id);
          const session = sessionForCall(internalId);
          if (session === undefined) {
            return {
              targetId: "no-page",
              invoke: async () => {
                throw new BrokerRefusal("auth_required", "Connect before starting");
              },
              close: async () => true,
            };
          }
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
              const execute = async () => await command.handler(translated, pinnedApi);
              const mutating = ![
                "operate_observe",
                "operate_screenshot",
                "operate_payment_status",
              ].includes(name);
              if (mutating) await this.journal?.record(id, commandId, "entered");
              const result =
                name === "operate_finish"
                  ? await execute()
                  : await withProvisionSessionCall(internalId, execute);
              await this.journal?.record(
                id,
                "payment-custody",
                session.pendingThreeDs === null ? "settled" : "entered",
              );
              if (mutating) await this.journal?.record(id, commandId, "settled");
              return remapSession(result, internalId, id);
            },
            close: async (reason) => {
              const pending = session.pendingThreeDs;
              if (reason === "disconnect" && pending !== null && Date.now() < pending.deadline) {
                const resolution = await session.browser.waitForThreeDsResolution(0);
                if (resolution !== "succeeded" && resolution !== "failed") return false;
              }
              if (sessionForCall(internalId) === undefined) {
                await brokerBrowserCustody()?.release(session.browser);
                return true;
              }
              const result = await finishProvisionSession(internalId);
              if (result.closed) await this.journal?.record(id, "payment-custody", "settled");
              return result.closed;
            },
          };
        },
        async (id) => {
          const session = sessionForCall(id);
          if (session !== undefined && !(await finishProvisionSession(id)).closed) return false;
          return (await brokerBrowserCustody()?.cleanupAdmission(id)) ?? false;
        },
      );
      if (capability.targetId === "no-page") {
        await this.authority.close(principal, capability);
        return { result: observation };
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
  async disconnect(principal: BrokerPrincipal): Promise<void> {
    await this.authority.disconnect(principal);
    this.apis.delete(principal.clientId);
  }
}
