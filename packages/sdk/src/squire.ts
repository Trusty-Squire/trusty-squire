// The developer-facing entry point. Groups the client by task and returns
// approvals as camelCase `Approval` cards.
//
// The token is the user's account-bound Squire session token: keep it on your
// server. A browser only needs `approvals.open()`, which takes no token.
//
// What this class deliberately cannot do: approve anything, or read a key or
// card without the user's YES. A YES always needs the user's passkey on the
// Squire page. After it, `credentials.claimReveal()` and `payments.claim()`
// deliver the value once, sealed to this app's own key and opened here; card
// and status payloads never carry it.

import { ApiClient, DEFAULT_API_BASE_URL, type CredentialMetadataChanges, type CredentialSelector, type ProvisionInput, type UseCredentialInput } from "./client.js";
import { approvalFromWire, isFinalStatus, type Approval, type ApprovalWire } from "./approval.js";
import { ApiCallError, MissingTokenError, SealedDeliveryError } from "./errors.js";
import {
  bytesToBase64Url,
  generateSealingKey,
  mandatePayloadHash,
  openSealed,
  paymentAad,
  publicKeyHash,
  revealAad,
  type SealingKey,
} from "./sealing.js";
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
  /**
   * This app's sealing key (`generateSealingKey()`). Revealed keys and released
   * cards are sealed to it. Omitted, the client makes one in memory, so a claim
   * must happen before the process restarts.
   */
  sealingKey?: SealingKey;
  fetch?: typeof fetch;
}

export interface RequestedApproval {
  approval: Approval;
}

/** A revealed key, opened locally. `value` is set when exactly one field was revealed. */
export interface RevealedCredential {
  approvalId: string;
  fields: Record<string, string>;
  value: string | null;
}

/** The card data the user released for one payment. Use it once; do not store it. */
export interface PaymentCardData {
  pan: string;
  exp_month: string;
  exp_year: string;
  name: string;
  cvv: string;
  billing: {
    line1: string;
    line2?: string;
    city: string;
    state?: string;
    postal_code: string;
    country: string;
  };
}

export interface ReleasedCard {
  approvalId: string;
  card: PaymentCardData;
  last4: string;
  /** Now `processing`. Report the merchant's answer with `payments.report()`. */
  approval: Approval;
}

export interface PaymentRequestInput {
  /** The merchant's name or domain, shown on the approval. */
  merchant: string;
  /** Integer amount in the currency's minor unit (cents for USD). */
  amount: number;
  currency: string;
  /** A saved card's id from `cards.list()`. Omitted, the user picks or adds one on the Squire page. */
  cardRef?: string;
  reason: string;
  /** What is being bought. Defaults to `reason`. */
  item?: string;
  /** The checkout's origin. Defaults to https://<merchant> when `merchant` is a domain. */
  checkoutOrigin?: string;
}

const CLAIM_WAIT_STEP_MS = 15_000;

