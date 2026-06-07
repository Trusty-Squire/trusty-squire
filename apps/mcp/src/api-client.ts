// HTTP client wrapping calls to apps/api + apps/registry.
//
// All methods return parsed JSON or throw a typed error. The client
// is the only thing the MCP tools touch — tests inject a mock to
// keep their behaviour deterministic without spinning up HTTP.

export class MissingSessionError extends Error {
  constructor() {
    super(
      "No active Trusty Squire session. Run `npx @trusty-squire/mcp connect --target=<agent>` to set up this machine.",
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
  // Account identifier — sent as `x-account-id` to the registry,
  // which uses it for scoping (extract-failure snapshots, skill
  // uploads, etc.). Optional because dev/test MCPs may not yet have
  // a paired account; the registry falls back to "anonymous"
  // when this header is missing.
  accountId?: string;
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

// Metadata for one vault credential — no secret value. The agent lists
// these to discover what keys exist; the raw value is never returned —
// the agent spends a key via use_credential (server-side write-only sink).
export interface VaultCredentialSummary {
  id: string;
  reference: string;
  service: string | null;
  label: string;
  field_names: string[];
  key_name: string | null;
  type: string | null;
  allowed_hosts: string[];
  created_at: string;
  last_retrieved_at: string | null;
  retrieval_count: number;
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

  // Metadata list of every credential in the account's vault — no
  // secret values. The discovery half of the credential loop.
  async listCredentials(): Promise<{ credentials: VaultCredentialSummary[] }> {
    return this.get<{ credentials: VaultCredentialSummary[] }>(
      "/v1/vault/credentials",
    );
  }

  // ── store: upsert (create or overwrite by service+label) ──

  async storeCredential(input: {
    service: string;
    label?: string;
    value?: string;
    fields?: Record<string, string>;
    env_var_suggestion?: string;
    type?: string;
  }): Promise<{
    reference: string;
    service: string;
    label: string;
    field_names: string[];
    allowed_hosts: string[];
    created_at: string;
    updated: boolean;
  }> {
    return this.post("/v1/vault/credentials", input);
  }

  // ── use_credential: write-only-sink proxy ─────────────────

  async useCredential(input: {
    reference?: string;
    service?: string;
    http: { method: string; url: string; headers?: Record<string, string>; body?: string; query?: Record<string, string> };
  }): Promise<{ response: { status: number; headers: Record<string, string>; body: string; truncated: boolean } }> {
    return this.post("/v1/vault/use", input);
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

  // ── Extract-failure diagnostics ───────────────────────────

  // Upload a DOM + screenshot snapshot from a universal-bot run
  // where extractCredentials() returned null. Lives on the
  // registry (not apps/api) because the diagnostic data is
  // operator-facing, not a hot-path workflow. Best-effort: failures
  // here MUST NOT abort the signup. Caller wraps in try/catch.
  async uploadExtractFailure(input: {
    service: string;
    mcp_version: string;
    url: string;
    title: string;
    step_label: string;
    extract_reason: string;
    candidates: ReadonlyArray<string>;
    html: string;
    screenshot_jpeg_base64?: string;
  }): Promise<{ id: string }> {
    const url = `${this.config.registryBaseUrl}/v1/extract-failures`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });
    return (await this.handleResponse(res, "POST", "/v1/extract-failures")) as { id: string };
  }

  // List this account's recent extract-failure snapshots. Returns
  // metadata only — no HTML, no screenshot bytes. Call
  // getExtractFailure(id) to fetch the body of a specific snapshot.
  async listExtractFailures(limit = 20): Promise<{
    snapshots: Array<{
      id: string;
      service: string;
      mcp_version: string;
      uploaded_at: string;
      expires_at: string;
      url: string;
      title: string;
      step_label: string;
      extract_reason: string;
      html_bytes: number;
      screenshot_bytes: number;
    }>;
  }> {
    const url = `${this.config.registryBaseUrl}/v1/extract-failures?limit=${encodeURIComponent(String(limit))}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers(),
    });
    return (await this.handleResponse(res, "GET", "/v1/extract-failures")) as {
      snapshots: Array<{
        id: string;
        service: string;
        mcp_version: string;
        uploaded_at: string;
        expires_at: string;
        url: string;
        title: string;
        step_label: string;
        extract_reason: string;
        html_bytes: number;
        screenshot_bytes: number;
      }>;
    };
  }

  // Fetch the full body of one snapshot: decompressed HTML + base64
  // JPEG screenshot, plus all metadata. Used by the diagnostic MCP
  // tool so a coding agent can pull the DOM into its context window
  // and write a targeted fix in the same conversation.
  async getExtractFailure(id: string): Promise<{
    id: string;
    service: string;
    mcp_version: string;
    uploaded_at: string;
    expires_at: string;
    url: string;
    title: string;
    step_label: string;
    extract_reason: string;
    candidates: ReadonlyArray<string>;
    html: string;
    html_bytes: number;
    screenshot_jpeg_base64: string | null;
    screenshot_bytes: number;
  }> {
    const url = `${this.config.registryBaseUrl}/v1/extract-failures/${encodeURIComponent(id)}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers(),
    });
    return (await this.handleResponse(res, "GET", `/v1/extract-failures/${id}`)) as {
      id: string;
      service: string;
      mcp_version: string;
      uploaded_at: string;
      expires_at: string;
      url: string;
      title: string;
      step_label: string;
      extract_reason: string;
      candidates: ReadonlyArray<string>;
      html: string;
      html_bytes: number;
      screenshot_jpeg_base64: string | null;
      screenshot_bytes: number;
    };
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
    // The registry scopes its reads to `x-account-id`. Main API
    // ignores unknown headers, so it's safe to always send.
    if (this.config.accountId !== undefined) {
      h["x-account-id"] = this.config.accountId;
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

// Stand-alone install-claim helpers — used by the install CLI to run
// the browser confirm step. Initiate + poll are unauthenticated by
// design: the CLI has no credentials yet, only the one-time setup_code.

export interface InstallInitiateResponse {
  setup_code: string;
  confirm_url: string;
  expires_at: string;
}

export async function installInitiate(
  apiBaseUrl: string,
  agentIdentity: string,
  // The machine token issued seconds earlier via /v1/install — bound
  // to the account at claim time so quota tracks against the account.
  machineToken: string | null = null,
  fetchImpl: typeof fetch = fetch,
): Promise<InstallInitiateResponse> {
  const res = await fetchImpl(`${apiBaseUrl}/v1/mcp/install/initiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_identity: agentIdentity,
      ...(machineToken !== null ? { machine_token: machineToken } : {}),
    }),
  });
  if (!res.ok) throw new ApiCallError(res.status, "install_initiate_failed", "install handshake failed");
  return (await res.json()) as InstallInitiateResponse;
}

export interface InstallStatusResponse {
  status: "pending" | "claimed" | "expired";
  agent_session_token?: string;
  account_id?: string;
}

export async function installPoll(
  apiBaseUrl: string,
  setupCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InstallStatusResponse> {
  const res = await fetchImpl(
    `${apiBaseUrl}/v1/mcp/install/${encodeURIComponent(setupCode)}/status`,
  );
  // 200 + status === 'pending' | 'claimed'; 410 → expired (return shape rather than throw).
  if (res.status === 410) return { status: "expired" };
  if (!res.ok) throw new ApiCallError(res.status, "install_poll_failed", "install poll failed");
  return (await res.json()) as InstallStatusResponse;
}

// ── Machine-token issuance ─────────────────────────────────
// The MCP install CLI calls /v1/install to mint a machine_token for
// the bot's LLM-proxy + inbox-alias use. The machine_token is not the
// user's auth — it's a bot-internal credential — and it gets bound to
// the user's account immediately after via the install-claim flow.

export interface MachineInstallResponse {
  machine_token: string;
  quota_limit: number;
  quota_used: number;
  message?: string;
}

// Shape of the optional asn block we send on install. Matches the
// `AsnInfo` returned by the bundled bot (`src/bot/asn.ts`) but flattened
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
  quota_limit: number;
  quota_used: number;
  quota_remaining: number;
  over_quota: boolean;
  account_id: string | null;
  created_at: string;
  last_used_at: string | null;
}

// G15: shorten the headless install's cloudflared tunnel URL to a
// `trustysquire.ai/g/<slug>` redirect. The API stores the long URL
// (fragment included) with a 15-min TTL; the web app's /g/[slug]
// route resolves it and 302s the browser to the long URL — preserving
// the password fragment.
//
// Failure path: any error returns the original URL unchanged. The
// caller prints whatever it gets back; users on a flaky network just
// see the original cloudflared URL, which still works.
export async function shortenVncUrl(
  apiBaseUrl: string,
  longUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  try {
    const res = await fetchImpl(`${apiBaseUrl}/v1/short`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: longUrl }),
    });
    if (!res.ok) return longUrl;
    const body = (await res.json()) as { short_url?: unknown };
    if (typeof body.short_url !== "string") return longUrl;
    return body.short_url;
  } catch {
    return longUrl;
  }
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
