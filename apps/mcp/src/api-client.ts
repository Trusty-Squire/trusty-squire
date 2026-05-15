// HTTP client wrapping calls to apps/api + apps/registry-api.
//
// All methods return parsed JSON or throw a typed error. The client
// is the only thing the MCP tools touch — tests inject a mock to
// keep their behaviour deterministic without spinning up HTTP.

export class MissingSessionError extends Error {
  constructor() {
    super(
      "No active Trusty Squire session. Run `npx @trusty-squire/mcp install --target=<agent>` to pair this machine.",
    );
    this.name = "MissingSessionError";
  }
}

export class ApiCallError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiCallError";
  }
}

export interface ApiClientConfig {
  apiBaseUrl: string;
  registryBaseUrl: string;
  agentSessionToken: string;
  fetch?: typeof fetch;
  // Self-reported in headers so the API ledger can attribute actions.
  agentIdentity?: string;
}

export interface ProvisionInput {
  service: string;
  plan: string;
  project_name: string;
  category: string;
  cost_cents: number;
  recurrence: "one_time" | "monthly" | "yearly" | "none";
  idempotency_key?: string;
}

export interface RunSummary {
  id: string;
  state: string;
  service: string;
  plan: string;
  project_name: string;
  subscription_id: string | null;
  failure_reason: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface CreateRunResponse {
  run: { id: string; state: string };
  decision: "silent" | "needs_approval" | "reject";
  approval_url?: string;
  reasons?: string[];
  required_confidence?: "low" | "medium" | "high";
}

export interface CredentialResponse {
  value: string;
  reference: string;
  retrieved_at: string;
}

export interface DirectoryEntry {
  service: string;
  latest_version: string;
  display_name: string;
  category: string;
  homepage: string;
  description: string | null;
}

export interface UsageResponse {
  monthly: { spent_cents: number; budget_cents: number; remaining_cents: number };
  daily: { spent_cents: number; silent_max_cents: number };
  mandate_id: string;
}

export class ApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: ApiClientConfig) {
    this.fetchImpl = config.fetch ?? fetch;
  }

  // ── Runs / provision / approvals ───────────────────────────

  async createRun(input: ProvisionInput): Promise<CreateRunResponse> {
    return this.post<CreateRunResponse>("/v1/runs", input);
  }

  async getRun(runId: string): Promise<RunSummary> {
    return this.get<RunSummary>(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  // ── Credentials ───────────────────────────────────────────

  async getCredential(reference: string, purpose: string): Promise<CredentialResponse> {
    return this.get<CredentialResponse>(
      `/v1/credentials/${encodeURIComponent(reference)}?purpose=${encodeURIComponent(purpose)}`,
    );
  }

  // ── Subscriptions ─────────────────────────────────────────

  async listSubscriptions(): Promise<{ subscriptions: unknown[] }> {
    return this.get<{ subscriptions: unknown[] }>("/v1/subscriptions");
  }

  async cancelSubscription(id: string): Promise<unknown> {
    const res = await this.fetchImpl(
      `${this.config.apiBaseUrl}/v1/subscriptions/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: this.headers() },
    );
    return this.handleResponse(res, "DELETE", `/v1/subscriptions/${id}`);
  }

  // ── Usage ─────────────────────────────────────────────────

  async getUsage(): Promise<UsageResponse> {
    return this.get<UsageResponse>("/v1/usage");
  }

  // ── Service directory ─────────────────────────────────────

  async listServices(category?: string): Promise<{ adapters: DirectoryEntry[] }> {
    const url =
      category !== undefined
        ? `${this.config.registryBaseUrl}/adapters?category=${encodeURIComponent(category)}`
        : `${this.config.registryBaseUrl}/adapters`;
    const res = await this.fetchImpl(url, { method: "GET" });
    return (await this.handleResponse(res, "GET", url)) as { adapters: DirectoryEntry[] };
  }

  // ── Internal HTTP helpers ─────────────────────────────────

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.config.agentSessionToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (this.config.agentIdentity !== undefined) {
      h["X-Squire-Agent-Identity"] = this.config.agentIdentity;
    }
    return h;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
      method: "GET",
      headers: this.headers(),
    });
    return (await this.handleResponse(res, "GET", path)) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return (await this.handleResponse(res, "POST", path)) as T;
  }

  private async handleResponse(
    res: Response,
    method: string,
    path: string,
  ): Promise<unknown> {
    const body = await safeJson(res);
    if (!res.ok) {
      const code = isErrorBody(body) ? body.error : `http_${res.status}`;
      throw new ApiCallError(
        res.status,
        code,
        `${method} ${path} → ${res.status} ${code}`,
        body,
      );
    }
    return body;
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function isErrorBody(b: unknown): b is { error: string } {
  return (
    b !== null &&
    typeof b === "object" &&
    "error" in b &&
    typeof (b as { error: unknown }).error === "string"
  );
}

// Stand-alone pairing helpers — used by the install CLI. Don't need a
// session token (initiate + poll are unauthenticated by design).

export interface PairInitiateResponse {
  pair_token: string;
  pair_url: string;
  expires_at: string;
}

export async function pairInitiate(
  apiBaseUrl: string,
  agentIdentity: string,
  // Optional Tier-0 machine token. When supplied the eventual claim
  // links it to the new account so quota stops applying.
  machineToken: string | null = null,
  fetchImpl: typeof fetch = fetch,
): Promise<PairInitiateResponse> {
  const res = await fetchImpl(`${apiBaseUrl}/v1/mcp/pair/initiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_identity: agentIdentity,
      ...(machineToken !== null ? { machine_token: machineToken } : {}),
    }),
  });
  if (!res.ok) throw new ApiCallError(res.status, "pair_initiate_failed", "pairing failed");
  return (await res.json()) as PairInitiateResponse;
}

