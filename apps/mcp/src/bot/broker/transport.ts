import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { chmod, lstat, unlink } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { BrokerRefusal } from "./scheduler.js";
import {
  FORWARDER_HANDOFF_TIMEOUT_MS,
  type BrokerPrincipal,
  type TabCapability,
} from "./authority.js";

const MAX_FRAME = 8 * 1024 * 1024;
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
export type BrokerNotifier = (message: string, data?: Record<string, unknown>) => Promise<void>;
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
  if (Buffer.byteLength(frame) > MAX_FRAME || socket.writableLength > MAX_FRAME * 2) {
    socket.destroy(new Error("Broker transport capacity exceeded"));
    return;
  }
  socket.write(frame);
}

export interface BrokerTransportPort {
  authenticate(
    token: string,
    agentId?: string,
    lineageCredential?: string,
  ): Promise<Omit<BrokerPrincipal, "clientId"> | null>;
  connected?(principal: BrokerPrincipal): Promise<void> | void;
  call(
    principal: BrokerPrincipal,
    method: string,
    params: Record<string, unknown>,
    requestId: string,
  ): Promise<unknown>;
  disconnect(principal: BrokerPrincipal, explicit?: boolean): Promise<void>;
}

const ORPHAN_PROBE_TIMEOUT_MS = 2_000;

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
    // orphaned it. Unlink the socket and its owner proof, then bind normally.
    await unlink(path).catch(() => undefined);
    await unlink(`${path}.owner.json`).catch(() => undefined);
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
    const replies = new Map<string, { input: string; result: Promise<unknown> }>();
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
          request.method !== "hello" ||
          authenticating ||
          typeof request.params.token !== "string"
        ) {
          throw new BrokerRefusal("unauthorized", "Authenticate before issuing commands");
        }
        authenticating = true;
        const agentId =
          typeof request.params.agentId === "string" ? request.params.agentId : "local-agent";
        const lineageCredential =
          typeof request.params.lineageCredential === "string"
            ? request.params.lineageCredential
            : undefined;
        if (agentId.length === 0 || agentId.length > 128)
          throw new BrokerRefusal("unauthorized", "Invalid agent identity");
        const identity = await port.authenticate(request.params.token, agentId, lineageCredential);
        if (identity === null) throw new BrokerRefusal("unauthorized", "Invalid broker credential");
        const candidate = { ...identity, clientId: randomUUID() };
        await port.connected?.(candidate);
        if (closed) {
          await port.disconnect(candidate);
          throw new BrokerRefusal("cancelled", "Client disconnected");
        }
        principal = candidate;
        return { version: 1, clientId: principal.clientId };
      }
      if (request.method === "hello")
        throw new BrokerRefusal("unauthorized", "Connection already bound");
      if (request.method === "client_close") {
        explicitClose = true;
        return {};
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
      const input = JSON.stringify([request.method, request.params]);
      const previous = replies.get(request.id);
      let result: Promise<unknown>;
      if (previous !== undefined) {
        result =
          previous.input === input
            ? previous.result
            : Promise.reject(
                new BrokerRefusal("request_id_reused", "Request ID has different input"),
              );
      } else if (replies.size >= 8192) {
        result = Promise.reject(
          new BrokerRefusal("capacity", "Connection command budget exhausted"),
        );
      } else {
        result = dispatch(request);
        replies.set(request.id, { input, result });
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
    lineageCredential?: string,
  ): Promise<BrokerClient> {
    const socket = createConnection(path);
    const client = new BrokerClient(socket);
    let handshakeTimeout: BrokerRefusal | undefined;
    const deadline = setTimeout(
      () => {
        handshakeTimeout = new BrokerRefusal(
          "broker_handshake_timeout",
          "Broker hello handshake timed out",
        );
        socket.destroy(handshakeTimeout);
      },
      lineageCredential === undefined ? 5_000 : FORWARDER_HANDOFF_TIMEOUT_MS + 5_000,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      await client.call("hello", {
        token,
        agentId: process.env.TRUSTY_SQUIRE_AGENT_IDENTITY ?? "local-agent",
        // Health probes use a fresh identity, so they never wait for or reclaim
        // an existing forwarder lineage. All connections use the same authentication.
        lineageCredential: lineageCredential ?? randomBytes(32).toString("base64url"),
      });
      return client;
    } catch (error) {
      socket.destroy();
      // Socket close rejects pending calls as broker_lost. During hello only,
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
    if (this.pending.size >= 64)
      return Promise.reject(new BrokerRefusal("capacity", "Too many pending broker calls"));
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
  async acknowledge(requestId: string): Promise<void> {
    await this.call("acknowledge", { requestId });
  }
  async confirmStartDelivery(capability: TabCapability): Promise<void> {
    await this.call("confirm_start", { capability });
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
    await this.call("client_close", {});
    await this.close();
  }
}
