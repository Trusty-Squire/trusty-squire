import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { chmod, lstat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BrokerRefusal } from "./refusal.js";
import type { BrokerPrincipal } from "./authority.js";
import type { BrokerNotification, ConnectRequest, ConnectResult } from "./protocol.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const MAX_FRAME = 8 * 1024 * 1024;
/** How many request results one connection retains so a retried request id gets
 * its stored result instead of a re-execution. */
const RETAINED_RESULTS_PER_CONNECTION = 512;
const requestSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1).max(128),
    method: z.string().min(1).max(64),
    params: z.record(z.unknown()),
    notifications: z.boolean().optional(),
  })
  .strict();
type Request = z.infer<typeof requestSchema>;
export type BrokerNotifier = (
  message: BrokerNotification["message"],
  data?: BrokerNotification["data"],
) => Promise<void>;
const notificationContext = new AsyncLocalStorage<BrokerNotifier | undefined>();
export function brokerNotifier(): BrokerNotifier | undefined {
  return notificationContext.getStore();
}
const notificationSchema = z.object({
  message: z.string(),
  data: z.record(z.unknown()).optional(),
});
type Reply = { id: string; result?: unknown; error?: { code: string; message: string } };

/** A socket is the client-liveness lease. There is deliberately no idle TTL:
 * a thinking agent with a live transport must not lose its browser session. */
function frames(socket: Socket, receive: (value: unknown) => void): void {
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const end = buffered.indexOf(10);
      if (end < 0) break;
      if (end > MAX_FRAME) {
        socket.destroy();
        return;
      }
      const frame = buffered.subarray(0, end);
      buffered = buffered.subarray(end + 1);
      try {
        receive(JSON.parse(frame.toString("utf8")));
      } catch {
        socket.destroy();
        return;
      }
    }
    if (buffered.length > MAX_FRAME) socket.destroy();
  });
}
function send(socket: Socket, value: unknown): void {
  const frame = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(frame) > MAX_FRAME) {
    socket.destroy(new Error("Broker frame exceeds the transport limit"));
    return;
  }
  socket.write(frame);
}

export interface BrokerTransportPort {
  authenticate(token: string, agentId?: string): Promise<Omit<BrokerPrincipal, "clientId"> | null>;
  /** Extra fields returned by the connect hook are merged into the
   * connect result. */
  connected?(
    principal: BrokerPrincipal,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
  call(
    principal: BrokerPrincipal,
    method: string,
    params: Record<string, unknown>,
    requestId: string,
  ): Promise<unknown>;
  /** Cancel one in-flight request of this connection by its frame id. Reports
   * whether a live request was still registered under it. */
  abort?(principal: BrokerPrincipal, requestId: string): boolean;
  disconnect(principal: BrokerPrincipal, explicit?: boolean): Promise<void>;
}

const ORPHAN_PROBE_TIMEOUT_MS = 2_000;
const LEGACY_HANDSHAKE_PROBE_TIMEOUT_MS = 5_000;

/** A stale Unix socket left behind by a SIGKILLed predecessor makes bind fail
 * with EADDRINUSE even though nothing is listening. A successful client connect
 * (or an unresolved probe) proves a live incumbent; a refused or missing
 * connection proves an orphan that may be reclaimed. */
export async function brokerEndpointHasLiveListener(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const socket = createConnection(path);
    const finish = (live: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      socket.destroy();
      resolve(live);
    };
    timer = setTimeout(() => finish(true), ORPHAN_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Positive prior-contract identification for reclaim. Sends the
 * pre-Contract-B `hello` handshake: only a resident prior-contract daemon
 * answers it, because a Contract B broker refuses every pre-auth method that
 * is not `connect`. The probe adds no wire operation to Contract B and is
 * only sent after a `connect` refusal, never on a healthy connect path. */
export async function brokerSpeaksLegacyWire(path: string, token: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection(path);
    const id = randomUUID();
    let buffered = Buffer.alloc(0);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    timer = setTimeout(() => finish(false), LEGACY_HANDSHAKE_PROBE_TIMEOUT_MS);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const end = buffered.indexOf(10);
        if (end < 0) break;
        const frame = buffered.subarray(0, end);
        buffered = buffered.subarray(end + 1);
        let reply: Reply;
        try {
          reply = JSON.parse(frame.toString("utf8")) as Reply;
        } catch {
          continue;
        }
        if (reply.id !== id) continue;
        finish(reply.error === undefined);
        return;
      }
    });
    socket.once("connect", () =>
      send(socket, {
        version: 1,
        id,
        method: "hello",
        params: {
          token,
          agentId: process.env.TRUSTY_SQUIRE_AGENT_IDENTITY ?? "local-agent",
        },
      }),
    );
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

/** Bind, reclaiming a socket path whose only owner is a dead predecessor. A
 * live incumbent still wins: the original EADDRINUSE is rethrown and no path is
 * removed. */
async function bindBrokerServer(server: Server, path: string): Promise<void> {
  const attempt = async (): Promise<void> =>
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(path);
    });
  try {
    await attempt();
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    if (await brokerEndpointHasLiveListener(path)) throw error;
    // The socket path exists but nothing answers: a SIGKILLed predecessor
    // orphaned it. Unlink the socket and bind normally.
    await unlink(path).catch(() => undefined);
    await attempt();
  }
}

