import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { SessionGuard } from "../../session-guard.js";
import { BrokerAuthority, CONNECTION_SESSION_GRACE_MS } from "../broker/authority.js";
import { OperatorForwarder } from "../broker/forwarder.js";
import { listenBroker } from "../broker/transport.js";

const guard = { bind: async () => null } as unknown as SessionGuard;

it("refuses a second connection on the first connection's session and closes the tab when the owner drops", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-session-reconnect-"));
  const path = join(root, "broker.sock");
  const authority = new BrokerAuthority();
  const closed: string[] = [];
  const listener = await listenBroker(path, {
    call: async (principal, method, params, requestId) => {
      if (method === "open") {
        const sessionId = await authority.open(principal, async () => ({
          targetId: "target",
          invoke: async (name) => ({ name }),
          close: async () => {
            closed.push(sessionId);
            return true;
          },
          orphan: async () => undefined,
        }));
        return { sessionId, observation: { session_id: sessionId } };
      }
      const sessionId = params.sessionId as string;
      if (method === "command")
        return {
          result: await authority.invoke(
            principal,
            sessionId,
            requestId,
            params.name as string,
            {},
          ),
        };
      if (method === "close") {
        const result = await authority.finish(principal, sessionId, requestId, {});
        const finished = await authority.close(principal, sessionId);
        return { result, closed: finished };
      }
      throw new Error(`Unexpected method ${method}`);
    },
    disconnect: async (principal, explicit) => await authority.disconnect(principal, explicit),
  });
  const owner = new OperatorForwarder(path, guard);
  const other = new OperatorForwarder(path, guard);
  try {
    const started = (await owner.invoke("operate_start", { service_url: "https://service.test" })) as {
      session_id: string;
    };
    await expect(
      other.invoke("operate_observe", { session_id: started.session_id }),
    ).rejects.toMatchObject({ code: "stale_lease" });
    await owner.close();
    expect(closed).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, CONNECTION_SESSION_GRACE_MS + 50));
    expect(closed).toEqual([started.session_id]);
    expect(authority.inventory().sessions).toBe(0);
  } finally {
    await Promise.all([owner.close(), other.close()]);
    await listener.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
