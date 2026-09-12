import { AsyncLocalStorage } from "node:async_hooks";
import { siteResources } from "./scheduler.js";
interface Admission {
  sessionId: string;
  reserve: (resources: readonly string[]) => void;
}
const context = new AsyncLocalStorage<Admission>();
export function withBrokerAdmission<T>(
  admission: Admission,
  operation: () => Promise<T>,
): Promise<T> {
  return context.run(admission, operation);
}
/** Reserve the startup service site before
 * even acquiring a page, so legacy recipe starts cannot bypass site custody. */
export function reserveBrokerAdmission(hosts: readonly string[]): string | undefined {
  const admission = context.getStore();
  admission?.reserve(siteResources(hosts));
  return admission?.sessionId;
}

export function brokerAdmissionId(): string | undefined {
  return context.getStore()?.sessionId;
}
