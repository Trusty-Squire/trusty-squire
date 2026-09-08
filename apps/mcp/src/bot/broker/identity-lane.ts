import { randomUUID } from "node:crypto";
import { ScopeScheduler } from "./scheduler.js";
const scheduler = new ScopeScheduler();
/** Probe + OAuth coordination shares one broker-process resource. */
export async function withBrokerIdentityLane<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const owner = randomUUID();
  await scheduler.reserve(owner, ["identity"], signal);
  try {
    return await operation();
  } finally {
    scheduler.release(owner);
  }
}
