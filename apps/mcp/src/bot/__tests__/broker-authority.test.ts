import { describe, expect, it, vi } from "vitest";
import {
  BrokerAuthority,
  CONNECTION_SESSION_GRACE_MS,
  type BrokerPrincipal,
  type BrokerSessionPort,
} from "../broker/authority.js";

const principal = (clientId: string): BrokerPrincipal => ({
  agentId: "agent",
  clientId,
});

function port(overrides: Partial<BrokerSessionPort> = {}): BrokerSessionPort {
  return {
    targetId: "target",
    invoke: async () => ({}),
    close: async () => true,
    orphan: async () => undefined,
    ...overrides,
  };
}

describe("broker authority", () => {
  it("runs one session's commands in dispatch order", async () => {
    const authority = new BrokerAuthority();
    const order: string[] = [];
    const owner = principal("a");
    const sessionId = await authority.open(owner, async () =>
      port({
        invoke: async (name) => {
          order.push(`start:${name}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(`end:${name}`);
          return name;
        },
      }),
    );
    const first = authority.invoke(owner, sessionId, "r1", "one", {});
    const second = authority.invoke(owner, sessionId, "r2", "two", {});
    expect(await first).toBe("one");
    expect(await second).toBe("two");
    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });

  it("refuses a session opened by another connection", async () => {
    const authority = new BrokerAuthority();
    const owner = principal("a");
    const sessionId = await authority.open(owner, async () => port());
    expect(() => authority.invoke(principal("b"), sessionId, "r1", "one", {})).toThrow(
      "Session does not name an owned live session",
    );
    expect(await authority.invoke(owner, sessionId, "r1", "one", {})).toEqual({});
  });

  it("answers a read with a busy receipt while a mutation is pending", async () => {
    const authority = new BrokerAuthority();
    const owner = principal("a");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessionId = await authority.open(owner, async () =>
      port({
        invoke: async () => {
          await gate;
          return { done: true };
        },
      }),
    );
    const mutation = authority.invoke(owner, sessionId, "r1", "operate_click", {});
    expect(authority.busyReadReceipt(owner, sessionId)).toMatchObject({
      session_id: sessionId,
      status: "session_busy",
      execution: "pending",
      closed: false,
    });
    expect(await authority.invoke(owner, sessionId, "r2", "operate_observe", {})).toMatchObject({
      status: "session_busy",
    });
    release();
    expect(await mutation).toEqual({ done: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authority.busyReadReceipt(owner, sessionId)).toBeUndefined();
  });

  it("delivers terminal finish ahead of the hung mutation tail it cancels", async () => {
    const authority = new BrokerAuthority();
    const owner = principal("a");
    const calls: string[] = [];
    const sessionId = await authority.open(owner, async () =>
      port({
        invoke: async (name) => {
          calls.push(name);
          if (name === "operate_click") await new Promise(() => undefined);
          return { closed: true };
        },
      }),
    );
    void authority.invoke(owner, sessionId, "r1", "operate_click", {});
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(await authority.finish(owner, sessionId, "r2", { session_id: sessionId })).toEqual({
      closed: true,
    });
    expect(calls).toEqual(["operate_click", "operate_finish"]);
  });

  it("closes a session once and retains an unproven close in inventory", async () => {
    const authority = new BrokerAuthority();
    const owner = principal("a");
    const closes: string[] = [];
    const sessionId = await authority.open(owner, async () =>
      port({
        close: async (reason) => {
          closes.push(String(reason));
          return false;
        },
      }),
    );
    expect(await authority.close(owner, sessionId)).toBe(false);
    expect(await authority.close(owner, sessionId)).toBe(false);
    expect(closes).toEqual(["finish"]);
    expect(authority.inventory().sessions).toBe(1);
  });

  it("forgets a session whose terminal cleanup already settled", async () => {
    const authority = new BrokerAuthority();
    const owner = principal("a");
    const sessionId = await authority.open(owner, async () => port());
    authority.retire(owner, sessionId);
    expect(authority.inventory().sessions).toBe(0);
    expect(await authority.close(owner, sessionId, true)).toBe(true);
  });

  it("closes an explicitly released connection's sessions immediately", async () => {
    const authority = new BrokerAuthority();
    const owner = principal("a");
    const closed: string[] = [];
    await authority.open(owner, async (id) =>
      port({
        close: async () => {
          closed.push(id);
          return true;
        },
      }),
    );
    await authority.disconnect(owner, true);
    expect(closed).toHaveLength(1);
    expect(authority.inventory()).toEqual({ sessions: 0, admitting: 0, closing: 0 });
  });

  it("closes a dropped connection's sessions after a short grace", async () => {
    vi.useFakeTimers();
    try {
      const authority = new BrokerAuthority();
      const owner = principal("a");
      const closed: string[] = [];
      await authority.open(owner, async (id) =>
        port({
          close: async () => {
            closed.push(id);
            return true;
          },
        }),
      );
      await authority.disconnect(owner, false);
      expect(closed).toEqual([]);
      expect(authority.inventory().closing).toBe(1);
      await vi.advanceTimersByTimeAsync(CONNECTION_SESSION_GRACE_MS + 1);
      expect(closed).toHaveLength(1);
      expect(authority.inventory()).toEqual({ sessions: 0, admitting: 0, closing: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up a failed admission that never returned a port", async () => {
    const authority = new BrokerAuthority();
    const owner = principal("a");
    const events: string[] = [];
    await expect(
      authority.open(
        owner,
        async () => {
          throw new Error("start failed");
        },
        async () => {
          events.push("cleanup");
          return false;
        },
        async () => {
          events.push("orphan");
        },
      ),
    ).rejects.toThrow("start failed");
    expect(events).toEqual(["cleanup", "orphan"]);
    expect(authority.inventory()).toEqual({ sessions: 0, admitting: 0, closing: 0 });
  });

  it("aborts a starting session when its client drops", async () => {
    const authority = new BrokerAuthority();
    const owner = principal("a");
    const opening = authority.open(owner, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return port();
    });
    await authority.disconnect(owner, true);
    await expect(opening).rejects.toThrow("Client disconnected during admission");
    expect(authority.inventory().sessions).toBe(0);
  });
});