/** Endpoint election is bind-exclusive against a live incumbent: never unlink a
 * socket another broker still answers on, even if that broker is unresponsive.
 * A socket with no live listener is a dead predecessor's orphan and is
 * reclaimed so a SIGKILL can never wedge startup. */
export async function listenBroker(
  path: string,
  port: BrokerTransportPort,
): Promise<{
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const cleanup = new Set<Promise<void>>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    let principal: BrokerPrincipal | undefined;
    let authenticating = false;
    let closed = false;
    const replies = new Map<string, Promise<unknown>>();
    let explicitClose = false;
    const disconnect = (owner: BrokerPrincipal) => {
      const task = port.disconnect(owner, explicitClose).catch(() => undefined);
      cleanup.add(task);
      void task.finally(() => cleanup.delete(task));
    };
    socket.once("close", () => {
      closed = true;
      sockets.delete(socket);
      if (principal !== undefined) disconnect(principal);
    });
    const dispatch = async (request: Request): Promise<unknown> => {
      if (principal === undefined) {
        if (
          request.method !== "connect" ||
          authenticating ||
          typeof request.params.token !== "string"
        ) {
          throw new BrokerRefusal("unauthorized", "Authenticate before issuing commands");
        }
        authenticating = true;
        const agentId =
          typeof request.params.agentId === "string" ? request.params.agentId : "local-agent";
        if (agentId.length === 0 || agentId.length > 128)
          throw new BrokerRefusal("unauthorized", "Invalid agent identity");
        const identity = await port.authenticate(request.params.token, agentId);
        if (identity === null) throw new BrokerRefusal("unauthorized", "Invalid broker credential");
        const candidate = { ...identity, clientId: randomUUID() };
        let extra: Record<string, unknown> | void;
        try {
          extra = await port.connected?.(candidate, request.params);
        } catch (error) {
          // The connect hook may refuse after
          // the candidate exists; retire it so no half-connected state lingers.
          await port.disconnect(candidate);
          throw error;
        }
        if (closed) {
          await port.disconnect(candidate);
          throw new BrokerRefusal("cancelled", "Client disconnected");
        }
        principal = candidate;
        return {
          version: 1,
          clientId: principal.clientId,
          ...(isRecord(extra) ? extra : {}),
        };
      }
      if (request.method === "connect")
        throw new BrokerRefusal("unauthorized", "Connection already bound");
      // Reserved control frame, deliberately not one of the four operations: it
      // cancels a single in-flight request by its frame id so one caller's
      // cancellation never costs the connection or its other sessions. It never
      // reaches port.call, so it is neither registered nor guard-inspected.
      if (request.method === "abort") {
        const target = request.params.requestId;
        if (typeof target !== "string")
          throw new BrokerRefusal("invalid_request", "Abort requires a requestId");
        return { aborted: port.abort?.(principal, target) ?? false };
      }
      // A session-less close ends the connection: the lease boundary that used
      // to be `client_close`. It still reaches the port so the owner can run
      // any connection-scoped teardown before the socket goes away.
      if (request.method === "close" && typeof request.params.sessionId !== "string") {
        explicitClose = true;
        return await port.call(principal, "close", request.params, request.id);
      }
      const owner = principal;
      const notify: BrokerNotifier | undefined = request.notifications
        ? async (message, data) => {
            if (closed) throw new BrokerRefusal("broker_lost", "Notification connection is closed");
            send(socket, { id: request.id, notification: { message, data } });
          }
        : undefined;
      return await notificationContext.run(notify, () =>
        port.call(owner, request.method, request.params, request.id),
      );
    };
    frames(socket, (value) => {
      const parsed = requestSchema.safeParse(value);
      if (!parsed.success) {
        socket.destroy();
        return;
      }
      const request = parsed.data;
      const previous = replies.get(request.id);
      let result: Promise<unknown>;
      if (previous !== undefined) {
        result = previous;
      } else {
        result = dispatch(request);
        replies.set(request.id, result);
        // Drop only the oldest retained result; the newest request is never
        // refused or evicted because of the bound.
        if (replies.size > RETAINED_RESULTS_PER_CONNECTION) {
          const oldest = replies.keys().next().value;
          if (oldest !== undefined && oldest !== request.id) replies.delete(oldest);
        }
      }
      void result.then(
        (data) => {
          if (!closed) send(socket, { id: request.id, result: data });
        },
        (error: unknown) => {
          if (!closed)
            send(socket, {
              id: request.id,
              error: {
                code: error instanceof BrokerRefusal ? error.code : "broker_execution_failed",
                message: error instanceof Error ? error.message : String(error),
              },
            });
        },
      );
    });
  });
  await bindBrokerServer(server, path);
  await chmod(path, 0o600);
  const identity = await lstat(path);
  return {
    close: async () => {
      const stopped = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      for (const socket of sockets) socket.destroy();
      await stopped;
      await Promise.all([...cleanup]);
      const current = await lstat(path).catch(() => null);
      if (current?.ino === identity.ino && current.dev === identity.dev) await unlink(path);
    },
  };
}

