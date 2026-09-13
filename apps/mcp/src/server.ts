import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CaptureEvidence } from "./bot/credential-capture.js";
import type { OperationReceipt } from "./bot/operation-receipt.js";
import { brokerCommandMutates } from "./bot/broker/operator.js";
import { DispatchJournal } from "./bot/broker/dispatch-journal.js";
import { BrokerRefusal } from "./bot/broker/scheduler.js";
import {
  ForwardedResultError,
  OperatorForwarder,
  type BrokerRecoveryRequest,
} from "./bot/broker/forwarder.js";
// MCP server: reads its account's session from the session file, sets up an ApiClient
// against the configured API base URL, and exposes the registered tools
// over stdio.
//
// `runServer()` is invoked by bin.ts for the `server` subcommand. This
// file is a pure module — no shebang, no entrypoint guard, no top-level
// execution. The host agent launches `mcp server`; bin.ts dispatches.
//
// Single-tier auth (post-Tier-0 collapse): every session is account-
// bound. Sessions that pre-date the single-tier change (only a
// machine_token, no agent_session_token) fail loud at tool-call time
// with a re-install instruction. There is no anonymous mode.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ApiClient } from "./api-client.js";
import { setSelfManagedChromeTerminationSignalExitEnabled } from "./bot/browser.js";
import {
  awaitOperatorSettlement,
  composeOperatorSignals,
  withOperatorRequestContext,
} from "./bot/request-cancellation.js";
import { cancelActiveLoginBrowsers } from "./bot/google-login.js";
import { startOwnerProcessReaper } from "./bot/owner-process-reaper.js";
import {
  activeSessionCount,
  closeAllProvisionSessions,
  maskOperatorSessionOutput,
  withProvisionSessionCall,
} from "./bot/provision-session.js";
import {
  heartbeatIntervalMs,
  idleCheckIntervalMs,
  idleTimeoutMs,
  idleTimeoutWithSessionMs,
  reapStaleServerInstances,
  registerServerInstance,
  serverLauncherLineage,
  shutdownDeadlineMs,
} from "./server-instance-registry.js";
import { buildToolRegistry, findTool } from "./tools/index.js";
import { createSessionGuard, setServingAccountId, type SessionGuard } from "./session-guard.js";
import { VERSION } from "./version.js";

const SERVER_NAME = "trusty-squire";

const DEFAULT_REGISTRY_BASE =
  process.env.ADAPTER_REGISTRY_URL ?? "https://registry.trustysquire.ai";

// Idle self-exit backstop. transport.onclose / stdin EOF / SIGTERM already
// exit the process on a well-behaved disconnect (see requestShutdown below).
// This covers what a live box surfaced instead: a host agent spawns a *new*
// server on reconnect without ever closing the old child's stdio or signaling
// it — the old process just sits sleeping on an open pipe forever. No signal
// from a host like that will ever arrive, so this is a time bound, not an
// event.
//
// It also has to cover a server that still holds an open provision session.
// Its browser is owned by that server, so only the owning server's bounded
// terminal teardown can close Chrome and destroy its private profile. Hence two
// bounds: a short one when idle with no session (routine), and a longer one
// when a session is still open — wide enough that no real in-flight flow
// (operate_pay's approval wait is bounded to one minute; post-submit outcome
// checks are bounded in the minutes) should ever cross it, so crossing it is a reliable
// abandoned-session signal, not a false kill of live work.
//
// The bounds themselves live in server-instance-registry.ts, because the
// startup reaper there applies the same policy from the outside to a prior
// instance that failed to apply it to itself.

