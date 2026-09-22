import type { BrowserController } from "../browser.js";

/** Installed only by the browser-owning broker entrypoint, never by MCP
 * clients. Lifecycle keeps the existing drain/audit/cleanup transaction. */
export interface BrokerBrowserCustody {
  /** `accountId` is the account the acquiring call named, when it named one;
   * a ceremony open names none and touches no binding. */
  acquire(
    options: {
      profileDir?: string;
      proxyUrl?: string;
    },
    accountId?: string,
  ): Promise<{ browser: BrowserController; profileDir: string }>;
  /** The proxy the shared browser is currently live (or launching) under,
   * or undefined when none is live or the browser runs bare. Optional: only
   * the real browser-owning broker provides it. */
  liveProxyUrl?(): string | undefined;
  cleanupAdmission(sessionId: string): Promise<boolean>;
  orphanAdmission(sessionId: string): Promise<void>;
  orphan(browser: BrowserController): Promise<void>;
  release(browser: BrowserController, beforeRelease?: () => Promise<void>): Promise<void>;
}
let custody: BrokerBrowserCustody | undefined;
export function installBrokerBrowserCustody(value: BrokerBrowserCustody): void {
  if (custody !== undefined) throw new Error("Broker browser custody is already installed");
  custody = value;
}
export function brokerBrowserCustody(): BrokerBrowserCustody | undefined {
  return custody;
}
