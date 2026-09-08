import { connectOrLaunchBroker } from "./discovery.js";
import type { SessionGuard } from "../../session-guard.js";
import type { BrokerClient } from "./transport.js";
import type { TabCapability } from "./authority.js";
import { BrokerRefusal } from "./scheduler.js";

/** The MCP process holds only opaque capabilities. Never reconnect/replay a
 * dispatched request after transport loss: its side effect may have happened. */
export class OperatorForwarder {
  private connection: Promise<BrokerClient> | undefined;
  private client: BrokerClient | undefined;
  private connecting = false;
  private readonly sessions = new Map<string, TabCapability>();
  constructor(
    private readonly path: string,
    private readonly guard: SessionGuard,
  ) {}
  private connect(): Promise<BrokerClient> {
    if (this.connection === undefined) {
      this.connecting = true;
      this.connection = (async () => {
        const session = await this.guard.bind();
        if (session?.agent_session_token === undefined)
          throw new BrokerRefusal("unauthorized", "Connect before using the broker");
        const client = await connectOrLaunchBroker(this.path, session.agent_session_token);
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = false;
      });
    }
    return this.connection;
  }
  async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    const starting =
      name === "operate_start" || (name === "operate_recipe_run" && args.session_id === undefined);
    if (starting && this.connection !== undefined) {
      const existing = await this.connection.catch(() => undefined);
      if (existing === undefined || !existing.isConnected()) {
        this.connection = undefined;
        this.client = undefined;
        this.sessions.clear();
      }
    }
    const client = await this.connect();
    if (!starting && args.session_id === undefined && this.sessions.size === 1)
      args = { ...args, session_id: this.sessions.keys().next().value };
    const id = typeof args.session_id === "string" ? args.session_id : undefined;
    const capability = id === undefined ? undefined : this.sessions.get(id);
    if (
      name !== "operate_start" &&
      !(name === "operate_recipe_run" && id === undefined) &&
      capability === undefined
    )
      throw new BrokerRefusal("stale_lease", "Session is not owned by this MCP connection");
    const reply = (await client.call("tool", {
      name,
      args,
      ...(capability === undefined ? {} : { capability }),
    })) as { result: unknown; capability?: TabCapability };
    if (reply.capability !== undefined)
      this.sessions.set(reply.capability.sessionId, reply.capability);
    if (name === "operate_finish" && id !== undefined) this.sessions.delete(id);
    return reply.result;
  }
  sessionCount(): number {
    return this.sessions.size;
  }
  connected(): boolean {
    return this.client?.isConnected() ?? this.connecting;
  }
  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    const client = this.client ?? (await connection?.catch(() => undefined));
    this.client = undefined;
    await client?.close();
    this.sessions.clear();
  }
}
