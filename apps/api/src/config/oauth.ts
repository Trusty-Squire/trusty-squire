// OAuth login configuration for the API.
//
// Real Google + GitHub OAuth. Client IDs/secrets come from env only
// (apps/api/.env in dev, Fly secrets in prod) — never hardcoded.
// A provider with missing credentials is reported `null`; its routes
// then 503 rather than half-working.

import type { OAuthProviderId } from "../auth/oauth-providers.js";

export interface OAuthProviderCreds {
  clientId: string;
  clientSecret: string;
}

export interface OAuthConfig {
  google: OAuthProviderCreds | null;
  github: OAuthProviderCreds | null;
  // Origin the provider redirects back to; the callback path is
  // appended. The browser-facing API origin.
  callbackBaseUrl: string;
  // Where the browser lands after a successful login.
  appBaseUrl: string;
}

export function loadOAuthConfig(): OAuthConfig {
  const prod = process.env.NODE_ENV === "production";
  return {
    google: readCreds("GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"),
    github: readCreds("GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"),
    callbackBaseUrl:
      process.env.OAUTH_CALLBACK_BASE_URL ??
      (prod ? "https://trustysquire.ai" : "http://localhost:3000"),
    appBaseUrl:
      process.env.APP_BASE_URL ??
      (prod ? "https://trustysquire.ai" : "http://localhost:3000"),
  };
}

export function credsFor(
  config: OAuthConfig,
  provider: OAuthProviderId,
): OAuthProviderCreds | null {
  return provider === "google" ? config.google : config.github;
}

function readCreds(idVar: string, secretVar: string): OAuthProviderCreds | null {
  const clientId = process.env[idVar];
  const clientSecret = process.env[secretVar];
  if (clientId === undefined || clientId.length === 0) return null;
  if (clientSecret === undefined || clientSecret.length === 0) return null;
  return { clientId, clientSecret };
}
