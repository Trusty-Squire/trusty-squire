import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The account a profile's browser is enrolled to. The broker runtime writes
 * this record on its first acquire and refuses a profile bound to another
 * account; reclaim reads it to prove a resident broker is OURS before
 * signalling it. One path, one shape, one owner. */
export function brokerAccountBindingPath(profileDir: string): string {
  return join(profileDir, "trusty-squire-broker-account.json");
}

export interface BrokerAccountBinding {
  version: number;
  accountId: string;
}

/** The bound account id, or null when the profile carries no readable
 * binding. Callers that act destructively must treat null as "not provably
 * ours" and stand down. */
export async function readBrokerAccountBinding(profileDir: string): Promise<string | null> {
  let binding: unknown;
  try {
    binding = JSON.parse(await readFile(brokerAccountBindingPath(profileDir), "utf8"));
  } catch {
    return null;
  }
  if (binding === null || typeof binding !== "object") return null;
  const { version, accountId } = binding as Partial<BrokerAccountBinding>;
  if (version !== 1 || typeof accountId !== "string" || accountId.length === 0) return null;
  return accountId;
}
