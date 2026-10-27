// Connect a user: the browser sign-in that binds a new agent session to their
// Squire account. Initiate and poll are unauthenticated by design — the caller
// has no token yet, only the one-time setup code.

import { ApiCallError } from "./errors.js";

export interface InstallInitiateResponse {
  setup_code: string;
  /** Send the user here to sign in and confirm. */
  confirm_url: string;
  expires_at: string;
}

export async function installInitiate(
  apiBaseUrl: string,
  agentIdentity: string,
  // The Squire MCP binds its machine token here; apps pass null.
  machineToken: string | null = null,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<InstallInitiateResponse> {
  const res = await fetchImpl(`${apiBaseUrl}/v1/mcp/install/initiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_identity: agentIdentity,
      ...(machineToken !== null ? { machine_token: machineToken } : {}),
    }),
  });
  if (!res.ok)
    throw new ApiCallError(res.status, "install_initiate_failed", "install handshake failed");
  return (await res.json()) as InstallInitiateResponse;
}

export interface InstallStatusResponse {
  status: "pending" | "claimed" | "expired";
  /** Present once claimed: the account-bound session token. Store it server-side. */
  agent_session_token?: string;
  account_id?: string;
  install_preferences?: {
    registry_enabled?: boolean;
    consent_operator_inbox_otp?: boolean;
  };
}

export async function installPoll(
  apiBaseUrl: string,
  setupCode: string,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<InstallStatusResponse> {
  const res = await fetchImpl(
    `${apiBaseUrl}/v1/mcp/install/${encodeURIComponent(setupCode)}/status`,
  );
  // 200 + status === 'pending' | 'claimed'; 410 → expired (return shape rather than throw).
  if (res.status === 410) return { status: "expired" };
  if (!res.ok) throw new ApiCallError(res.status, "install_poll_failed", "install poll failed");
  return (await res.json()) as InstallStatusResponse;
}
