import type { OAuthProviderId } from "./oauth-providers.js";

export function classifyOAuthProviderDestination(
  rawUrl: string,
  productUrl: string,
): OAuthProviderId | "other" | null {
  let url: URL;
  try {
    url = new URL(rawUrl, productUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const signal = `${host}${url.pathname}${url.search}`;
  if (
    /(^|\.)google\.com$/i.test(host) ||
    /(?:provider|connection|oauth|sso|auth)[=/_-]google\b/i.test(signal)
  ) {
    return "google";
  }
  if (
    /(^|\.)(?:github\.com|microsoftonline\.com|live\.com|appleid\.apple\.com)$/i.test(host) ||
    /(?:provider|connection|oauth|sso|auth)[=/_-](?:github|microsoft|apple|okta|auth0)\b/i.test(
      signal,
    )
  ) {
    return host === "github.com" || host.endsWith(".github.com") ? "github" : "other";
  }
  return null;
}
