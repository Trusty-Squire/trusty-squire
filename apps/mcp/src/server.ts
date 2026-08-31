// MCP server: reads the session from keytar/file, sets up an ApiClient
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
import { cancelActiveLoginBrowsers } from "./bot/google-login.js";
import { sweepOperatorProfilePoolOrphans } from "./bot/operator-profile-pool.js";
import { startOwnerProcessReaper } from "./bot/owner-process-reaper.js";
import {
  activeSessionCount,
  closeAllProvisionSessions,
  withProvisionSessionCall,
} from "./bot/provision-session.js";
import { buildToolRegistry, findTool } from "./tools/index.js";
import { openSessionStorage } from "./session.js";
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
const DEFAULT_IDLE_TIMEOUT_MS = 20 * 60 * 1_000; // 20m, no open session
const DEFAULT_IDLE_TIMEOUT_WITH_SESSION_MS = 12 * 60 * 60 * 1_000; // 12h, session open
const DEFAULT_IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1_000; // 5m — must stay well under the 20m bound above
const DEFAULT_STARTUP_PROFILE_SWEEP_TIMEOUT_MS = 2_000;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function idleTimeoutMs(): number {
  return envMs("TRUSTY_SQUIRE_SERVER_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS);
}

function idleTimeoutWithSessionMs(): number {
  return envMs(
    "TRUSTY_SQUIRE_SERVER_IDLE_TIMEOUT_WITH_SESSION_MS",
    DEFAULT_IDLE_TIMEOUT_WITH_SESSION_MS,
  );
}

function idleCheckIntervalMs(): number {
  return envMs("TRUSTY_SQUIRE_SERVER_IDLE_CHECK_INTERVAL_MS", DEFAULT_IDLE_CHECK_INTERVAL_MS);
}

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
const SERVER_INSTRUCTIONS = `This is Trusty Squire — it drives a real browser through signup, provisioning,
and checkout flows on the user's behalf (\`operate_start\`/\`operate_observe\`/
\`operate_act\`/\`operate_pay\`/\`operate_finish\`, plus recipe replay), and backs it
with a write-only credential vault.
The user's secrets (API keys, tokens, passwords) live in the vault encrypted;
they are NOT in the conversation context and CANNOT be read back to you.
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
- There is NO way to extract a raw secret value to you — by design. If a
  user wants the plaintext (e.g. for a .env file), they read it from the
  Trusty Squire web vault themselves.`;

export interface ServerCallLifecycle {
  started(): boolean;
  finished(): void;
}

export interface ServerCallAdmission extends ServerCallLifecycle {
  closeAndDrain(): Promise<void>;
  inFlightCount(): number;
}

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

export async function buildServer(
  api: ApiClient | null,
  callLifecycle?: ServerCallLifecycle,
): Promise<Server> {
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
      ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
      ...(t.meta !== undefined ? { _meta: t.meta } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
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
    if (api === null) {
      return errorContent(
        "reconnect_required",
        `This install is from before single-tier auth and isn't bound to an account. ` +
          `Run \`npx @trusty-squire/mcp connect\` to reconnect.`,
      );
    }
    if (callLifecycle !== undefined && !callLifecycle.started()) {
      return errorContent("server_unavailable", "server is shutting down");
    }
    try {
      api.setRequestingAgent(server.getClientVersion()?.name ?? "unknown-agent");
      const invoke = async () =>
        await tool.handler(parsed.data, api, {
          notifyUser: async (message, data) => {
            await server.sendLoggingMessage({
              level: "notice",
              logger: "trusty-squire",
              data: { message, ...data },
            });
          },
        });
      // Tool handlers await independently.  A finish must therefore close the
      // admission gate and drain calls that already entered before it snapshots
      // eligible state and closes the browser. `operate_finish*` owns that transition.
      const sessionId =
        typeof parsed.data.session_id === "string" ? parsed.data.session_id : undefined;
      const result =
        sessionId !== undefined && !/^operate_finish(?:_task)?$/.test(tool.name)
          ? await withProvisionSessionCall(sessionId, async () => await invoke())
          : await invoke();
      return toolResultContent(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const serverUnavailable =
        /unknown provision session|requires one active operate_start browser session/i.test(
          message,
        );
      const malformedAction = /^operate_act kind=.* requires /i.test(message);
      return serverUnavailable
        ? errorContent(
            "server_unavailable",
            `${message}. Retry once. Never kill or restart the shared operator process; it serves every lane/home.`,
            {
              retry: { max_attempts: 1 },
            },
          )
        : errorContent(malformedAction ? "invalid_arguments" : "tool_execution_failed", message);
    } finally {
      callLifecycle?.finished();
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
      content: [
        { type: "text" as const, text: compactToolResultText(meta) },
        { type: "image" as const, data: image.data_base64, mimeType: image.mime_type },
      ],
    };
  }
  return {
    content: [{ type: "text" as const, text: compactToolResultText(result) }],
  };
}

/** Compact V2 is a model wire protocol; indentation adds no information. */
export function compactToolResultText(result: unknown): string {
  if (
    typeof result === "object" &&
    result !== null &&
    "format" in result &&
    (result as { format?: unknown }).format === "compact-v2"
  ) {
    return JSON.stringify(result);
  }
  return JSON.stringify(result, null, 2);
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
  if (process.platform === "linux") {
    const timeoutMs = envMs(
      "TRUSTY_SQUIRE_STARTUP_PROFILE_SWEEP_TIMEOUT_MS",
      DEFAULT_STARTUP_PROFILE_SWEEP_TIMEOUT_MS,
    );
    void sweepOperatorProfilePoolOrphans({ deadline: Date.now() + timeoutMs }).catch(
      () => undefined,
    );
  }
  // Startup breadcrumb on stderr (which lands in the host agent's MCP
  // log). A silent no-op was the worst part of the entrypoint-guard
  // bug — this line makes "did the server actually start?" answerable
  // at a glance.
  process.stderr.write(`[trusty-squire] server v${VERSION} starting\n`);

  const storage = await openSessionStorage();
  const session = await storage.read();

  // Single-tier: every session is account-bound. A session with just a
  // machine_token (pre-collapse install) yields api=null, and every
  // tool call returns the re-install instruction.
  const api =
    session !== null && session.agent_session_token !== undefined
      ? new ApiClient({
          apiBaseUrl: session.api_base_url,
          registryBaseUrl: DEFAULT_REGISTRY_BASE,
          agentSessionToken: session.agent_session_token,
          agentIdentity: process.env.TRUSTY_SQUIRE_AGENT_IDENTITY ?? "unknown",
          ...(session.account_id !== undefined ? { accountId: session.account_id } : {}),
        })
      : null;

  const callAdmission = createServerCallAdmission();
  const server = await buildServer(api, callAdmission);
  const transport = new StdioServerTransport();

  // A stdio client can disappear without sending a signal (for example when
  // its parent agent exits). Chrome keeps Node's event loop alive in that
  // case, so close every active provisioning browser and explicitly exit.
  // Keep the single promise so EOF, transport closure, a signal, and the
  // idle backstop below racing together cannot run teardown twice.
  let shutdown: Promise<void> | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const requestShutdown = (): void => {
    if (shutdown !== undefined) return;
    const admittedCallsDrained = callAdmission.closeAndDrain();

    shutdown = (async () => {
      process.stdin.removeListener("end", requestShutdown);
      process.stdin.removeListener("close", requestShutdown);
      process.removeListener("SIGHUP", requestShutdown);
      process.removeListener("SIGTERM", requestShutdown);
      process.removeListener("SIGINT", requestShutdown);
      if (idleTimer !== undefined) clearInterval(idleTimer);

      try {
        // The OAuth-bootstrap login Chrome (google-login) is tracked apart
        // from provision sessions — drain it too so it cannot outlive the
        // server. Its own signal handlers stand down in server mode (see
        // registerHeadlessRigCleanup), leaving this coordinator as the one
        // exit owner.
        await admittedCallsDrained;
        await cancelActiveLoginBrowsers();
        await closeAllProvisionSessions();
        await server.close();
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

  await server.connect(transport);
}
