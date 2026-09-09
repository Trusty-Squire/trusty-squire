import type { BrowserController } from "../browser.js";

/** Installed only by the browser-owning broker entrypoint, never by MCP
 * clients. Lifecycle keeps the existing drain/audit/cleanup transaction. */
export interface BrokerBrowserCustody {
  acquire(options: {
    profileDir?: string;
    proxyUrl?: string;
  }): Promise<{ browser: BrowserController; profileDir: string }>;
  cleanupAdmission(sessionId: string): Promise<boolean>;
  orphanAdmission(sessionId: string): Promise<void>;
  orphan(browser: BrowserController): Promise<void>;
  release(browser: BrowserController): Promise<void>;
  identity<T>(operation: () => Promise<T>): Promise<T>;
}
let custody: BrokerBrowserCustody | undefined;
export function installBrokerBrowserCustody(value: BrokerBrowserCustody): void {
  if (custody !== undefined) throw new Error("Broker browser custody is already installed");
  custody = value;
}
export function brokerBrowserCustody(): BrokerBrowserCustody | undefined {
  return custody;
}
