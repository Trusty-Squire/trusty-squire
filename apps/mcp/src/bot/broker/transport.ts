import { createServer, createConnection, type Socket } from "node:net";
import { chmod, lstat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
  })
  .strict();
type Request = z.infer<typeof requestSchema>;
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
    supervisor?: boolean,
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

/** Endpoint election is bind-exclusive. Never unlink an existing socket to win
 * election: its incumbent may still own Chrome, even if it is unresponsive. */
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
        const supervisor = request.params.supervisor === true;
        if (agentId.length === 0 || agentId.length > 128)
          throw new BrokerRefusal("unauthorized", "Invalid agent identity");
        const identity = await port.authenticate(
          request.params.token,
          agentId,
          lineageCredential,
          supervisor,
        );
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
      return await port.call(principal, request.method, request.params, request.id);
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
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
    { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
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
      this.pending.delete(reply.id);
      if (reply.error !== undefined)
        pending.reject(new BrokerRefusal(reply.error.code, reply.error.message));
      else {
        pending.resolve(reply.result);
      }
    });
  }
  static async connect(
    path: string,
    token: string,
    lineageCredential?: string,
    supervisor = false,
  ): Promise<BrokerClient> {
    const socket = createConnection(path);
    const client = new BrokerClient(socket);
    const deadline = setTimeout(
      () => socket.destroy(new Error("Broker authentication timed out")),
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
        ...(lineageCredential === undefined ? {} : { lineageCredential }),
        ...(supervisor ? { supervisor: true } : {}),
      });
      return client;
    } catch (error) {
      socket.destroy();
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  }
  static async connectSupervisor(path: string, token: string): Promise<BrokerClient> {
    return await BrokerClient.connect(path, token, undefined, true);
  }
  call(
    method: string,
    params: Record<string, unknown>,
    id: string = randomUUID(),
  ): Promise<unknown> {
    if (this.ended || this.socket.destroyed)
      return Promise.reject(new BrokerRefusal("broker_lost", "Broker connection is closed"));
    if (this.pending.has(id))
      return Promise.reject(new BrokerRefusal("duplicate_pending", "Request is already pending"));
    if (this.pending.size >= 64)
      return Promise.reject(new BrokerRefusal("capacity", "Too many pending broker calls"));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      send(this.socket, { version: 1, id, method, params });
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
