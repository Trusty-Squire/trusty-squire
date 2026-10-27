// The MCP server's HTTP client for apps/api + apps/registry.
//
// The shared, public surface lives in @trusty-squire/sdk (one client for the
// MCP and for apps). This subclass adds what only the local Squire broker may
// call: the payment-card relay, the single-use reveal delivery, browser fill,
// and registry/diagnostic endpoints. Tests inject a mock of this module.

import {
  ApiCallError,
  ApiClient as SdkApiClient,
  type ApiClientConfig as SdkApiClientConfig,
  type CredentialFetchApproval as SdkCredentialFetchApproval,
} from "@trusty-squire/sdk";

export {
  ApiCallError,
  installInitiate,
  installPoll,
  type CardMutationApproval,
  type CreateRunResponse,
  type CredentialMutationApproval,
  type InstallInitiateResponse,
  type InstallStatusResponse,
  type ProvisionInput,
  type RunSummary,
  type VaultCredentialSummary,
} from "@trusty-squire/sdk";

export class MissingSessionError extends Error {
  constructor() {
    super(
      "No active Trusty Squire session. Run `npx @trusty-squire/mcp connect --target=<agent>` to set up this machine.",
    );
    this.name = "MissingSessionError";
  }
}

export function isPaymentApprovalTransportTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export interface ApiClientConfig extends SdkApiClientConfig {
  registryBaseUrl: string;
  // Account identifier — sent as `x-account-id` to the registry,
  // which uses it for scoping (extract-failure snapshots, skill
  // uploads, etc.). Optional because dev/test MCPs may not yet have
  // a paired account; the registry falls back to "anonymous"
  // when this header is missing.
  accountId?: string;
}

// fetch_credential's approval record. `fields` is present ONLY on the single
// delivery that follows a passkey-signed approval; every other status carries
// no value at all.
export interface CredentialFetchApproval extends SdkCredentialFetchApproval {
  fields?: Record<string, string>;
  fetched_at?: string;
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
  monthly?: { spent_cents: number; budget_cents: number; remaining_cents: number };
  daily?: { spent_cents: number; silent_max_cents: number };
  mandate_id?: string;
  decisions: { month_calls: number; month_input_tokens: number; month_output_tokens: number };
}

export interface PaymentApproval {
  id: string;
  status: "pending" | "approved" | "denied" | "expired";
  merchant: string;
  checkout_origin: string;
  amount_cents: number;
  currency: string;
  nonce: string;
  // null for a card-less JIT approval until the add-card ceremony binds one.
  card_ref: string | null;
  operator_pubkey: string;
  account_binding: string;
  jws: string | null;
  sealed_card: string | null;
  expires_at: string;
}

export interface HeightenedAuthNotificationInput {
  service: string;
  attempt_id: string;
  challenge_revision: string;
  digit: string | null;
  observed_at: string;
  expires_at: string | null;
  window_seconds: number;
}

export interface HeightenedAuthNotificationResult {
  sent: boolean;
  deduped: boolean;
  attempt_id: string;
  challenge_revision: string;
  delivery: {
    channel: "telegram" | "email" | null;
    status: "sent" | "failed";
    error?: string;
  };
}

export class ApiClient extends SdkApiClient {
  constructor(private readonly mcpConfig: ApiClientConfig) {
    super(mcpConfig);
  }

  // ── Payments: the broker's card relay (never part of the SDK) ──

  async createPaymentApproval(input: {
    merchant: string;
    checkout_origin: string;
    amount_cents: number;
    currency: string;
    // Absent = card-less JIT approval; the card is bound later via
    // POST /v1/pay/approvals/:id/bind-card. JSON.stringify drops the key when
    // it is undefined, so the server sees no card_ref.
    card_ref?: string;
    operator_pubkey: string;
    item: string;
    reason: string;
  }): Promise<{
    id: string;
    nonce: string;
    agent: string;
    account_binding: string;
    expires_at: string;
  }> {
    return this.post("/v1/pay/approvals", input);
  }

  async getPaymentApproval(
    id: string,
    candidateRead: boolean | "immediate" | "peek" | "wait-peek" | "wait-decision-peek" = false,
    waitMs?: number,
    transportTimeoutMs?: number,
    cancellation?: AbortSignal,
  ): Promise<PaymentApproval> {
    const query =
      candidateRead === true
        ? "?wait_for_submission=1"
        : candidateRead === "immediate"
          ? "?read_submission=1"
          : candidateRead === "peek"
            ? "?peek_submission=1"
            : candidateRead === "wait-peek"
              ? "?wait_for_submission=1&peek_submission=1"
              : candidateRead === "wait-decision-peek"
                ? "?wait_for_decision=1&peek_submission=1"
                : "";
    const boundedWait =
      waitMs === undefined
        ? ""
        : `${query.length === 0 ? "?" : "&"}wait_ms=${Math.max(0, Math.floor(waitMs))}`;
    const timeout =
      transportTimeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(Math.max(1, Math.floor(transportTimeoutMs)));
    const signal =
      timeout && cancellation
        ? AbortSignal.any([timeout, cancellation])
        : (timeout ?? cancellation);
    return this.get(`/v1/pay/approvals/${encodeURIComponent(id)}${query}${boundedWait}`, signal);
  }