export interface PairStatusResponse {
  status: "pending" | "claimed" | "expired";
  agent_session_token?: string;
  account_id?: string;
}

export async function pairPoll(
  apiBaseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PairStatusResponse> {
  const res = await fetchImpl(
    `${apiBaseUrl}/v1/mcp/pair/${encodeURIComponent(token)}/status`,
  );
  // 200 + status === 'pending' | 'claimed'; 410 → expired (return shape rather than throw).
  if (res.status === 410) return { status: "expired" };
  if (!res.ok) throw new ApiCallError(res.status, "pair_poll_failed", "pairing poll failed");
  return (await res.json()) as PairStatusResponse;
}

// ── Tier 0 machine-token install ───────────────────────────

export interface MachineInstallResponse {
  machine_token: string;
  quota_limit: number;
  quota_used: number;
  tier: "anonymous" | "paired";
  message?: string;
}

// Shape of the optional asn block we send on install. Matches the
// `AsnInfo` returned by `@trusty-squire/universal-bot` but flattened
// to the wire fields the API actually persists.
export interface InstallAsnPayload {
  ip: string;
  asn: string | null;
  org: string | null;
  country: string | null;
  class: "residential" | "datacenter" | "unknown";
}

export async function issueMachineToken(
  apiBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
  asn?: InstallAsnPayload,
): Promise<MachineInstallResponse> {
  const init: RequestInit = { method: "POST" };
  if (asn !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify({ asn });
  }
  const res = await fetchImpl(`${apiBaseUrl}/v1/install`, init);
  if (!res.ok) throw new ApiCallError(res.status, "install_failed", "machine install failed");
  return (await res.json()) as MachineInstallResponse;
}

export interface MachineStatusResponse {
  tier: "anonymous" | "paired";
  quota_limit: number;
  quota_used: number;
  quota_remaining: number;
  over_quota: boolean;
  paired_account_id: string | null;
  created_at: string;
  last_used_at: string | null;
}

export async function getMachineStatus(
  apiBaseUrl: string,
  machineToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MachineStatusResponse> {
  const res = await fetchImpl(`${apiBaseUrl}/v1/install/status`, {
    headers: { "x-machine-token": machineToken },
  });
  if (!res.ok) throw new ApiCallError(res.status, "status_failed", "machine status failed");
  return (await res.json()) as MachineStatusResponse;
}
