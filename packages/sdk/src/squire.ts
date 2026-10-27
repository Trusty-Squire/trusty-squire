// The developer-facing entry point. Groups the client by task and returns
// approvals as camelCase `Approval` cards.
//
// The token is the user's account-bound Squire session token: keep it on your
// server. A browser only needs `approvals.open()`, which takes no token.
//
// What this class deliberately cannot do: return a vaulted secret, return card
// data, or approve anything. Revealing a key and paying are started by the
// Squire broker, which is where the value or card is used; your app sees those
// approvals through `approvals.get()` and the decision webhook, and can deny
// them. A YES always needs the user's passkey on the Squire page.

import { ApiClient, DEFAULT_API_BASE_URL, type CredentialMetadataChanges, type CredentialSelector, type ProvisionInput, type UseCredentialInput } from "./client.js";
import { approvalFromWire, isFinalStatus, type Approval, type ApprovalWire } from "./approval.js";
import { ApiCallError, MissingTokenError } from "./errors.js";
import { installInitiate, installPoll } from "./install.js";
import { openApproval, approvalPageUrl, type OpenApprovalOptions, type ApprovalOutcome } from "./open.js";
import { verifyWebhook, type ApprovalEvent, type HeadersLike, type VerifyWebhookOptions } from "./webhooks.js";

export interface SquireOptions {
  /** The user's agent session token (from `connect`). Server-side only. */
  token?: string;
  /** Default: https://trusty-squire-api.fly.dev */
  baseUrl?: string;
  /** Your app's name, shown to the user as "Requested by". */
  agentName?: string;
  /** The secret returned by `webhooks.register()`, for `webhooks.verify()`. */
  webhookSecret?: string;
  fetch?: typeof fetch;
}

export interface RequestedApproval {
  approval: Approval;
}

function requireCard(response: { approval?: ApprovalWire }): RequestedApproval {
  if (response.approval === undefined) {
    throw new ApiCallError(502, "approval_missing", "The API response carried no approval card.");
  }
  return { approval: approvalFromWire(response.approval) };
}

export class Squire {
  readonly client: ApiClient;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly webhookSecret: string | undefined;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: SquireOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.token = options.token ?? "";
    this.webhookSecret = options.webhookSecret;
    this.fetchImpl = options.fetch;
    this.client = new ApiClient({
      apiBaseUrl: this.baseUrl,
      agentSessionToken: this.token,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.agentName !== undefined ? { agentIdentity: options.agentName } : {}),
    });
  }

  private api(): ApiClient {
    if (this.token.length === 0) throw new MissingTokenError();
    return this.client;
  }

  /** Connect a user: send them to `confirmUrl`, then poll until it is claimed. */
  readonly connect = {
    start: async (input: { agentName: string }) =>
      await installInitiate(this.baseUrl, input.agentName, null, this.fetchImpl),
    poll: async (setupCode: string) => await installPoll(this.baseUrl, setupCode, this.fetchImpl),
  };

  readonly credentials = {
    /** Metadata for every key in the vault. Never the values. */
    list: async () => (await this.api().listCredentials()).credentials,
    /** Put a key in the vault. It cannot be read back. */
    store: async (input: Parameters<ApiClient["storeCredential"]>[0]) =>
      await this.api().storeCredential(input),
    /** Call an API with a vaulted key. Squire injects it; you get the response only. */
    use: async (input: UseCredentialInput) => await this.api().useCredential(input),
    /** Ask the user to approve a metadata edit. Runs on approval. */
    requestEdit: async (input: CredentialSelector & { changes: CredentialMetadataChanges }) =>
      requireCard(
        await this.api().createCredentialMutationApproval({ ...input, operation: "edit" }),
      ),
    /** Ask the user to approve deleting a key. Runs on approval. */
    requestDelete: async (input: CredentialSelector) =>
      requireCard(
        await this.api().createCredentialMutationApproval({ ...input, operation: "delete" }),
      ),
  };

  readonly cards = {
    /** Saved payment cards: label, brand and last four digits only. */
    list: async () => await this.api().listPaymentCards(),
    /** Ask the user to edit a saved card on the Squire page. */
    requestEdit: async (input: { cardId?: string; label?: string }) =>
      requireCard(
        await this.api().createCardMutationApproval({
          operation: "edit_card",
          ...(input.cardId !== undefined ? { card_id: input.cardId } : {}),
          ...(input.label !== undefined ? { label: input.label } : {}),
        }),
      ),
  };

  /** Let a deployed app call a provider through Squire without holding the key. */
  readonly apps = {
    grant: async (input: Parameters<ApiClient["grantAppAccess"]>[0]) =>
      await this.api().grantAppAccess(input),
    list: async () => (await this.api().listEgressGrants()).grants,
    revoke: async (grantId: string) => await this.api().revokeEgressGrant(grantId),
  };

  readonly runs = {
    start: async (input: ProvisionInput) => await this.api().createRun(input),
    get: async (runId: string) => await this.api().getRun(runId),
  };

  readonly audit = {
    list: async (input: Parameters<ApiClient["listAudit"]>[0] = {}) =>
      await this.api().listAudit(input),
    daily: async (input: Parameters<ApiClient["listAuditDaily"]>[0] = {}) =>
      await this.api().listAuditDaily(input),
  };

  readonly approvals = {
    get: async (id: string): Promise<Approval> =>
      approvalFromWire((await this.api().getApproval(id)).approval),
    /**
     * Wait for the approval to leave `pending` (or reach a final status with
     * `untilFinal`). Uses the bounded server wait; no webhook needed.
     */
    wait: async (
      id: string,
      options: { timeoutMs?: number; untilFinal?: boolean; signal?: AbortSignal } = {},
    ): Promise<Approval> => {
      const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
      while (true) {
        const remaining = deadline - Date.now();
        const card = approvalFromWire(
          (await this.api().getApproval(id, Math.max(0, Math.min(15_000, remaining)), options.signal))
            .approval,
        );
        const done = options.untilFinal === true ? isFinalStatus(card.status) : card.status !== "pending";
        if (done || Date.now() >= deadline || options.signal?.aborted === true) return card;
        if (card.status !== "pending") await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    },
    /** The user said no in your UI. Nothing runs. */
    deny: async (id: string): Promise<Approval> =>
      approvalFromWire((await this.api().denyApproval(id)).approval),
    /** Browser only: the Squire passkey page in a sheet over your app. Call from a click. */
    open: (approval: Pick<Approval, "id" | "approveUrl">, options?: OpenApprovalOptions): Promise<ApprovalOutcome> =>
      openApproval(approval, options),
    /** The page URL for one mode, for hosts without a DOM (native in-app browsers). */
    url: approvalPageUrl,
  };

  readonly webhooks = {
    /** Register this session's decision webhook. Returns the signing secret once. */
    register: async (url: string) => await this.api().registerApprovalWebhook(url),
    get: async () => await this.api().getApprovalWebhook(),
    remove: async () => await this.api().deleteApprovalWebhook(),
    /** Verify a delivery against the RAW body. Throws WebhookVerificationError. */
    verify: async (
      body: string | Uint8Array,
      headers: HeadersLike,
      options: VerifyWebhookOptions & { secret?: string } = {},
    ): Promise<ApprovalEvent> =>
      await verifyWebhook(body, headers, options.secret ?? this.webhookSecret ?? "", options),
  };
}
