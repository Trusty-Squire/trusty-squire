import { resolveBrokerSocket } from "./bot/broker/discovery.js";
import { randomUUID } from "node:crypto";
import { BrokerRefusal } from "./bot/broker/refusal.js";
import { ForwardedResultError, OperatorForwarder } from "./bot/broker/forwarder.js";
// MCP tool server used by the broker's shared socket. Agent-facing
// `mcp server` is a relay onto that socket (`relay.ts`); this module
// is not a process entrypoint.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ApiClient } from "./api-client.js";
import { ApprovalDecidedNotifier } from "./approval-decided-notifier.js";
import type { ApprovalDecisionClaims } from "./approval-decided-notifier.js";
import {
  awaitOperatorSettlement,
  composeOperatorSignals,
  withOperatorRequestContext,
} from "./bot/request-cancellation.js";
import { buildToolRegistry, findTool } from "./tools/index.js";
import { createSessionGuard, withServingAccountId, type SessionGuard } from "./session-guard.js";
import { VERSION } from "./version.js";

const SERVER_NAME = "trusty-squire";

const DEFAULT_SHUTDOWN_DEADLINE_MS = 30_000;

export function shutdownDeadlineMs(): number {
  const raw = process.env.TRUSTY_SQUIRE_SERVER_SHUTDOWN_DEADLINE_MS;
  if (raw === undefined) return DEFAULT_SHUTDOWN_DEADLINE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SHUTDOWN_DEADLINE_MS;
}

// Injected into the model's system prompt every turn (≤2KB). Teaches
// the routing between store / use / request so the agent reaches for
// the right credential tool without the user spelling it out.
export const SERVER_INSTRUCTIONS = `This is Trusty Squire — it drives a real browser through signup, provisioning,
and checkout flows on the user's behalf (\`operate_start\`/\`operate_observe\`/
\`operate_click\`/\`operate_type\`/\`inject_card\`/\`operate_finish\`, plus recipe replay), and backs it
with a write-only credential vault.
The user's secrets (API keys, tokens, passwords) live in the vault encrypted;
they are NOT in the conversation context. Reading one back is possible but
costly — see fetch_credential below.
Routing rules for THIS server's vault tools:

- User pastes a secret-shaped value (sk-…, ghp_…, AKIA…, eyJ…) into chat
  → call store_credential AUTOMATICALLY; don't ask permission.
- User refers to a saved credential by name or service ('my OpenAI key',
  'the Stripe token') → call list_credentials to resolve the reference.
- User wants an authenticated API call → call use_credential with the
  service/reference + the HTTP request, using \${SECRET} (single-field)
  or \${SECRET.<field>} (multi-field) placeholders. The server injects
  the secret and returns only the upstream response; you never see the
  value. The target host must be on the credential's allowed_hosts.
- User wants to change allowed_hosts/login_hosts/name without changing the
  secret → call edit_credential. User wants a saved credential removed → call
  delete_credential. Both return a Telegram/passkey approval link first; resume
  with the returned approval_id only after the user signs the exact mutation.
- Rotating a secret value = call store_credential again with the new value (it
  overwrites). edit_credential cannot read or change secret fields.
- The raw value reaches you ONLY via fetch_credential, and only after the
  user signs a passkey approval. It then lives in your transcript forever,
  so use it only when the plaintext must land somewhere you control (a
  GitHub Actions secret, a .env, a config file) with no server-side
  injection path. For calling an API, use_credential is always the answer.`;

export interface ServerCallLifecycle {
  started(): boolean;
  finished(): void;
}

export interface ServerCallAdmission extends ServerCallLifecycle {
  closeAndDrain(): Promise<void>;
  inFlightCount(): number;
}

// `connect` may complete while the host's stdio server is already running.
// Keep the post-install read behind an injected loader so the call boundary can
// pick up the account-bound session that Finish just published without making
// an unauthenticated startup snapshot permanent for the server lifetime.
export type AccountSessionLoader = () => Promise<ApiClient | null>;

export function createServerCallAdmission(): ServerCallAdmission {
  let accepting = true;
  let inFlight = 0;
  let drain: Promise<void> | undefined;
  let finishDrain: (() => void) | undefined;
  return {
    started: () => {
      if (!accepting) return false;
      inFlight += 1;
      return true;
    },
    finished: () => {
      inFlight -= 1;
      if (inFlight === 0) {
        finishDrain?.();
        finishDrain = undefined;
      }
    },
    closeAndDrain: () => {
      accepting = false;
      if (inFlight === 0) return Promise.resolve();
      drain ??= new Promise<void>((resolveDrain) => {
        finishDrain = resolveDrain;
      });
      return drain;
    },
    inFlightCount: () => inFlight,
  };
}

