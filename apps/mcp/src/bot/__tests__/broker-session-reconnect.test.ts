import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionGuard } from "../../session-guard.js";
import { BrokerAuthority } from "../broker/authority.js";
import { brokerAgentIdentity } from "../broker/agent-identity.js";
import { OperatorForwarder } from "../broker/forwarder.js";
import { listenBroker } from "../broker/transport.js";

const guard = { bind: async () => null } as unknown as SessionGuard;
const beelineHome =
  "/home/user/.local/state/beeline/agents/9c40fbbb2d1fd6b205e71d948875518bc5cb891de976323ca403892f2309f19b/rooms/7e52a91f-00ed-4a45-8b65-d7893a3f0f9f/agent-home/user";

afterEach(() => vi.unstubAllEnvs());

it("uses the Beeline room as the stable fallback identity without grouping other local processes", () => {
  const first = brokerAgentIdentity({ HOME: beelineHome }, 101);
  expect(first).toBe(brokerAgentIdentity({ HOME: beelineHome }, 202));
  expect(first).not.toBe(
    brokerAgentIdentity({ HOME: beelineHome.replace("7e52a91f", "8e52a91f") }, 303),
  );
  expect(brokerAgentIdentity({ HOME: "/home/user" }, 101)).not.toBe(
    brokerAgentIdentity({ HOME: "/home/user" }, 202),
  );
  expect(
    brokerAgentIdentity({ HOME: beelineHome, TRUSTY_SQUIRE_AGENT_IDENTITY: "named-agent" }, 101),
  ).toBe("named-agent");
});

it("continues one agent's session from another broker client after the first process retires", async () => {
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
  const a = new OperatorForwarder(path, guard);
  const b = new OperatorForwarder(path, guard);
  const other = new OperatorForwarder(path, guard);
  try {
    vi.stubEnv("TRUSTY_SQUIRE_AGENT_IDENTITY", "");
    vi.stubEnv("HOME", beelineHome);
    const started = (await a.invoke("operate_start", { service_url: "https://service.test" })) as {
      session_id: string;
    };
    await a.close();
    expect(closed).toEqual([]);
    expect(authority.inventory().sessions).toBe(1);

    await expect(b.invoke("operate_observe", { session_id: started.session_id })).resolves.toEqual({
      name: "operate_observe",
    });

    vi.stubEnv("HOME", beelineHome.replace("7e52a91f", "8e52a91f"));
    await expect(
      other.invoke("operate_observe", { session_id: started.session_id }),
    ).rejects.toMatchObject({ code: "stale_lease" });

    await expect(b.invoke("operate_finish", { session_id: started.session_id })).resolves.toEqual({
      name: "operate_finish",
    });
    expect(closed).toEqual([started.session_id]);
  } finally {
    await Promise.all([a.close(), b.close(), other.close()]);
    await listener.close();
    await rm(root, { recursive: true, force: true });
  }
});