export class BrokerClient {
  private readonly pending = new Map<
    string,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      notifyUser?: BrokerNotifier;
      notifications: Promise<void>;
    }
  >();
  private ended = false;
  /** The connect result. */
  welcome: ConnectResult | undefined;
  private constructor(private readonly socket: Socket) {
    socket.on("error", () => undefined);
    socket.once("close", () => {
      this.ended = true;
      for (const request of this.pending.values())
        request.reject(
          new BrokerRefusal(
            "broker_lost",
            "Broker connection lost; dispatched outcome may be unknown. Do not replay mutations.",
          ),
        );
      this.pending.clear();
    });
    frames(socket, (value) => {
      const reply = value as Reply;
      if (typeof reply !== "object" || reply === null || typeof reply.id !== "string") {
        socket.destroy();
        return;
      }
      const pending = this.pending.get(reply.id);
      if (pending === undefined) return;
      if ("notification" in reply) {
        const notification = notificationSchema.parse(reply.notification);
        pending.notifications = pending.notifications
          .then(() => pending.notifyUser?.(notification.message, notification.data))
          .catch(() => undefined);
        return;
      }
      this.pending.delete(reply.id);
      if (reply.error !== undefined)
        pending.reject(new BrokerRefusal(reply.error.code, reply.error.message));
      else {
        void pending.notifications.then(() => pending.resolve(reply.result));
      }
    });
  }
  static async connect(
    path: string,
    token: string,
    options: { probe?: boolean; handshakeTimeoutMs?: number } = {},
  ): Promise<BrokerClient> {
    const socket = createConnection(path);
    const client = new BrokerClient(socket);
    let handshakeTimeout: BrokerRefusal | undefined;
    const deadline = setTimeout(() => {
      handshakeTimeout = new BrokerRefusal(
        "broker_handshake_timeout",
        "Broker connect handshake timed out",
      );
      socket.destroy(handshakeTimeout);
    }, options.handshakeTimeoutMs ?? 5_000);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      const request: ConnectRequest = {
        token,
        agentId: process.env.TRUSTY_SQUIRE_AGENT_IDENTITY ?? "local-agent",
        ...(options.probe ? { probe: true } : {}),
      };
      const welcome = await client.call("connect", { ...request });
      client.welcome = isRecord(welcome) ? (welcome as unknown as ConnectResult) : undefined;
      return client;
    } catch (error) {
      socket.destroy();
      // Socket close rejects pending calls as broker_lost. During connect only,
      // preserve the deadline cause so discovery can retire a wedged owner.
      throw handshakeTimeout ?? error;
    } finally {
      clearTimeout(deadline);
    }
  }
  call(
    method: string,
    params: Record<string, unknown>,
    id: string = randomUUID(),
    notifyUser?: BrokerNotifier,
  ): Promise<unknown> {
    if (this.ended || this.socket.destroyed)
      return Promise.reject(new BrokerRefusal("broker_lost", "Broker connection is closed"));
    if (this.pending.has(id))
      return Promise.reject(new BrokerRefusal("duplicate_pending", "Request is already pending"));
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve,
        reject,
        ...(notifyUser ? { notifyUser } : {}),
        notifications: Promise.resolve(),
      });
      send(this.socket, {
        version: 1,
        id,
        method,
        params,
        ...(notifyUser ? { notifications: true } : {}),
      });
    });
  }
  /** Cancel one in-flight request without disturbing the connection. */
  async abort(requestId: string): Promise<void> {
    if (!this.isConnected()) return;
    await this.call("abort", { requestId }).catch(() => undefined);
  }

  isConnected(): boolean {
    return !this.ended && !this.socket.destroyed;
  }

  async close(): Promise<void> {
    if (this.ended) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", resolve);
      this.socket.destroy();
    });
  }

  async release(): Promise<void> {
    if (this.ended) return;
    try {
      await this.call("close", {});
    } finally {
      await this.close();
    }
  }
}