export async function runBoundedServerCleanup(
  admittedCallsDrained: Promise<void>,
  cleanup: () => Promise<void>,
  deadlineMs: number,
): Promise<"complete" | "deadline"> {
  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve();
    }, deadlineMs);
  });
  try {
    await Promise.race([admittedCallsDrained.catch(() => undefined), deadline]);
    const terminalCleanup = cleanup();
    await Promise.race([terminalCleanup, deadline]);
    return expired ? "deadline" : "complete";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function buildServer(
  api: ApiClient | null,
  callLifecycle?: ServerCallLifecycle,
  loadPublishedAccountSession?: AccountSessionLoader,
  sessionGuard?: SessionGuard,
  operatorForwarder: Pick<OperatorForwarder, "invoke"> = new OperatorForwarder(
    resolveBrokerSocket(),
    sessionGuard ?? createSessionGuard(),
  ),
  requestingAgent?: string,
  connectionSignal?: AbortSignal,
  approvalClaims?: ApprovalDecisionClaims,
): Promise<Server> {
  let activeApi = api;
  const tools = buildToolRegistry();
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {}, logging: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  const approvalNotifier = new ApprovalDecidedNotifier(server, connectionSignal, approvalClaims);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.jsonInputSchema,
      ...(t.jsonOutputSchema !== undefined ? { outputSchema: t.jsonOutputSchema } : {}),
      ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
      ...(t.meta !== undefined ? { _meta: t.meta } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tool = findTool(req.params.name, tools);
    if (tool === null) {
      return errorContent("unknown_tool", `unknown tool '${req.params.name}'`);
    }
    // Parse before checking account state. A malformed call is always a local,
    // structured repair opportunity; it must not be misreported as an install
    // problem (or allowed to escape the stdio request boundary).
    const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      if (tool.schemaRepair !== undefined) {
        return errorContent("invalid_arguments", "invalid arguments", {
          guidance: tool.schemaRepair(req.params.arguments ?? {}, parsed.error.issues),
        });
      }
      return errorContent(
        "invalid_arguments",
        `invalid arguments: ${parsed.error.issues
          .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
          .join("; ")}`,
      );
    }
    // Which account is this server serving? Sessions are stored per account, so
    // a `connect` under a different account no longer overwrites this one — but
    // this server must still refuse rather than fall back to another account's
    // scope if its own entry is gone.
    if (sessionGuard !== undefined) {
      const report = await sessionGuard.inspect();
      if (report.problem !== null) {
        return errorContent(report.problem.code, report.problem.message);
      }
    }
    // The install ceremony publishes the agent token after the operator may
    // already have launched this stdio server. Retry the canonical session
    // read only while unauthenticated; once bound, keep the in-memory client
    // for the rest of this server lifetime.
    if (activeApi === null && loadPublishedAccountSession !== undefined) {
      activeApi = await loadPublishedAccountSession();
    }
    if (activeApi === null) {
      return errorContent(
        "reconnect_required",
        `This install is from before single-tier auth and isn't bound to an account. ` +
          `Run \`npx @trusty-squire/mcp connect\` to reconnect.`,
      );
    }
    if (callLifecycle !== undefined && !callLifecycle.started()) {
      return errorContent("server_unavailable", "server is shutting down");
    }
    // Only the MCP client's own cancellation may cancel operator work — there
    // is no server-side work budget.
    const composed = composeOperatorSignals([extra.signal]);
    let lifecycleHeldByWork = false;
    try {
      const callApi = activeApi;
      callApi.setRequestingAgent(
        requestingAgent ?? server.getClientVersion()?.name ?? "unknown-agent",
      );
      const operationId = randomUUID();
      const notifyUser = async (message: string, data?: Record<string, unknown>) => {
        await server.sendLoggingMessage({
          level: "notice",
          logger: "trusty-squire",
          data: { message, ...data },
        });
      };
      const invokeHandler = async () =>
        await withOperatorRequestContext(
          composed.signal,
          async () =>
            await withServingAccountId(
              sessionGuard?.boundAccountId() ?? null,
              async () =>
                await tool.handler(parsed.data, callApi, {
                  signal: composed.signal,
                  notifyUser,
                }),
            ),
          undefined,
          { operationId },
        );
      const invoke = invokeHandler;
      // Tool handlers await independently.  A finish must therefore close the
      // admission gate and drain calls that already entered before it snapshots
      // eligible state and closes the browser. `operate_finish*` owns that transition.
      const forwarded = tool.name.startsWith("operate_") || tool.name === "inject_card";
      const work = forwarded
        ? operatorForwarder.invoke(
            tool.name,
            parsed.data,
            String(extra.requestId),
            composed.signal,
            notifyUser,
          )
        : invoke();
      lifecycleHeldByWork = true;
      const trackedWork = work.finally(() => callLifecycle?.finished());
      const result = await awaitOperatorSettlement(
        trackedWork,
        composed.signal,
        tool.name === "operate_finish" ? 500 : 2_000,
      );
      approvalNotifier.watch(tool.name, result, callApi);
      return toolResultContent(result);
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = rawMessage;
      const loginSession =
        tool.name === "operate_login" &&
        "provider" in parsed.data &&
        typeof parsed.data.session_id === "string"
          ? { session_id: parsed.data.session_id }
          : undefined;
      const brokerUnavailable = err instanceof BrokerRefusal && err.code === "broker_unavailable";
      const serverUnavailable =
        brokerUnavailable || (err instanceof Error && err.name === "UnknownProvisionSessionError");
      if (message.startsWith("operator_session_busy:"))
        return errorContent(
          "session_busy",
          "Cancelled work retains this session; wait for settlement or use finish. Do not replay mutations.",
          loginSession,
        );
      if (message === "operator_execution_unsettled")
        return errorContent(
          "outcome_unknown",
          "Cancelled work has not settled; retain the session and use finish. Do not repeat a mutation.",
          loginSession,
        );
      const retryableRead = tool.name === "operate_observe" || tool.name === "operate_screenshot";
      return serverUnavailable
        ? errorContent(
            brokerUnavailable || retryableRead ? "server_unavailable" : "unknown_session",
            `${message}. ${retryableRead ? "Retry once." : "Do not replay mutations."} Never kill or restart the shared operator process; it serves every lane/home. Recover a same-lineage receipt if available; absence of a live session is not closure proof.`,
            {
              ...loginSession,
              retry: { max_attempts: retryableRead ? 1 : 0, mutation: "do_not_replay" },
            },
          )
        : errorContent(
            err instanceof BrokerRefusal ? err.code : "tool_execution_failed",
            message,
            err instanceof ForwardedResultError
              ? err.detail
              : loginSession === undefined
                ? undefined
                : {
                    ...loginSession,
                    next_action: "operate_observe",
                    guidance:
                      "Inspect the retained session before deciding the next action; do not repeat OAuth blindly.",
                  },
          );
    } finally {
      composed.dispose();
      if (!lifecycleHeldByWork) callLifecycle?.finished();
    }
  });

  return server;
}

