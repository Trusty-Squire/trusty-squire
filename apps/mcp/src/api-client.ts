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
  auth_strategy: string | null;
  signin_url: string | null;
  login_hosts: string[];
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

export interface PaymentApproval {
  id: string;
  status: "pending" | "approved" | "expired";
  merchant: string;
  amount_cents: number;
  currency: string;
  nonce: string;
  card_ref: string;
  operator_pubkey: string;
  jws: string | null;
  sealed_card: string | null;
  expires_at: string;
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

  async createPaymentApproval(input: {
    merchant: string;
    amount_cents: number;
    currency: string;
    card_ref: string;
    operator_pubkey: string;
  }): Promise<{ id: string; nonce: string; expires_at: string }> {
    return this.post("/v1/pay/approvals", input);
  }

  async getPaymentApproval(id: string): Promise<PaymentApproval> {
    return this.get(`/v1/pay/approvals/${encodeURIComponent(id)}`);
  }

  async auditPayment(input: {
    merchant: string;
    amount_cents: number;
    currency: string;
    last4: string;
    status: string;
    mandate_id?: string;
  }): Promise<{ id: string }> {
    return this.post("/v1/vault/payments/audit", {
      merchant: input.merchant,
      amountCents: input.amount_cents,
      currency: input.currency,
      last4: input.last4,
      status: input.status,
      ...(input.mandate_id !== undefined ? { mandateId: input.mandate_id } : {}),
    });
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
    auth_shape?: string;
    auth_strategy?: "api_key" | "username_password";
    signin_url?: string;
    login_hosts?: string[];
    observed_hosts?: string[];
  }): Promise<{
    reference: string;
    service: string;
    label: string;
    field_names: string[];
    auth_strategy: string | null;
    signin_url: string | null;
    login_hosts: string[];
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

  async browserFillCredential(input: {
    reference?: string;
    service?: string;
    current_host: string;
    fields: string[];
    encrypted_response_public_key: string;
  }): Promise<{ reference: string; encrypted_fields: Record<string, string> }> {
    return this.post("/v1/vault/browser-fill", input);
  }

  // ── Egress grants: a deployed app uses a vaulted credential via the proxy ──

  async grantAppAccess(input: {
    reference?: string;
    service?: string;
    rate_limit_per_hour?: number;
    spend_cap_usd?: number;
  }): Promise<{
    grant_id: string;
    base_url: string;
    token: string;
    rate_limit_per_hour: number;
    spend_cap_usd: number | null;
    hint: string;
  }> {
    return this.post("/v1/egress/grants", input);
  }

  async listEgressGrants(): Promise<{
    grants: Array<{
      grant_id: string;
      credential_ref: string;
      rate_limit_per_hour: number;
      spend_cap_usd: number | null;
      created_at: string;
      revoked_at: string | null;
    }>;
  }> {
    return this.get("/v1/egress/grants");
  }

  async revokeEgressGrant(grantId: string): Promise<{ revoked: boolean; grant_id: string }> {
    const res = await this.fetchImpl(
      `${this.config.apiBaseUrl}/v1/egress/grants/${encodeURIComponent(grantId)}`,
      { method: "DELETE", headers: this.headers() },
    );
    return this.handleResponse(res, "DELETE", `/v1/egress/grants/${grantId}`) as Promise<{
      revoked: boolean;
      grant_id: string;
    }>;
  }

  // ── Audit ledger: who-touched-my-keys (no secret values) ──────────

  async listAudit(input: {
    limit?: number;
    before?: string;
    type?: string;
    reference?: string;
  }): Promise<{
    events: Array<{ id: string; type: string; emitted_at: string } & Record<string, unknown>>;
    next_before: string | null;
  }> {
    const q = new URLSearchParams();
    if (input.limit !== undefined) q.set("limit", String(input.limit));
    if (input.before !== undefined) q.set("before", input.before);
    if (input.type !== undefined) q.set("type", input.type);
    if (input.reference !== undefined) q.set("reference", input.reference);
    const qs = q.toString();
    return this.get(`/v1/vault/audit${qs.length > 0 ? `?${qs}` : ""}`);
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
  install_preferences?: {
    registry_enabled?: boolean;
    consent_operator_inbox_otp?: boolean;
    proxy_url?: string;
  };
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
// the bot's operator inbox-OTP use. The machine_token is not the
// user's auth — it's a bot-internal credential — and it gets bound to
// the user's account immediately after via the install-claim flow.

export interface MachineInstallResponse {
  machine_token: string;
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
  timeoutMs = 30000,
): Promise<MachineInstallResponse> {
  // Bound the request. With no timeout, a cold-starting API (Fly auto-stop) or a
  // stalled mobile connection hung `connect` indefinitely at "Issuing machine
  // token" — 30s is generous enough for a cold start but fails LOUDLY (retryable)
  // instead of hanging forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const init: RequestInit = { method: "POST", signal: controller.signal };
  if (asn !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify({ asn });
  }
  try {
    const res = await fetchImpl(`${apiBaseUrl}/v1/install`, init);
    if (!res.ok) throw new ApiCallError(res.status, "install_failed", "machine install failed");
    return (await res.json()) as MachineInstallResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ApiCallError(
        0,
        "install_timeout",
        `machine install timed out after ${timeoutMs}ms — the API may be waking up; re-run connect`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
