import { getDomain } from "tldts";

export class BrokerRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrokerRefusal";
  }
}

/** State domains, not tab URLs. Private suffixes isolate hosted tenants. */
export function siteResources(hosts: readonly string[]): string[] {
  return [
    ...new Set(
      hosts.map((value) => {
        const host = new URL(value.includes("://") ? value : `https://${value}`).hostname;
        return `site:${getDomain(host, { allowPrivateDomains: true }) ?? host}`;
      }),
    ),
  ].sort();
}

type Waiter = {
  owner: string;
  resources: string[];
  resolve: () => void;
  reject: (error: Error) => void;
  dispose: () => void;
};

/** One scheduler atomically reserves complete sets. Expansion never waits while
 * retaining a conflicting set: the caller gets a resumable refusal before action. */
export class ScopeScheduler {
  private readonly held = new Map<string, Set<string>>();
  private readonly queue: Waiter[] = [];

  constructor(private readonly maxQueued = 64) {}

  private conflicts(owner: string, resources: readonly string[]): boolean {
    return [...this.held].some(
      ([other, held]) => other !== owner && resources.some((resource) => held.has(resource)),
    );
  }

  reserve(owner: string, resources: readonly string[], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted)
      return Promise.reject(new BrokerRefusal("cancelled", "Reservation cancelled"));
    if (this.held.has(owner) || this.queue.some((entry) => entry.owner === owner)) {
      return Promise.reject(
        new BrokerRefusal("duplicate_reservation", "Owner already admitted or queued"),
      );
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new BrokerRefusal("queue_full", "Broker admission queue is full"));
    }
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1);
        waiter.dispose();
        reject(new BrokerRefusal("cancelled", "Reservation cancelled"));
        this.drain();
      };
      const waiter: Waiter = {
        owner,
        resources: [...new Set(resources)],
        resolve,
        reject,
        dispose: () => signal?.removeEventListener("abort", abort),
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(waiter);
      this.drain();
    });
  }

  expand(owner: string, resources: readonly string[]): void {
    const held = this.held.get(owner);
    if (held === undefined) throw new BrokerRefusal("stale_lease", "Reservation no longer exists");
    const added = resources.filter((resource) => !held.has(resource));
    if (
      this.conflicts(owner, added) ||
      this.queue.some((w) => w.resources.some((r) => added.includes(r)))
    ) {
      throw new BrokerRefusal("scope_conflict", "Scope is busy; action was not dispatched");
    }
    for (const resource of added) held.add(resource);
  }

  release(owner: string): void {
    this.held.delete(owner);
    this.drain();
  }

  private drain(): void {
    const earlier = new Set<string>();
    for (const waiter of [...this.queue]) {
      if (
        this.conflicts(waiter.owner, waiter.resources) ||
        waiter.resources.some((r) => earlier.has(r))
      ) {
        for (const resource of waiter.resources) earlier.add(resource);
        continue;
      }
      this.queue.splice(this.queue.indexOf(waiter), 1);
      this.held.set(waiter.owner, new Set(waiter.resources));
      waiter.dispose();
      waiter.resolve();
    }
  }
}