  async confirmPaymentApproval(
    id: string,
    submission: { jws: string; sealed_card: string },
  ): Promise<{ status: "verified" | "approved" }> {
    // Send exactly the schema fields: callers pass wider candidate objects
    // (extra card_ref), and the server validates this body strictly — an
    // excess key leaking into the wire body 400'd every confirm (Aug 2026).
    return this.post(`/v1/pay/approvals/${encodeURIComponent(id)}/confirm`, {
      jws: submission.jws,
      sealed_card: submission.sealed_card,
    });
  }

  async getPaymentConfig(): Promise<{ vouchflow_audience?: string }> {
    return this.get("/v1/pay/config");
  }

  async notifyThreeDs(
    approvalId: string,
    mode: "detected_challenge" | "possible_out_of_band",
  ): Promise<{ sent: boolean }> {
    return this.post(`/v1/pay/approvals/${encodeURIComponent(approvalId)}/notify-3ds`, { mode });
  }

  async notifyHeightenedAuth(
    input: HeightenedAuthNotificationInput,
    signal?: AbortSignal,
  ): Promise<HeightenedAuthNotificationResult> {
    return this.post<HeightenedAuthNotificationResult>("/v1/notify/heightened-auth", input, signal);
  }

  async auditPayment(input: {
    merchant: string;
    amount_cents: number;
    currency: string;
    last4: string;
    status: string;
    mandate_id?: string;
    // The vault card reference the charge attempt was bound to — never the
    // raw PAN. Optional: only the caller-placed-charge-attempt audit event
    // (operate_act's place-order guard) currently supplies it.
    card_ref?: string;
    approval_id?: string;
  }): Promise<{ id: string }> {
    return this.post("/v1/vault/payments/audit", {
      merchant: input.merchant,
      amountCents: input.amount_cents,
      currency: input.currency,
      last4: input.last4,
      status: input.status,
      ...(input.mandate_id !== undefined ? { mandateId: input.mandate_id } : {}),
      ...(input.card_ref !== undefined ? { cardRef: input.card_ref } : {}),
      ...(input.approval_id !== undefined ? { approvalId: input.approval_id } : {}),
    });
  }

  // ── fetch_credential delivery: the single-use reveal (never part of the SDK) ──

  async getCredentialFetchApproval(id: string): Promise<CredentialFetchApproval> {
    return this.get(`/v1/vault/fetch-approvals/${encodeURIComponent(id)}`);
  }

  // Platform Jev — POST /v1/decide. Returns the upstream HTTP status and body
  // verbatim (including 503/529/422) so askJev's retry path can read them the
  // same way it reads a vault-proxied TypeSafe response.
  async decide(
    state: string,
    questions: Record<string, unknown>,
  ): Promise<{ status: number; body: string }> {
    const res = await this.fetchImpl(`${this.config.apiBaseUrl}/v1/decide`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ state, questions }),
    });
    return { status: res.status, body: await res.text() };
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
    const url = `${this.mcpConfig.registryBaseUrl}/v1/extract-failures`;
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
    const url = `${this.mcpConfig.registryBaseUrl}/v1/extract-failures?limit=${encodeURIComponent(String(limit))}`;
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
    const url = `${this.mcpConfig.registryBaseUrl}/v1/extract-failures/${encodeURIComponent(id)}`;
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
        ? `${this.mcpConfig.registryBaseUrl}/adapters?category=${encodeURIComponent(category)}`
        : `${this.mcpConfig.registryBaseUrl}/adapters`;
    const res = await this.fetchImpl(url, { method: "GET" });
    return (await this.handleResponse(res, "GET", url)) as { adapters: DirectoryEntry[] };
  }

  // ── Internal HTTP helpers ─────────────────────────────────

  protected override headers(): Record<string, string> {
    const h = super.headers();
    // The registry scopes its reads to `x-account-id`. Main API
    // ignores unknown headers, so it's safe to always send.
    if (this.mcpConfig.accountId !== undefined) {
      h["x-account-id"] = this.mcpConfig.accountId;
    }
    return h;
  }
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
