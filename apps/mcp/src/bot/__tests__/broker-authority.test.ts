import { describe, expect, it } from "vitest";
import {
  BrokerAuthority,
  type BrokerSessionPort,
  type BrokerPrincipal,
} from "../broker/authority.js";
import { ScopeScheduler, siteResources } from "../broker/scheduler.js";
import { forwarderId } from "../broker/lineage.js";

const principal = (clientId: string): BrokerPrincipal => ({
  accountId: "account",
  agentId: clientId,
  clientId,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function port(
  targetId: string,
  invoke: BrokerSessionPort["invoke"] = async () => targetId,
): BrokerSessionPort {
  return { targetId, invoke, close: async () => true };
}

describe("broker authority", () => {
  it("runs three independent actors concurrently, preserving ownership and request deduplication", async () => {
    const broker = new BrokerAuthority("account", "cell");
    const entered: string[] = [];
    const release = deferred<void>();
    const owners = [principal("a"), principal("b"), principal("c")];
    const caps = await Promise.all(
      owners.map(
        async (owner) =>
          await broker.open(owner, siteResources([`${owner.clientId}.test`]), async () =>
            port(owner.clientId, async () => {
              entered.push(owner.clientId);
              await release.promise;
              return owner.clientId;
            }),
          ),
      ),
    );
    const calls = caps.map((cap, i) => broker.invoke(owners[i]!, cap, "one", "read", {}));
    await Promise.resolve();
    expect(entered.sort()).toEqual(["a", "b", "c"]);
    expect(broker.invoke(owners[0]!, caps[0]!, "one", "read", {})).toBe(calls[0]);
    expect(() => broker.invoke(owners[1]!, caps[0]!, "bad", "read", {})).toThrow(
      "owned live session",
    );
    expect(() =>
      broker.invoke(owners[0]!, { ...caps[0]!, browserEpoch: "old" }, "bad", "read", {}),
    ).toThrow("owned live session");
    release.resolve();
    expect(await Promise.all(calls)).toEqual(["a", "b", "c"]);
    await broker.disconnect(owners[0]!);
    expect(await broker.invoke(owners[1]!, caps[1]!, "two", "read", {})).toBe("b");
    await Promise.all(owners.slice(1).map(async (owner) => await broker.disconnect(owner)));
    expect(broker.inventory()).toEqual({ active: 0, quarantined: 0, admitting: 0 });
  });

  it("rejects concurrent forwarder reuse but restores a detached lineage", async () => {
    const broker = new BrokerAuthority("account", "cell");
    const first: BrokerPrincipal = {
      accountId: "account",
      agentId: "local-agent",
      forwarderId: "lineage-a",
      clientId: "first",
    };
    const second = { ...first, clientId: "second" };
    void broker.claimForwarder(first);
    const capability = await broker.open(first, ["site:a"], async () => port("a"));

    expect(() => broker.claimForwarder(second)).toThrow("Forwarder identity is already active");
    expect(() => broker.invoke(second, capability, "foreign", "read", {})).toThrow("not admitted");

    broker.detach(first);
    broker.releaseForwarder(first);
    void broker.claimForwarder(second);
    expect(broker.reclaim(second)).toEqual([capability]);
    await expect(broker.invoke(second, capability, "resumed", "read", {})).resolves.toBe("a");
  });

  it("fences lost-client mutations, reclaims within grace, and expires custody afterward", async () => {
    const broker = new BrokerAuthority("account", "cell");
    const first: BrokerPrincipal = {
      accountId: "account",
      agentId: "local-agent",
      forwarderId: "lineage-a",
      clientId: "first",
    };
    const second = { ...first, clientId: "second" };
    void broker.claimForwarder(first);
    let dispatches = 0;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const capability = await broker.open(first, ["site:a"], async () => ({
      ...port("a"),
      invoke: async (name) => {
        dispatches++;
        if (name === "holding") await firstEntered;
        return dispatches;
      },
    }));
    const holding = broker.invoke(first, capability, "holding", "holding", {});
    await Promise.resolve();
    const queued = broker.invoke(first, capability, "queued", "charge", {});
    const now = Date.now();
    broker.detach(first, now, 100);
    broker.releaseForwarder(first);
    expect(() => broker.invoke(first, capability, "lost", "charge", {})).toThrow("not admitted");

    void broker.claimForwarder(second);
    expect(broker.reclaim(second)).toEqual([capability]);
    releaseFirst();
    await holding;
    await expect(queued).rejects.toThrow("fenced before dispatch");
    await expect(broker.invoke(second, capability, "fresh", "read", {})).resolves.toBe(2);
    expect(dispatches).toBe(2);

    broker.detach(second, now + 1_000, 100);
    broker.releaseForwarder(second);
    await broker.expireDetached(now + 1_100);
    expect(broker.inventory()).toEqual({ active: 0, quarantined: 0, admitting: 0 });
  });

  it("releases a detached stuck actor only after expiry teardown closes it", async () => {
    const broker = new BrokerAuthority("account", "cell", 1, 1);
    const owner = principal("stuck");
    const entered = deferred<void>();
    const release = deferred<void>();
    const closeReasons: Array<"finish" | "disconnect" | "expiry" | undefined> = [];
    const capability = await broker.open(owner, ["site:a"], async () => ({
      ...port("stuck"),
      invoke: async () => {
        entered.resolve();
        await release.promise;
      },
      close: async (reason) => {
        closeReasons.push(reason);
        return true;
      },
    }));
    const running = broker.invoke(owner, capability, "stuck", "operate_pay", {});
    await entered.promise;
    const now = Date.now();
    broker.detach(owner, now, 0);
    await broker.expireDetached(now);

    expect(closeReasons).toEqual(["expiry"]);
    expect(broker.inventory()).toEqual({ active: 0, quarantined: 0, admitting: 0 });
    const replacement = await broker.open(principal("replacement"), ["site:a"], async () =>
      port("replacement"),
    );
    await broker.close(principal("replacement"), replacement);

    release.resolve();
    await running;
    expect(broker.inventory()).toEqual({ active: 0, quarantined: 0, admitting: 0 });
  });

  it("retains the session cap when expiry cannot close the physical session", async () => {
    const broker = new BrokerAuthority("account", "cell", 1, 1);
    const owner = principal("stuck");
    const entered = deferred<void>();
    const release = deferred<void>();
    const capability = await broker.open(owner, ["site:a"], async () => ({
      ...port("stuck"),
      invoke: async () => {
        entered.resolve();
        await release.promise;
      },
      close: async () => false,
    }));
    const running = broker.invoke(owner, capability, "stuck", "operate_pay", {});
    await entered.promise;

    const now = Date.now();
    broker.detach(owner, now, 0);
    await broker.expireDetached(now);

    expect(broker.inventory()).toEqual({ active: 0, quarantined: 1, admitting: 0 });
    await expect(
      broker.open(principal("replacement"), ["site:a"], async () => port("replacement")),
    ).rejects.toThrow("capacity");

    release.resolve();
    await running;
  });

  it("bounds a hung expiry close without releasing its physical session slot", async () => {
    const broker = new BrokerAuthority("account", "cell", 2, 5);
    const owner = principal("stuck");
    const entered = deferred<void>();
    const neverFinishes = new Promise<boolean>(() => undefined);
    let closeAttempts = 0;
    const capability = await broker.open(owner, ["site:a"], async () => ({
      ...port("stuck"),
      invoke: async () => {
        entered.resolve();
        await new Promise<void>(() => undefined);
      },
      close: async () => {
        closeAttempts += 1;
        return await neverFinishes;
      },
    }));
    void broker.invoke(owner, capability, "stuck", "operate_pay", {});
    await entered.promise;

    const now = Date.now();
    broker.detach(owner, now, 0);
    await Promise.race([
      broker.expireDetached(now),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("hung expiry close blocked reaping")), 100),
      ),
    ]);

    expect(closeAttempts).toBe(1);
    expect(broker.inventory()).toEqual({ active: 0, quarantined: 1, admitting: 0 });
    const replacementOwner = principal("replacement");
    const replacement = await broker.open(replacementOwner, ["site:b"], async () =>
      port("replacement"),
    );
    await expect(
      broker.open(principal("overflow"), ["site:c"], async () => port("overflow")),
    ).rejects.toThrow("capacity");

    broker.detach(replacementOwner, now + 1, 0);
    await broker.expireDetached(now + 1);
    expect(broker.inventory()).toEqual({ active: 0, quarantined: 1, admitting: 0 });
  });

  it("requires possession of a stable lineage credential to reclaim", async () => {
    const broker = new BrokerAuthority("account", "cell");
    const credential = "a".repeat(43);
    const owner: BrokerPrincipal = {
      accountId: "account",
      agentId: "local-agent",
      forwarderId: forwarderId(credential),
      clientId: "first",
    };
    const forged: BrokerPrincipal = {
      ...owner,
      forwarderId: forwarderId(owner.forwarderId!),
      clientId: "forged",
    };
    void broker.claimForwarder(owner);
    const capability = await broker.open(owner, ["site:a"], async () => port("a"));

    void broker.claimForwarder(forged);
    expect(broker.reclaim(forged)).toEqual([]);
    expect(() => broker.invoke(forged, capability, "foreign", "read", {})).toThrow(
      "owned live session",
    );

    broker.detach(owner);
    broker.releaseForwarder(owner);
    const restarted = { ...owner, clientId: "restarted" };
    void broker.claimForwarder(restarted);
    expect(broker.reclaim(restarted)).toEqual([capability]);
    await expect(broker.invoke(restarted, capability, "resumed", "read", {})).resolves.toBe("a");
  });

  it("retries failed admission cleanup without releasing site custody early", async () => {
    const broker = new BrokerAuthority("account", "cell");
    const owner = principal("failed");
    let cleanupProven = false;
    await expect(
      broker.open(
        owner,
        ["site:a"],
        async () => {
          throw new Error("probe failed after opening a tab");
        },
        async () => cleanupProven,
      ),
    ).rejects.toThrow("probe failed");
    expect(broker.inventory()).toEqual({ active: 0, quarantined: 1, admitting: 0 });
    let entered = false;
    const waiting = broker.open(principal("next"), ["site:a"], async () => {
      entered = true;
      return port("next");
    });
    await Promise.resolve();
    expect(entered).toBe(false);
    await broker.retryQuarantined();
    expect(entered).toBe(false);
    cleanupProven = true;
    await broker.retryQuarantined();
    const next = await waiting;
    expect(entered).toBe(true);
    await broker.close(principal("next"), next);
    expect(broker.inventory()).toEqual({ active: 0, quarantined: 0, admitting: 0 });
  });

  it("fences queued mutations before closing and drains an entered call", async () => {
    const broker = new BrokerAuthority("account", "cell");
    const entered = deferred<void>();
    const release = deferred<void>();
    let invokes = 0,
      closed = false;
    const owner = principal("a");
    const cap = await broker.open(owner, ["site:a"], async () => ({
      ...port("a"),
      invoke: async () => {
        invokes++;
        entered.resolve();
        await release.promise;
      },
      close: async () => {
        closed = true;
        return true;
      },
    }));
    const first = broker.invoke(owner, cap, "one", "charge", {});
    await entered.promise;
    const second = broker.invoke(owner, cap, "two", "charge", {});
    const rejected = expect(second).rejects.toThrow("fenced before dispatch");
    const closing = broker.close(owner, cap);
    expect(closed).toBe(false);
    release.resolve();
    await first;
    await rejected;
    await closing;
    expect(invokes).toBe(1);
    expect(closed).toBe(true);
  });

  it("retains site custody when tab cleanup cannot be proved", async () => {
    const broker = new BrokerAuthority("account", "cell");
    const cap = await broker.open(principal("a"), ["site:a"], async () => ({
      ...port("a"),
      close: async () => false,
    }));
    expect(await broker.close(principal("a"), cap)).toBe(false);
    let created = false;
    const pending = broker.open(principal("b"), ["site:a"], async () => {
      created = true;
      return port("b");
    });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await Promise.resolve();
    expect(created).toBe(false);
    await broker.disconnect(principal("b"));
    await rejected;
    expect(broker.inventory().quarantined).toBe(1);
  });

  it("closes a late admission after client loss without releasing another site's lease", async () => {
    const broker = new BrokerAuthority("account", "cell");
    const entered = deferred<void>(),
      release = deferred<void>();
    let closed = false;
    const opening = broker.open(principal("a"), ["site:a"], async () => {
      entered.resolve();
      await release.promise;
      return {
        ...port("a"),
        close: async () => {
          closed = true;
          return true;
        },
      };
    });
    const rejected = expect(opening).rejects.toThrow("disconnected during admission");
    await entered.promise;
    await broker.disconnect(principal("a"));
    release.resolve();
    await rejected;
    expect(closed).toBe(true);
    expect(broker.inventory()).toEqual({ active: 0, quarantined: 0, admitting: 0 });
  });

  it("serializes the OAuth lane while unrelated operations continue", async () => {
    const broker = new BrokerAuthority("account", "cell");
    const release = deferred<void>();
    const entered: string[] = [];
    const owners = [principal("a"), principal("b"), principal("c")];
    const caps = await Promise.all(
      owners.map(
        async (owner) =>
          await broker.open(owner, [owner.clientId], async () =>
            port(owner.clientId, async () => {
              entered.push(owner.clientId);
              if (owner.clientId === "a") await release.promise;
            }),
          ),
      ),
    );
    const a = broker.invoke(owners[0]!, caps[0]!, "a", "login", {}, [], "oauth");
    const b = broker.invoke(owners[1]!, caps[1]!, "b", "login", {}, [], "oauth");
    const c = broker.invoke(owners[2]!, caps[2]!, "c", "read", {});
    await c;
    expect(entered.sort()).toEqual(["a", "c"]);
    release.resolve();
    await Promise.all([a, b]);
    expect(entered).toContain("b");
  });
});

describe("scope scheduler", () => {
  it("groups registrable domains and separates hosted private suffix tenants", () => {
    expect(siteResources(["https://api.shop.co.jp", "www.shop.co.jp"])).toEqual([
      "site:shop.co.jp",
    ]);
    expect(siteResources(["a.github.io", "b.github.io"])).toEqual([
      "site:a.github.io",
      "site:b.github.io",
    ]);
  });
  it("reserves multi-domain workflows atomically and refuses conflicting expansions", async () => {
    const scheduler = new ScopeScheduler();
    await scheduler.reserve("a", ["a"]);
    let entered = false;
    const b = scheduler.reserve("b", ["a", "b"]).then(() => {
      entered = true;
    });
    await scheduler.reserve("c", ["c"]);
    expect(() => scheduler.expand("c", ["b"])).toThrow("Scope is busy");
    expect(entered).toBe(false);
    scheduler.release("a");
    await b;
    expect(entered).toBe(true);
  });
});
