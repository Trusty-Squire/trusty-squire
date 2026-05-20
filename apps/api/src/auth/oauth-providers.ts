// OAuth provider definitions for human account login (Google + GitHub).
//
// Distinct from apps/mcp/src/bot/oauth-providers.ts — that one drives
// the bot's browser profile. This authenticates the Trusty Squire
// account holder: authorize URL, code exchange, identity fetch.

export type OAuthProviderId = "google" | "github";

export interface OAuthIdentity {
  provider: OAuthProviderId;
  provider_user_id: string;
  email: string;
  display_name: string;
}

interface ProviderEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
}

const ENDPOINTS: Record<OAuthProviderId, ProviderEndpoints> = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
  },
  github: {
    // GitHub Apps ignore `scope`; the user-to-server token's reach is
    // set by the app's configured permissions. Harmless to send.
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
  },
};

export function isOAuthProvider(value: string): value is OAuthProviderId {
  return value === "google" || value === "github";
}

// The provider authorize URL the browser is 302'd to.
export function buildAuthorizeUrl(input: {
  provider: OAuthProviderId;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const ep = ENDPOINTS[input.provider];
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: ep.scope,
    state: input.state,
  });
  return `${ep.authorizeUrl}?${params.toString()}`;
}

// Exchange the authorization code for an access token.
export async function exchangeCode(input: {
  provider: OAuthProviderId;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<string> {
  const res = await fetch(ENDPOINTS[input.provider].tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!res.ok) throw new Error(`token_exchange_failed_${res.status}`);
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new Error(`token_exchange_no_token${json.error ? `_${json.error}` : ""}`);
  }
  return json.access_token;
}

// Fetch the authenticated user's identity from the provider.
export async function fetchIdentity(
  provider: OAuthProviderId,
  accessToken: string,
): Promise<OAuthIdentity> {
  return provider === "google"
    ? fetchGoogleIdentity(accessToken)
    : fetchGitHubIdentity(accessToken);
}

async function fetchGoogleIdentity(token: string): Promise<OAuthIdentity> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`google_userinfo_failed_${res.status}`);
  const u = (await res.json()) as {
    sub?: string;
    email?: string;
    name?: string;
  };
  if (typeof u.sub !== "string" || typeof u.email !== "string") {
    throw new Error("google_userinfo_incomplete");
  }
  return {
    provider: "google",
    provider_user_id: u.sub,
    email: u.email.toLowerCase(),
    display_name: u.name ?? u.email,
  };
}

async function fetchGitHubIdentity(token: string): Promise<OAuthIdentity> {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    // GitHub rejects API requests without a User-Agent.
    "user-agent": "trusty-squire",
  };
  const userRes = await fetch("https://api.github.com/user", { headers });
  if (!userRes.ok) throw new Error(`github_user_failed_${userRes.status}`);
  const u = (await userRes.json()) as {
    id?: number;
    login?: string;
    name?: string;
    email?: string | null;
  };
  if (typeof u.id !== "number" || typeof u.login !== "string") {
    throw new Error("github_user_incomplete");
  }

  // The profile email is often private (null); fall back to the
  // verified-emails endpoint, which the Email-addresses permission
  // grants.
  let email = typeof u.email === "string" ? u.email : null;
  if (email === null) {
    const emailRes = await fetch("https://api.github.com/user/emails", { headers });
    if (emailRes.ok) {
      const emails = (await emailRes.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;
      const chosen =
        emails.find((e) => e.primary && e.verified) ??
        emails.find((e) => e.verified);
      if (chosen !== undefined) email = chosen.email;
    }
  }
  if (email === null) throw new Error("github_no_verified_email");

  return {
    provider: "github",
    provider_user_id: String(u.id),
    email: email.toLowerCase(),
    display_name: u.name ?? u.login,
  };
}
