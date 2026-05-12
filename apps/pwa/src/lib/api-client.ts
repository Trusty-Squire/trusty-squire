// Typed fetch wrapper around apps/api.
//
// Session is carried by the squire_session cookie (HttpOnly, set by
// /v1/auth/login and /v1/accounts). We send `credentials: 'include'`
// on every request so the browser ships the cookie.
//
// Default base is the empty string → relative URLs that hit the PWA's
// own origin. Next.js rewrites in next.config.mjs proxy /v1/* to the
// API. This means same-origin requests from the browser's perspective,
// so no CORS preflights and no cross-domain cookie attributes needed.
// Override with NEXT_PUBLIC_API_BASE only if you're hitting the API
// from a different origin (e.g. Playwright's stub-API mount).

import type { Bundle } from "./vouchflow.js";

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE ?? "";

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : null,
  });
  const text = await res.text();
  const parsed: unknown = text.length > 0 ? safeJsonParse(text) : null;
  if (!res.ok) {
    throw new ApiClientError(`${method} ${path} failed: ${res.status}`, res.status, parsed);
  }
  return parsed as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface AccountResponse {
  account: { id: string; email: string; display_name: string };
  session: { id: string; absolute_expires_at: string };
}

export interface AccountWithMandateResponse extends AccountResponse {
  mandate: { id: string; not_before: string; not_after: string };
}

export interface MandateResponse {
  mandate: { id: string; version: number; expires_at: string };
}

export interface SubscriptionRow {
  id: string;
  service_name: string;
  service_reference: string;
  monthly_cost_cents: number | null;
  status: "active" | "cancelled" | "pending";
  started_at: string;
}

export interface LedgerRow {
  id: string;
  ts: string;
  kind: string;
  summary: string;
  amount_cents: number | null;
}

export interface UsageResponse {
  window_start: string;
  window_end: string;
  total_spend_cents: number;
  budget_cents: number;
  by_category: Array<{ category: string; spend_cents: number }>;
}

export interface RunRow {
  id: string;
  service_name: string;
  state: string;
  started_at: string;
}

export const api = {
  registerAccount: (bundle: Bundle): Promise<AccountResponse> =>
    request<AccountResponse>("POST", "/v1/accounts", { bundle }),

  // Single-ceremony onboarding: creates the account AND installs the
  // first mandate from one signed bundle (context:
  // account_register_with_mandate).
  registerAccountWithMandate: (bundle: Bundle): Promise<AccountWithMandateResponse> =>
    request<AccountWithMandateResponse>("POST", "/v1/accounts", { bundle }),

  login: (bundle: Bundle): Promise<AccountResponse> =>
    request<AccountResponse>("POST", "/v1/auth/login", { bundle }),

  logout: (): Promise<{ ok: true }> => request("POST", "/v1/auth/logout"),

  createMandate: (bundle: Bundle): Promise<MandateResponse> =>
    request<MandateResponse>("POST", "/v1/mandates", { bundle }),

  activeMandate: (): Promise<{ mandate: { id: string; version: number; expires_at: string; policy: unknown } | null }> =>
    request("GET", "/v1/mandates/active"),

  subscriptions: (): Promise<{ subscriptions: SubscriptionRow[] }> =>
    request("GET", "/v1/subscriptions"),

  cancelSubscription: (id: string, bundle: Bundle): Promise<{ ok: true }> =>
    request("DELETE", `/v1/subscriptions/${id}`, { bundle }),

  ledger: (): Promise<{ entries: LedgerRow[] }> => request("GET", "/v1/ledger"),

  usage: (): Promise<UsageResponse> => request("GET", "/v1/usage"),

  claimPair: (token: string, bundle: Bundle, agent_identity: string, agent_version: string | null): Promise<{ ok: true; agent_session_id: string; account_id: string }> =>
    request("POST", `/v1/mcp/pair/${encodeURIComponent(token)}/claim`, {
      bundle,
      agent_identity,
      ...(agent_version !== null ? { agent_version } : {}),
    }),
};

export { BASE_URL as apiBaseUrl };