// Exported for unit testing; kept pure so the branches (recent activity,
// no-session idle, session-open idle) don't need a live process/interval.
export function shouldIdleExit(
  now: number,
  lastActivityAt: number,
  sessionCount: number,
  timeoutMs: number,
  timeoutWithSessionMs: number,
): boolean {
  const threshold = sessionCount === 0 ? timeoutMs : timeoutWithSessionMs;
  return now - lastActivityAt >= threshold;
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

export function brokerRecoveryRequested(meta: unknown): BrokerRecoveryRequest {
  if (meta === null || typeof meta !== "object") return {};
  const value = (meta as Record<string, unknown>)["trusty-squire/recover"];
  if (value === true) return { recover: true };
  if (value === null || typeof value !== "object") return {};
  const evidence = value as Record<string, unknown>;
  if (
    typeof evidence.request_id !== "string" ||
    evidence.error !== "stale_ref" ||
    evidence.dispatch !== "not_dispatched" ||
    !Object.keys(evidence).every((key) => ["request_id", "error", "dispatch"].includes(key))
  )
    return {};
  return {
    recover: true,
    preDispatchFailure: {
      requestId: evidence.request_id,
      error: "stale_ref",
      dispatch: "not_dispatched",
    },
  };
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
  operatorForwarder?: OperatorForwarder,
  directPersistence?: { journal: DispatchJournal; lineage: () => string },
): Promise<Server> {
  let activeApi = api;
  const tools = buildToolRegistry();
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

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
    const budget = new AbortController();
    const composed = composeOperatorSignals([extra.signal, budget.signal]);
    const workBudgetMs =
      tool.name === "operate_start" ||
      (tool.name === "operate_recipe_run" && parsed.data.session_id === undefined)
        ? 30_000
        : tool.name === "operate_finish"
          ? 4_500
          : 15_000;
    const budgetTimer =
      tool.name.startsWith("operate_") && !["inject_card"].includes(tool.name)
        ? setTimeout(
            () =>
              budget.abort(
                new BrokerRefusal(
                  "request_timeout",
                  "Operator work budget expired; reconcile before repeating mutations",
                ),
              ),
            workBudgetMs,
          )
        : undefined;
    let lifecycleHeldByWork = false;
    try {
      const callApi = activeApi;
      callApi.setRequestingAgent(server.getClientVersion()?.name ?? "unknown-agent");
      const sessionId =
        typeof parsed.data.session_id === "string" ? parsed.data.session_id : undefined;
      const operationId = randomUUID();
      const directLineage = directPersistence?.lineage();
      if (directPersistence && directLineage && tool.name === "operate_finish" && sessionId) {
        const receipt = await directPersistence.journal.terminalReceipt(directLineage, sessionId);
        if (receipt) return toolResultContent({ ...receipt, cleanup: "already_closed" });
      }
      const assertDirectCapture = async (checkpoint = false): Promise<void> => {
        if (
          directPersistence &&
          directLineage &&
          sessionId &&
          (tool.name !== "operate_finish" || parsed.data.outcome === "credentials") &&
          brokerCommandMutates(tool.name, parsed.data)
        ) {
          const pending = await directPersistence.journal.unresolvedCapture(
            directLineage,
            sessionId,
          );
          if (pending === undefined) return;
          const capture = parsed.data.capture as { write_id?: string } | undefined;
          if (checkpoint && pending.write_id === operationId) return;
          if (tool.name === "operate_extract" && capture?.write_id === pending.write_id) return;
          // An unresolved capture must not wedge the session: ordinary
          // click/type/observe actions proceed while the write_id retry stays
          // available. Only a NEW vaulting attempt (a repeated key creation)
          // and a credentials finish stay fenced.
          if (
            capture === undefined &&
            !(tool.name === "operate_extract" && parsed.data.store !== undefined) &&
            tool.name !== "operate_finish"
          )
            return;
          throw new BrokerRefusal(
            "outcome_unknown",
            "Capture storage is unresolved; use operate_extract with the original capture.write_id. Do not repeat creation.",
          );
        }
      };
      const invokeHandler = async () =>
        await withOperatorRequestContext(
          composed.signal,
          async () =>
            await tool.handler(parsed.data, callApi, {
              signal: composed.signal,
              notifyUser: async (message, data) => {
                await server.sendLoggingMessage({
                  level: "notice",
                  logger: "trusty-squire",
                  data: { message, ...data },
                });
              },
            }),
          async () => await assertDirectCapture(true),
          {
            operationId,
            ...(directPersistence && directLineage
              ? {
                  onTerminal: async (receipt: OperationReceipt) =>
                    await directPersistence.journal.recordTerminalReceipt(directLineage, receipt),
                  onCapture: async (capture: CaptureEvidence, recovery: boolean) => {
                    if (!sessionId) throw new Error("capture requires a session");
                    await directPersistence.journal.recordCapture(
                      directLineage,
                      sessionId,
                      operationId,
                      capture,
                      recovery,
                    );
                  },
                }
              : {}),
          },
        );
      const invoke = async () => {
        await assertDirectCapture();
        // Some embedders provide a narrow ApiClient test double. Production
        // clients always install the async-local audit context.
        const withAuditContext = callApi.withAuditContext?.bind(callApi);
        if (withAuditContext === undefined) return await invokeHandler();
        return await withAuditContext(
          {
            taskId: tool.name,
            invocationId: String(extra.requestId),
            purpose: tool.name,
          },
          invokeHandler,
        );
      };
      // Tool handlers await independently.  A finish must therefore close the
      // admission gate and drain calls that already entered before it snapshots
      // eligible state and closes the browser. `operate_finish*` owns that transition.
      const forwarded =
        operatorForwarder !== undefined &&
        (tool.name.startsWith("operate_") || tool.name === "inject_card");
      const work = forwarded
        ? operatorForwarder.invoke(
            tool.name,
            parsed.data,
            String(extra.requestId),
            brokerRecoveryRequested((req.params as { _meta?: unknown })._meta),
            composed.signal,
          )
        : sessionId !== undefined && !/^operate_finish(?:_task)?$/.test(tool.name)
          ? withProvisionSessionCall(sessionId, async () => await invoke(), composed.signal)
          : invoke();
      lifecycleHeldByWork = true;
      const trackedWork = work.finally(() => callLifecycle?.finished());
      const result = await awaitOperatorSettlement(
        trackedWork,
        composed.signal,
        tool.name === "operate_finish" ? 500 : 2_000,
      );
      return toolResultContent(
        sessionId === undefined ? result : maskOperatorSessionOutput(sessionId, result),
      );
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const sessionId =
        typeof parsed.data.session_id === "string" ? parsed.data.session_id : undefined;
      const message =
        sessionId === undefined ? rawMessage : maskOperatorSessionOutput(sessionId, rawMessage);
      const loginSession =
        tool.name === "operate_login" &&
        "provider" in parsed.data &&
        typeof parsed.data.session_id === "string"
          ? { session_id: parsed.data.session_id }
          : undefined;
      const serverUnavailable =
        /unknown provision session|requires one active operate_start browser session/i.test(
          message,
        );
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
      const malformedAction = /^operate_act kind=.* requires /i.test(message);
      const retryableRead = tool.name === "operate_observe" || tool.name === "operate_screenshot";
      return serverUnavailable
        ? errorContent(
            retryableRead ? "server_unavailable" : "unknown_session",
            `${message}. ${retryableRead ? "Retry once." : "Do not replay mutations."} Never kill or restart the shared operator process; it serves every lane/home. Recover a same-lineage receipt if available; absence of a live session is not closure proof.`,
            {
              ...loginSession,
              retry: { max_attempts: retryableRead ? 1 : 0, mutation: "do_not_replay" },
            },
          )
        : errorContent(
            err instanceof BrokerRefusal
              ? err.code
              : malformedAction
                ? "invalid_arguments"
                : "tool_execution_failed",
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
      if (budgetTimer !== undefined) clearTimeout(budgetTimer);
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

// Process-level backstop for the stdio server. Every tool handler is already
// wrapped in try/catch, but an async error can still escape that boundary —
// e.g. a Playwright event waiter whose rejection fires while another await is
// pending (the uploadFile filechooser race that took the server down mid-run).
// Node's default response to an unhandledRejection/uncaughtException is to
// kill the process, which turns one bad operate_* call into "MCP server
// unreachable" for the host agent. Log the escape and keep serving: the
// in-flight call fails on its own (its awaited promise threw or timed out),
// session/browser state is self-contained and bounded by its watchdog and
// terminal teardown, and no security gate depends on process death — a crash
// leaves any half-done page action in exactly the same state, minus the
// transport. Installed only for `mcp server`; the CLI keeps fail-fast.
export function installServerProcessGuards(): void {
  const describe = (reason: unknown): string =>
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(
      `[trusty-squire] unhandled rejection (server kept alive): ${describe(reason)}\n`,
    );
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(
      `[trusty-squire] uncaught exception (server kept alive): ${describe(err)}\n`,
    );
  });
}

// Start the MCP stdio server. Throws on a fatal startup failure; bin.ts
// owns the process-level error handling.
export async function runServer(): Promise<void> {
  installServerProcessGuards();
  setSelfManagedChromeTerminationSignalExitEnabled(false);
  // The detached Linux watchdog survives SIGKILL/parent death. It asynchronously
  // sweeps strict process-only manifests, then tracks exact local browser and
  // session-helper identities for launches owned by this server.
  startOwnerProcessReaper();
  // Startup breadcrumb on stderr (which lands in the host agent's MCP
  // log). A silent no-op was the worst part of the entrypoint-guard
  // bug — this line makes "did the server actually start?" answerable
  // at a glance.
  process.stderr.write(`[trusty-squire] server v${VERSION} starting\n`);

  // Owns this server's answer to "which account am I serving?".
  const sessionGuard = createSessionGuard();
  let directLineage = "";
  const loadPublishedAccountSession = async (): Promise<ApiClient | null> => {
    try {
      const session = await sessionGuard.bind();
      setServingAccountId(sessionGuard.boundAccountId());
      // Single-tier: every session is account-bound. A session with just a
      // machine_token (pre-collapse install) yields api=null, and every
      // tool call returns the re-install instruction.
      if (session === null || session.agent_session_token === undefined) return null;
      directLineage = createHash("sha256")
        .update(
          JSON.stringify([
            session.account_id,
            session.api_base_url,
            session.agent_session_token,
            serverLauncherLineage() || [
              process.cwd(),
              process.env.TRUSTY_SQUIRE_AGENT_IDENTITY ?? "unknown",
            ],
          ]),
        )
        .digest("hex");
      return new ApiClient({
        apiBaseUrl: session.api_base_url,
        registryBaseUrl: DEFAULT_REGISTRY_BASE,
        agentSessionToken: session.agent_session_token,
        agentIdentity: process.env.TRUSTY_SQUIRE_AGENT_IDENTITY ?? "unknown",
        ...(session.account_id !== undefined ? { accountId: session.account_id } : {}),
      });
    } catch {
      // A failed session read must remain fail-closed; the next tool call can
      // retry after a transient session-storage problem clears.
      return null;
    }
  };
  const api = await loadPublishedAccountSession();
  const instanceLineage = serverLauncherLineage();
  try {
    await reapStaleServerInstances({ launcherLineage: instanceLineage });
  } catch (err) {
    process.stderr.write(
      `[trusty-squire] stale server reap failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }

  const callAdmission = createServerCallAdmission();
  const brokerPath = process.env.TRUSTY_SQUIRE_BROKER_SOCKET;
  const forwarder =
    brokerPath === undefined ? undefined : new OperatorForwarder(brokerPath, sessionGuard);
  const server = await buildServer(
    api,
    callAdmission,
    loadPublishedAccountSession,
    sessionGuard,
    forwarder,
    {
      journal: new DispatchJournal(
        join(
          process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
          "trusty-squire",
          "operator-receipts.jsonl",
        ),
      ),
      lineage: () => directLineage,
    },
  );
  const transport = new StdioServerTransport();
  // Publishes what a later launch of this identity needs to tell "still
  // serving a client" from "wedged": last inbound message, open sessions,
  // in-flight calls. Without it every prior instance looks equally idle.
  const instance = registerServerInstance({ launcherLineage: instanceLineage });

  // A stdio client can disappear without sending a signal (for example when
  // its parent agent exits). Chrome keeps Node's event loop alive in that
  // case, so close every active provisioning browser and explicitly exit.
  // Keep the single promise so EOF, transport closure, a signal, and the
  // idle backstop below racing together cannot run teardown twice.
  let shutdown: Promise<void> | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let staleInstanceSweepTimer: NodeJS.Timeout | undefined;
  let staleInstanceSweepRunning = false;
  const sweepStaleInstances = (): void => {
    if (shutdown !== undefined || staleInstanceSweepRunning) return;
    staleInstanceSweepRunning = true;
    void reapStaleServerInstances({ launcherLineage: instanceLineage })
      .catch((err) => {
        process.stderr.write(
          `[trusty-squire] stale server reap failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      })
      .finally(() => {
        staleInstanceSweepRunning = false;
      });
  };
  const requestShutdown = (): void => {
    if (shutdown !== undefined) return;
    const admittedCallsDrained = callAdmission.closeAndDrain();

    const deadlineMs = shutdownDeadlineMs();
    const shutdownDeadlineAt = Date.now() + deadlineMs;
    instance?.markDraining(shutdownDeadlineAt, {
      lastActivityAt,
      activeSessions: forwarder?.sessionCount() ?? activeSessionCount(),
      inFlightCalls: callAdmission.inFlightCount(),
    });

    shutdown = (async () => {
      process.stdin.removeListener("end", requestShutdown);
      process.stdin.removeListener("close", requestShutdown);
      process.removeListener("SIGHUP", requestShutdown);
      process.removeListener("SIGTERM", requestShutdown);
      process.removeListener("SIGINT", requestShutdown);
      if (idleTimer !== undefined) clearInterval(idleTimer);
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      if (staleInstanceSweepTimer !== undefined) clearInterval(staleInstanceSweepTimer);
      try {
        // The OAuth-bootstrap login Chrome (google-login) is tracked apart
        // from provision sessions — drain it too so it cannot outlive the
        // server. Its own signal handlers stand down in server mode (see
        // registerHeadlessRigCleanup), leaving this coordinator as the one
        // exit owner.
        const outcome = await runBoundedServerCleanup(
          admittedCallsDrained,
          async () => {
            await cancelActiveLoginBrowsers();
            await forwarder?.close();
            await closeAllProvisionSessions();
            await server.close();
          },
          deadlineMs,
        );
        if (outcome === "deadline")
          process.stderr.write(
            `[trusty-squire] server shutdown deadline reached after ${deadlineMs}ms; forcing exit\n`,
          );
      } catch (err) {
        // Teardown is best-effort: the host is gone, so leave a breadcrumb but
        // never let a failed browser close turn into an orphaned MCP process.
        process.stderr.write(
          `[trusty-squire] server shutdown cleanup failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }

      // Browser/Chrome child processes can keep the event loop alive briefly
      // even after their teardown. This mirrors bin.ts's forced CLI exit and
      // makes disconnect a reliable process-lifecycle boundary.
      // Keep the draining record discoverable for the entire terminal cleanup.
      // The owner reaper remains armed until process.exit; only now is the
      // instance record no longer needed by a same-lineage replacement.
      instance?.release();
      process.exit(0);
    })();
  };

  // Protocol.connect preserves a transport callback installed before it takes
  // ownership, so this also covers an explicit transport close.
  transport.onclose = requestShutdown;
  process.stdin.once("end", requestShutdown);
  process.stdin.once("close", requestShutdown);
  process.once("SIGHUP", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);

  // Protocol.connect chains transport.onmessage the same way it chains
  // onclose (see the comment above), so this sees every inbound message —
  // requests, notifications, pings — not just tool calls, without having to
  // reach into buildServer's request handlers.
  let lastActivityAt = Date.now();
  transport.onmessage = () => {
    lastActivityAt = Date.now();
  };

  idleTimer = setInterval(() => {
    if (shutdown !== undefined) return;
    if (forwarder?.connected()) return;
    const sessionCount = activeSessionCount();
    if (
      !shouldIdleExit(
        Date.now(),
        lastActivityAt,
        sessionCount,
        idleTimeoutMs(),
        idleTimeoutWithSessionMs(),
      )
    ) {
      return;
    }
    process.stderr.write(
      `[trusty-squire] server idle with ${sessionCount} open session(s) and no client ` +
        `activity past the bound; exiting (this tears down any open session's browser)\n`,
    );
    requestShutdown();
  }, idleCheckIntervalMs());
  idleTimer.unref();

  if (instance !== null) {
    heartbeatTimer = setInterval(() => {
      if (shutdown !== undefined) return;
      instance.heartbeat({
        lastActivityAt: forwarder?.connected() ? Date.now() : lastActivityAt,
        activeSessions: forwarder?.sessionCount() ?? activeSessionCount(),
        inFlightCalls: callAdmission.inFlightCount(),
      });
    }, heartbeatIntervalMs());
    heartbeatTimer.unref();
  }
  staleInstanceSweepTimer = setInterval(sweepStaleInstances, heartbeatIntervalMs());
  staleInstanceSweepTimer.unref();

  await server.connect(transport);
}
