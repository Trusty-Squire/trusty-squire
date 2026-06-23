import type { OAuthProviderId } from "./oauth-providers.js";

export interface SignupOAuthBrowserPort {
  detectSessionProviders(): Promise<OAuthProviderId[]>;
}

export interface SignupOAuthMarkerStore {
  loggedInProviders(): OAuthProviderId[];
  markProviderLoggedIn(provider: OAuthProviderId): void;
  clearProviderLoggedIn(provider: OAuthProviderId): void;
}

// SignupOAuthFlow owns provider-session truth. The live browser cookie jar is
// authoritative; the marker store is only a fallback memo when probing fails.
export class SignupOAuthFlow {
  constructor(
    private readonly browser: SignupOAuthBrowserPort,
    private readonly markers: SignupOAuthMarkerStore,
  ) {}

  async effectiveLoggedInProviders(): Promise<OAuthProviderId[]> {
    const fromMarker = this.markers.loggedInProviders();
    try {
      const live = await this.browser.detectSessionProviders();
      for (const provider of live) {
        if (!fromMarker.includes(provider)) {
          this.markers.markProviderLoggedIn(provider);
        }
      }
      for (const provider of fromMarker) {
        if (!live.includes(provider)) {
          this.markers.clearProviderLoggedIn(provider);
        }
      }
      return live;
    } catch {
      return fromMarker;
    }
  }
}
