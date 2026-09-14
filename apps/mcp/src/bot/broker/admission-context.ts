import { AsyncLocalStorage } from "node:async_hooks";
interface Admission {
  sessionId: string;
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