function checkoutOriginFor(input: PaymentRequestInput): string {
  const candidate = input.checkoutOrigin ?? input.merchant.trim();
  try {
    const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".")) {
      return url.origin;
    }
  } catch {
    // Fall through to the error below.
  }
  throw new TypeError(
    "payments.request needs checkoutOrigin when merchant is not a domain (for example https://shop.example).",
  );
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
  private sealingKey: Promise<SealingKey> | undefined;

  constructor(options: SquireOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.token = options.token ?? "";
    this.webhookSecret = options.webhookSecret;
    this.fetchImpl = options.fetch;
    if (options.sealingKey !== undefined) this.sealingKey = Promise.resolve(options.sealingKey);
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

  private async key(): Promise<SealingKey> {
    this.sealingKey ??= generateSealingKey();
    return await this.sealingKey;
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
    /**
     * Ask the user to reveal a key to this app. The card names this app. After
     * the passkey YES, `claimReveal()` returns the value once.
     */
    requestReveal: async (input: CredentialSelector & { field?: string; reason?: string }) =>
      requireCard(
        await this.api().createSealedReveal({
          ...input,
          recipient_public_key: (await this.key()).publicKey,
        }),
      ),
    /**
     * The approved value, once, for the session that asked. It arrives sealed to
     * this app's key and is opened here. Throws SealedDeliveryError
     * `approval_pending` before approval; ApiCallError once denied, expired or
     * already claimed. `timeoutMs` waits for the user first.
     */
    claimReveal: async (
      approvalId: string,
      options: { timeoutMs?: number; signal?: AbortSignal } = {},
    ): Promise<RevealedCredential> => {
      if ((options.timeoutMs ?? 0) > 0) {
        await this.approvals.wait(approvalId, {
          timeoutMs: options.timeoutMs!,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
      }
      const claim = await this.api().claimSealedReveal(approvalId);
      if (claim.sealed === undefined) {
        throw new SealedDeliveryError(
          claim.status === "pending" ? "approval_pending" : "no_sealed_value",
          `Reveal ${approvalId} is ${claim.status}; nothing was delivered.`,
        );
      }
      let plaintext: Uint8Array;
      try {
        plaintext = await openSealed((await this.key()).privateKey, claim.sealed, revealAad(approvalId));
      } catch {
        throw new SealedDeliveryError("open_failed", "The sealed value did not open with this app's key.");
      }
      const fields = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, string>;
      plaintext.fill(0);
      const values = Object.values(fields);
      return { approvalId, fields, value: values.length === 1 ? values[0]! : null };
    },
  };

  /** Pay with a card from the user's vault, released to this app after their passkey. */
  readonly payments = {
    /** Ask the user to approve a payment. The card names this app. */
    request: async (input: PaymentRequestInput): Promise<RequestedApproval> => {
      if (!Number.isSafeInteger(input.amount) || input.amount < 0) {
        throw new TypeError("payments.request amount is an integer in minor units, for example 3800 for USD 38.00.");
      }
      const response = await this.api().createSealedPayment({
        merchant: input.merchant,
        checkout_origin: checkoutOriginFor(input),
        amount_cents: input.amount,
        currency: input.currency,
        ...(input.cardRef !== undefined ? { card_ref: input.cardRef } : {}),
        operator_pubkey: (await this.key()).publicKey,
        item: input.item ?? input.reason,
        reason: input.reason,
      });
      return requireCard(response);
    },
    /**
     * The approved card, once, for the session that asked, opened here. The
     * approval then reads `processing`. Throws SealedDeliveryError
     * `approval_pending` while the user has not signed; ApiCallError once
     * denied, expired or already claimed. `timeoutMs` waits for the signature.
     */
    claim: async (
      approvalId: string,
      options: { timeoutMs?: number; signal?: AbortSignal } = {},
    ): Promise<ReleasedCard> => {
      const deadline = Date.now() + Math.max(0, options.timeoutMs ?? 0);
      let claim = await this.api().claimSealedPayment(
        approvalId,
        Math.min(CLAIM_WAIT_STEP_MS, Math.max(0, deadline - Date.now())),
        options.signal,
      );
      while (claim.status === "pending" && Date.now() < deadline && options.signal?.aborted !== true) {
        claim = await this.api().claimSealedPayment(
          approvalId,
          Math.min(CLAIM_WAIT_STEP_MS, Math.max(0, deadline - Date.now())),
          options.signal,
        );
      }
      if (claim.status === "pending") {
        throw new SealedDeliveryError("approval_pending", `Payment ${approvalId} is not signed yet.`);
      }
      const key = await this.key();
      const aad = await paymentAad({
        account_binding: claim.account_binding,
        approval_id: claim.id,
        merchant: claim.merchant,
        checkout_origin: claim.checkout_origin,
        amount_cents: claim.amount_cents,
        currency: claim.currency,
        nonce: claim.nonce,
        card_ref: claim.card_ref,
        recipient_pubkey_hash: await publicKeyHash(key.publicKey),
        item: claim.item,
        reason: claim.reason,
        agent: claim.agent,
      });
      // The passkey signed these exact terms, including this app's key.
      if (mandatePayloadHash(claim.jws) !== bytesToBase64Url(aad)) {
        throw new SealedDeliveryError("binding_mismatch", "The signed terms do not match this payment.");
      }
      let card: PaymentCardData;
      try {
        const plaintext = await openSealed(key.privateKey, claim.sealed_card, aad);
        card = JSON.parse(new TextDecoder().decode(plaintext)) as PaymentCardData;
        plaintext.fill(0);
      } catch {
        throw new SealedDeliveryError("open_failed", "The sealed card did not open with this app's key.");
      }
      await this.api().confirmSealedPayment(approvalId, {
        jws: claim.jws,
        sealed_card: claim.sealed_card,
      });
      const pan = String(card.pan).replace(/\D/g, "");
      return {
        approvalId,
        card,
        last4: pan.slice(-4),
        approval: approvalFromWire((await this.api().getApproval(approvalId)).approval),
      };
    },
    /** The merchant's answer. Moves the approval from processing to completed or failed. */
    report: async (
      approvalId: string,
      input: { outcome: "completed" | "failed"; last4?: string },
    ): Promise<Approval> =>
      approvalFromWire((await this.api().reportPaymentOutcome(approvalId, input)).approval),
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
