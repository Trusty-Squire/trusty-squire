// HTTP client for the Trusty Squire API.
//
// Every method returns parsed JSON or throws ApiCallError. This is the one
// client: the Squire MCP server builds on it, and apps use it through the
// `Squire` class.
//
// No method here returns a secret value or card data. Keys are spent
// server-side (`useCredential`), app access is a revocable grant
// (`grantAppAccess`), and risky actions come back as a pending approval that
// only the user's passkey can settle.

import { ApiCallError } from "./errors.js";
import type { ApprovalWire } from "./approval.js";

export const DEFAULT_API_BASE_URL = "https://trusty-squire-api.fly.dev";

export interface ApiClientConfig {
  apiBaseUrl: string;
  /** The account-bound agent session token. Keep it on your server. */
  agentSessionToken: string;
  fetch?: typeof fetch;
  /** Self-reported in a header so the audit log can name who acted. */
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

/** One vaulted credential's metadata. The value is never returned. */
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
  /** True when the key is past the rotation-stale age. */
  stale?: boolean;
}

export interface CredentialSelector {
  reference?: string;
  service?: string;
  name?: string;
}

export interface HostListEdit {
  mode: "add" | "remove" | "replace";
  hosts: string[];
}

export interface CredentialMetadataChanges {
  label?: string;
  allowed_hosts?: HostListEdit;
  login_hosts?: HostListEdit;
}

export interface CredentialMutationApproval {
  approval_id: string;
  approval_url: string;
  status: "pending" | "approved" | "failed" | "denied" | "expired";
  operation: "edit" | "delete";
  credential: { reference: string; service: string | null; name: string };
  before: {
    label: string;
    allowed_hosts: string[];
    login_hosts: string[];
    auth_strategy: string | null;
  };
  after: {
    label: string;
    allowed_hosts: string[];
    login_hosts: string[];
    auth_strategy: string | null;
  } | null;
  expires_at: string;
  error?: string;
  /** The normalized approval card (on create). */
  approval?: ApprovalWire;
}

/** edit_payment_card's approval: label/brand/last4 display metadata only, never card values. */
export interface CardMutationApproval {
  approval_id: string;
  approval_url: string;
  status: "pending" | "approved" | "failed" | "denied" | "expired";
  operation: "edit_card";
  card: { id: string; label: string; brand: string | null; last4: string | null };
  before: { label: string; brand: string | null; last4: string | null };
  after: { label: string; brand: string | null; last4: string | null } | null;
  expires_at: string;
  error?: string;
  approval?: ApprovalWire;
}

/** A reveal approval's status. It never carries the value. */
export interface CredentialFetchApproval {
  approval_id: string;
  approval_url: string;
  status: "pending" | "approved" | "consumed" | "denied" | "expired" | "failed";
  credential: { reference: string; service: string | null; name: string };
  field: string | null;
  field_names: string[];
  expires_at: string;
  error?: string;
  approval?: ApprovalWire;
}

export interface PaymentCardSummary {
  id: string;
  label: string;
  last4: string | null;
  brand?: string;
}

export interface UseCredentialInput extends CredentialSelector {
  http: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    query?: Record<string, string>;
  };
}

export interface UseCredentialResult {
  response: { status: number; headers: Record<string, string>; body: string; truncated: boolean };
}

export interface AppAccessGrant {
  grant_id: string;
  base_url: string;
  /** A revocable bearer token for your backend. Not the vaulted key. */
  token: string;
  rate_limit_per_hour: number | null;
  spend_cap_usd: number | null;
  hint: string;
}

export interface AppAccessGrantSummary {
  grant_id: string;
  credential_ref: string;
  rate_limit_per_hour: number | null;
  spend_cap_usd: number | null;
  created_at: string;
  revoked_at: string | null;
}

export interface AuditPage {
  events: Array<{ id: string; type: string; emitted_at: string } & Record<string, unknown>>;
  next_before: string | null;
}

export interface AuditDailyPage {
  totals: Array<{
    day: string;
    reference: string;
    target_host: string;
    requester: string;
    grant_id: string;
    calls: number;
    status_breakdown: Record<string, number>;
    total_bytes: number;
    first_at: string;
    last_at: string;
  }>;
  next_before: string | null;
}

