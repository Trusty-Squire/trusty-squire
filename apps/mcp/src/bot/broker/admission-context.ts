import { AsyncLocalStorage } from "node:async_hooks";
import type { BrokerAccount } from "./protocol.js";
interface Admission {
  sessionId: string;
  /**
   * The account this open acts as, when it named one. Physical custody needs
   * it (the profile is bound to one account) and it is the account the
   * handler's tools act as; a ceremony open names none, because enrollment
   * creates an account rather than acting as one.
   */
  account?: BrokerAccount;
}
const context = new AsyncLocalStorage<Admission>();
/** Carry the broker's own session id down into the handler so the browser
 * runtime can associate a browser with the admission that is still starting,
 * even if that start later fails and must be cleaned up. */
export function withBrokerAdmission<T>(
  admission: Admission,
  operation: () => Promise<T>,
): Promise<T> {
  return context.run(admission, operation);
}

export function brokerAdmissionId(): string | undefined {
  return context.getStore()?.sessionId;
}

/** The account the in-flight broker open named, if any. */
export function brokerAdmissionAccount(): BrokerAccount | undefined {
  return context.getStore()?.account;
}
