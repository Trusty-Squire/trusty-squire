import { connectOrLaunchBroker } from "./discovery.js";
import { createHash, randomUUID } from "node:crypto";
import { fstatSync, readFileSync, writeFileSync } from "node:fs";
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
  private readonly idempotencyNamespace: string;
  constructor(
    private readonly path: string,
    private readonly guard: SessionGuard,
    identity?: string,
  ) {
    this.idempotencyNamespace = identity ?? this.loadIdentity();
  }
  private loadIdentity(): string {
    if (process.env.TRUSTY_SQUIRE_FORWARDER_IDENTITY !== undefined)
      return process.env.TRUSTY_SQUIRE_FORWARDER_IDENTITY;
    let stdin: { dev: number; ino: number };
    try {
      stdin = fstatSync(0);
    } catch {
      throw new BrokerRefusal(
        "forwarder_identity_required",
        "Set a stable forwarder identity when stdin lineage cannot be established",
      );
    }
    const scope = createHash("sha256")
      .update(
        `${process.ppid}:${stdin.dev}:${stdin.ino}:${process.env.TRUSTY_SQUIRE_AGENT_IDENTITY ?? "local-agent"}`,
      )
      .digest("hex");
    const statePath = `${this.path}.forwarder-${scope}.id`;
    try {
      const identity = readFileSync(statePath, "utf8").trim();
      if (/^[0-9a-f-]{36}$/i.test(identity)) return identity;
    } catch {}
    const identity = randomUUID();
    try {
      writeFileSync(statePath, `${identity}\n`, { mode: 0o600, flag: "wx" });
      return identity;
    } catch {
      return readFileSync(statePath, "utf8").trim();
    }
  }
  private connect(): Promise<BrokerClient> {
    if (this.connection === undefined) {
      this.connecting = true;
      this.connection = (async () => {
        const session = await this.guard.bind();
        if (session?.agent_session_token === undefined)
          throw new BrokerRefusal("unauthorized", "Connect before using the broker");
        const client = await connectOrLaunchBroker(
          this.path,
          session.agent_session_token,
          this.idempotencyNamespace,
        );
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = false;
      });
    }
    return this.connection;
  }
  private async reconcile(client: BrokerClient, requestId: string): Promise<void> {
    const result = (await client.call("reconcile", {})) as {
      outcomes?: Array<{ requestId: string; operation: string }>;
    };
    const outcomes = result.outcomes ?? [];
    if (outcomes.length === 0) return;
    if (outcomes.some((outcome) => outcome.requestId === requestId)) return;
    throw new BrokerRefusal(
      "outcome_unknown",
      `Prior ${outcomes.map((outcome) => outcome.operation).join(", ")} completed without a delivered result; do not replay it`,
    );
  }
  private async reclaim(client: BrokerClient): Promise<void> {
    const reply = (await client.call("reclaim", {})) as { capabilities?: TabCapability[] };
    for (const capability of reply.capabilities ?? []) this.sessions.set(capability.sessionId, capability);
  }
  private idempotencyKey(requestId: string): string {
    return `${this.idempotencyNamespace}:${createHash("sha256")
      .update(requestId)
      .digest("hex")}`;
  }
  async invoke(
    name: string,
    args: Record<string, unknown>,
    requestId: string = randomUUID(),
  ): Promise<unknown> {
    const idempotencyKey = this.idempotencyKey(requestId);
    const starting =
      name === "operate_start" || (name === "operate_recipe_run" && args.session_id === undefined);
    if (this.connection !== undefined) {
      const existing = await this.connection.catch(() => undefined);
      if (existing === undefined || !existing.isConnected()) {
        this.connection = undefined;
        this.client = undefined;
        if (starting) this.sessions.clear();
      }
    }
    const client = await this.connect();
    await this.reclaim(client);
    await this.reconcile(client, idempotencyKey);
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
    const reply = (await client.call(
      "tool",
      {
        name,
        args,
        ...(capability === undefined ? {} : { capability }),
      },
      idempotencyKey,
    )) as { result: unknown; capability?: TabCapability };
    if (reply.capability !== undefined)
      this.sessions.set(reply.capability.sessionId, reply.capability);
    client.acknowledge(idempotencyKey);
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
