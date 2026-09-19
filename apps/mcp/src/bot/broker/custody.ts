import type { BrowserController } from "../browser.js";
import type { OAuthProviderId } from "../oauth-providers.js";

export interface BrokerIdentityProbe {
  providers: OAuthProviderId[];
  userEmail: string | null;
  observedAt: number;
}

/** Installed only by the browser-owning broker entrypoint, never by MCP
 * clients. Lifecycle keeps the existing drain/audit/cleanup transaction. */
export interface BrokerBrowserCustody {
  acquire(options: {
    profileDir?: string;
    proxyUrl?: string;
  }): Promise<{ browser: BrowserController; profileDir: string }>;
  /** The proxy the shared browser is currently live (or launching) under,
   * or undefined when none is live or the browser runs bare. Optional: only
   * the real browser-owning broker provides it. */
  liveProxyUrl?(): string | undefined;
  /** A short-lived observation of the identity in the broker's physical
   * profile. The cache belongs to the physical browser, not to any one tab. */
  recentIdentityProbe?(maximumAgeMs: number): BrokerIdentityProbe | undefined;
  rememberIdentityProbe?(probe: BrokerIdentityProbe): void;
  invalidateIdentityProbe?(): void;
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