// A tool result carrying `image: { mime_type, data_base64 }` (operate_screenshot
// today; any future tool could opt in the same way) gets an actual MCP image
// content block alongside its JSON text, so the host agent can SEE it rather
// than just read a base64 blob it has to know to decode. The image field is
// dropped from the text block — it would otherwise duplicate the same base64
// payload twice in the response for no reason.
function hasImagePayload(
  value: unknown,
): value is Record<string, unknown> & { image: { mime_type: string; data_base64: string } } {
  if (typeof value !== "object" || value === null) return false;
  const image = (value as Record<string, unknown>).image;
  if (typeof image !== "object" || image === null) return false;
  const rec = image as Record<string, unknown>;
  return typeof rec.mime_type === "string" && typeof rec.data_base64 === "string";
}

function toolResultContent(result: unknown) {
  if (hasImagePayload(result)) {
    const { image, ...meta } = result;
    return {
      structuredContent: meta,
      content: [
        { type: "text" as const, text: compactToolResultText(meta) },
        { type: "image" as const, data: image.data_base64, mimeType: image.mime_type },
      ],
    };
  }
  return {
    ...(result !== null && typeof result === "object" && !Array.isArray(result)
      ? { structuredContent: result as Record<string, unknown> }
      : {}),
    content: [{ type: "text" as const, text: compactToolResultText(result) }],
  };
}

/** Minify the observation envelope; DOM indentation remains inside its string. */
export function compactToolResultText(result: unknown): string {
  if (
    typeof result === "object" &&
    result !== null &&
    "format" in result &&
    ["browser-use-dom", "browser-use-control-query"].includes(
      (result as { format?: unknown }).format as string,
    )
  ) {
    const encoded = JSON.stringify(result);
    if (encoded === undefined) throw new Error("Tool returned no JSON-serializable result");
    return encoded;
  }
  const encoded = JSON.stringify(result, null, 2);
  if (encoded === undefined) throw new Error("Tool returned no JSON-serializable result");
  return encoded;
}

function errorContent(code: string, message: string, guidance?: Record<string, unknown>) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: { code, message, ...(guidance ?? {}) } }),
      },
    ],
  };
}