export interface ApprovalWebhookRegistration {
  url: string;
  /** Shown once. Store it with your server's secrets; registering again rotates it. */
  secret: string;
  created_at: string;
}

export class ApiClient {
  protected readonly fetchImpl: typeof fetch;
  private requestingAgent: string | undefined;

  constructor(protected readonly config: ApiClientConfig) {
    // Bound so a browser's window.fetch is never called with the client as `this`.
    this.fetchImpl = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  setRequestingAgent(name: string): void {
    const normalized = name.trim();
    this.requestingAgent = normalized.length > 0 ? normalized : "unknown-agent";
  }

  // ── Runs ───────────────────────────────────────────────────

  async createRun(input: ProvisionInput): Promise<CreateRunResponse> {
    return this.post<CreateRunResponse>("/v1/runs", input);
  }

  async getRun(runId: string): Promise<RunSummary> {
    return this.get<RunSummary>(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  // ── Vault metadata and write-only storage ──────────────────

  async listPaymentCards(): Promise<PaymentCardSummary[]> {
    const records =
      await this.get<
        Array<{ id: string; label: string; last4: string | null; brand?: string | null }>
      >("/v1/vault/e2e");
    // Copy display fields only; the stored record also holds the sealed card.
    return records.map(({ id, label, last4, brand }) => ({
      id,
      label,
      last4: last4 ?? null,
      ...(brand != null ? { brand } : {}),
    }));
  }

  async listCredentials(): Promise<{ credentials: VaultCredentialSummary[] }> {
    return this.get<{ credentials: VaultCredentialSummary[] }>("/v1/vault/credentials");
  }

  /** Create, or overwrite by service+label. The value goes in and never comes back. */
  async storeCredential(input: {
    write_id?: string;
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
    duplicate_of?: Array<{ service: string; label: string; reference: string }>;
    hint?: string;
  }> {
    return this.post("/v1/vault/credentials", input);
  }

  // ── Risky actions: each returns a pending approval ─────────

  async createCredentialMutationApproval(
    input: CredentialSelector & {
      operation: "edit" | "delete";
      changes?: CredentialMetadataChanges;
    },
  ): Promise<CredentialMutationApproval> {
    return this.post("/v1/vault/mutation-approvals", input);
  }

  async getCredentialMutationApproval(
    id: string,
    signal?: AbortSignal,
    waitMs?: number,
  ): Promise<CredentialMutationApproval> {
    const wait = waitMs === undefined ? "" : `?wait_for_decision=1&wait_ms=${waitMs}`;
    return this.get(`/v1/vault/mutation-approvals/${encodeURIComponent(id)}${wait}`, signal);
  }

  async createCardMutationApproval(input: {
    operation: "edit_card";
    card_id?: string;
    label?: string;
  }): Promise<CardMutationApproval> {
    return this.post("/v1/vault/card-mutation-approvals", input);
  }

  async getCardMutationApproval(
    id: string,
    signal?: AbortSignal,
    waitMs?: number,
  ): Promise<CardMutationApproval> {
    const wait = waitMs === undefined ? "" : `?wait_for_decision=1&wait_ms=${waitMs}`;
    return this.get(`/v1/vault/card-mutation-approvals/${encodeURIComponent(id)}${wait}`, signal);
  }

  async createCredentialFetchApproval(
    input: CredentialSelector & { field?: string; reason?: string },
  ): Promise<CredentialFetchApproval> {
    return this.post("/v1/vault/fetch-approvals", input);
  }

  /** A non-consuming status read: it can never deliver the value. */
  async getCredentialFetchApprovalStatus(
    id: string,
    signal?: AbortSignal,
    waitMs?: number,
  ): Promise<CredentialFetchApproval> {
    const wait = waitMs === undefined ? "" : `?wait_for_decision=1&wait_ms=${waitMs}`;
    return this.get(`/v1/vault/fetch-approvals/${encodeURIComponent(id)}/ceremony${wait}`, signal);
  }

  // ── Approvals of every kind ────────────────────────────────

  /** The approval card. With `waitMs`, holds up to 15s for a non-pending status. */
  async getApproval(
    id: string,
    waitMs?: number,
    signal?: AbortSignal,
  ): Promise<{ approval: ApprovalWire }> {
    const wait = waitMs === undefined ? "" : `?wait_for_decision=1&wait_ms=${Math.floor(waitMs)}`;
    return this.get(`/v1/approvals/${encodeURIComponent(id)}${wait}`, signal);
  }

  /** Refuse a pending approval from the host app. Approving needs the user's passkey. */
  async denyApproval(id: string): Promise<{ approval: ApprovalWire }> {
    return this.post(`/v1/approvals/${encodeURIComponent(id)}/deny`, {});
  }

  async registerApprovalWebhook(url: string): Promise<ApprovalWebhookRegistration> {
    return this.request("PUT", "/v1/approval-webhook", { url });
  }

  async getApprovalWebhook(): Promise<{ url: string; created_at: string }> {
    return this.get("/v1/approval-webhook");
  }

  async deleteApprovalWebhook(): Promise<void> {
    await this.request("DELETE", "/v1/approval-webhook");
  }

  // ── use_credential: the key is injected server-side ────────

  async useCredential(input: UseCredentialInput): Promise<UseCredentialResult> {
    return this.post("/v1/vault/use", input);
  }

  // ── App access: a revocable grant instead of the key ───────

  async grantAppAccess(input: {
    reference?: string;
    service?: string;
    rate_limit_per_hour?: number;
    spend_cap_usd?: number;
  }): Promise<AppAccessGrant> {
    return this.post("/v1/egress/grants", input);
  }

  async listEgressGrants(): Promise<{ grants: AppAccessGrantSummary[] }> {
    return this.get("/v1/egress/grants");
  }

  async revokeEgressGrant(grantId: string): Promise<{ revoked: boolean; grant_id: string }> {
    return this.request("DELETE", `/v1/egress/grants/${encodeURIComponent(grantId)}`);
  }

  // ── Audit log: who touched which key (no values) ───────────

  async listAudit(input: {
    limit?: number;
    before?: string;
    type?: string;
    reference?: string;
  }): Promise<AuditPage> {
    const q = new URLSearchParams();
    if (input.limit !== undefined) q.set("limit", String(input.limit));
    if (input.before !== undefined) q.set("before", input.before);
    if (input.type !== undefined) q.set("type", input.type);
    if (input.reference !== undefined) q.set("reference", input.reference);
    const qs = q.toString();
    return this.get(`/v1/vault/audit${qs.length > 0 ? `?${qs}` : ""}`);
  }

  async listAuditDaily(input: {
    limit?: number;
    before?: string;
    reference?: string;
  }): Promise<AuditDailyPage> {
    const q = new URLSearchParams();
    if (input.limit !== undefined) q.set("limit", String(input.limit));
    if (input.before !== undefined) q.set("before", input.before);
    if (input.reference !== undefined) q.set("reference", input.reference);
    return this.get(`/v1/vault/audit/daily?${q}`);
  }

  // ── HTTP helpers ───────────────────────────────────────────

  protected headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.config.agentSessionToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const agentIdentity = this.requestingAgent ?? this.config.agentIdentity;
    if (agentIdentity !== undefined) {
      h["X-Squire-Agent-Identity"] = agentIdentity;
    }
    return h;
  }

  protected async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
      method: "GET",
      headers: this.headers(),
      ...(signal !== undefined ? { signal } : {}),
    });
    return (await this.handleResponse(res, "GET", path)) as T;
  }

  protected async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    });
    return (await this.handleResponse(res, "POST", path)) as T;
  }

  protected async request<T>(method: "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return (await this.handleResponse(res, method, path)) as T;
  }

  protected async handleResponse(res: Response, method: string, path: string): Promise<unknown> {
    const body = await safeJson(res);
    if (!res.ok) {
      const code = isErrorBody(body) ? body.error : `http_${res.status}`;
      throw new ApiCallError(res.status, code, `${method} ${path} → ${res.status} ${code}`, body);
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
