// Signed decision webhooks for approvals.
//
// An agent session may register ONE https URL. Every approval that session
// requests is then watched, and each time its status changes Squire POSTs a
// signed event carrying the approval card (display data only — see
// approval-card.ts). The app updates its in-conversation card and resumes the
// agent without polling. A developer with no webhook keeps the status endpoint.
//
// Delivery shape:
//
//   POST <url>
//   content-type: application/json
//   squire-event-id: evt_<ulid>
//   squire-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
//
//   {"id":"evt_…","type":"approval.approved","created_at":"…","approval":{…}}
//
// The secret is derived from the server signing key and a per-endpoint salt,
// so it is never stored; re-registering rotates it. A receiver rejects a
// signature that does not match and a timestamp outside its tolerance (that is
// the replay window), and dedupes on the event id, which stays the same on
// every retry of one event.
//
// Webhooks never gate an approval. Every failure here is logged and swallowed:
// the approval flow, its audit rows and the status endpoint behave exactly as
// they did without a webhook.

import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { ulid } from "ulid";
import { isBlockedAddress } from "./http-proxy.js";
import {
  isTerminalApprovalStatus,
  type ApprovalCard,
  type ApprovalKind,
  type ApprovalStatus,
} from "./approval-card.js";

export const APPROVAL_WEBHOOK_SIGNATURE_HEADER = "squire-signature";
export const APPROVAL_WEBHOOK_EVENT_ID_HEADER = "squire-event-id";

export interface ApprovalWebhookEndpoint {
  id: string;
  accountId: string;
  agentSessionId: string;
  url: string;
  secretSalt: string;
  createdAt: Date;
}

export interface ApprovalWebhookSubscription {
  approvalId: string;
  kind: ApprovalKind;
  accountId: string;
  endpointId: string;
  lastStatus: ApprovalStatus | null;
  open: boolean;
  expiresAt: Date;
  createdAt: Date;
}

export interface ApprovalWebhookDelivery {
  id: string;
  endpointId: string;
  approvalId: string;
  payload: string;
  attempts: number;
  nextAttemptAt: Date;
  deliveredAt: Date | null;
  abandonedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

export interface NewApprovalWebhookDelivery {
  id: string;
  endpointId: string;
  approvalId: string;
  payload: string;
  nextAttemptAt: Date;
}

export interface ApprovalWebhookStore {
  /** Register or replace the session's endpoint. Replacing rotates the salt. */
  upsertEndpoint(input: {
    accountId: string;
    agentSessionId: string;
    url: string;
    secretSalt: string;
  }): Promise<ApprovalWebhookEndpoint>;
  getEndpointForSession(agentSessionId: string): Promise<ApprovalWebhookEndpoint | null>;
  getEndpointById(id: string): Promise<ApprovalWebhookEndpoint | null>;
  deleteEndpointForSession(agentSessionId: string): Promise<boolean>;
  /** Idempotent: the first subscription for an approval wins. */
  subscribe(input: {
    approvalId: string;
    kind: ApprovalKind;
    accountId: string;
    endpointId: string;
    expiresAt: Date;
  }): Promise<void>;
  getSubscription(approvalId: string): Promise<ApprovalWebhookSubscription | null>;
  listOpenSubscriptions(limit: number): Promise<ApprovalWebhookSubscription[]>;
  /**
   * Move the announced status from `expected` to `next` and queue `delivery`,
   * together and only if nobody moved it first. Returns false when another
   * worker already announced a change, so one change yields one event.
   */
  advanceSubscription(
    approvalId: string,
    expected: ApprovalStatus | null,
    next: ApprovalStatus,
    open: boolean,
    delivery: NewApprovalWebhookDelivery | null,
  ): Promise<boolean>;
  listDueDeliveries(now: Date, limit: number): Promise<ApprovalWebhookDelivery[]>;
  /** Take one attempt: attempts must still equal `expectedAttempts`. */
  claimDelivery(id: string, expectedAttempts: number, leaseUntil: Date): Promise<boolean>;
  markDelivered(id: string, at: Date): Promise<void>;
  /** `nextAttemptAt` null abandons the delivery. */
  markFailed(id: string, error: string, nextAttemptAt: Date | null, at: Date): Promise<void>;
  /** Drop finished deliveries and closed subscriptions older than `before`. */
  purge(before: Date): Promise<void>;
}

export class InMemoryApprovalWebhookStore implements ApprovalWebhookStore {
  private readonly endpoints = new Map<string, ApprovalWebhookEndpoint>();
  private readonly subscriptions = new Map<string, ApprovalWebhookSubscription>();
  private readonly deliveries = new Map<string, ApprovalWebhookDelivery>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async upsertEndpoint(input: {
    accountId: string;
    agentSessionId: string;
    url: string;
    secretSalt: string;
  }): Promise<ApprovalWebhookEndpoint> {
    const existing = [...this.endpoints.values()].find(
      (endpoint) => endpoint.agentSessionId === input.agentSessionId,
    );
    const endpoint: ApprovalWebhookEndpoint = {
      id: existing?.id ?? ulid(),
      accountId: input.accountId,
      agentSessionId: input.agentSessionId,
      url: input.url,
      secretSalt: input.secretSalt,
      createdAt: this.now(),
    };
    this.endpoints.set(endpoint.id, endpoint);
    return { ...endpoint };
  }

  async getEndpointForSession(agentSessionId: string): Promise<ApprovalWebhookEndpoint | null> {
    const endpoint = [...this.endpoints.values()].find(
      (candidate) => candidate.agentSessionId === agentSessionId,
    );
    return endpoint === undefined ? null : { ...endpoint };
  }

  async getEndpointById(id: string): Promise<ApprovalWebhookEndpoint | null> {
    const endpoint = this.endpoints.get(id);
    return endpoint === undefined ? null : { ...endpoint };
  }

  async deleteEndpointForSession(agentSessionId: string): Promise<boolean> {
    for (const endpoint of this.endpoints.values()) {
      if (endpoint.agentSessionId === agentSessionId) {
        this.endpoints.delete(endpoint.id);
        return true;
      }
    }
    return false;
  }

  async subscribe(input: {
    approvalId: string;
    kind: ApprovalKind;
    accountId: string;
    endpointId: string;
    expiresAt: Date;
  }): Promise<void> {
    if (this.subscriptions.has(input.approvalId)) return;
    this.subscriptions.set(input.approvalId, {
      ...input,
      expiresAt: new Date(input.expiresAt),
      lastStatus: null,
      open: true,
      createdAt: this.now(),
    });
  }

  async getSubscription(approvalId: string): Promise<ApprovalWebhookSubscription | null> {
    const subscription = this.subscriptions.get(approvalId);
    return subscription === undefined ? null : { ...subscription };
  }

  async listOpenSubscriptions(limit: number): Promise<ApprovalWebhookSubscription[]> {
    return [...this.subscriptions.values()]
      .filter((subscription) => subscription.open)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map((subscription) => ({ ...subscription }));
  }

  async advanceSubscription(
    approvalId: string,
    expected: ApprovalStatus | null,
    next: ApprovalStatus,
    open: boolean,
    delivery: NewApprovalWebhookDelivery | null,
  ): Promise<boolean> {
    const subscription = this.subscriptions.get(approvalId);
    if (subscription === undefined || !subscription.open || subscription.lastStatus !== expected) {
      return false;
    }
    subscription.lastStatus = next;
    subscription.open = open;
    if (delivery !== null) {
      this.deliveries.set(delivery.id, {
        ...delivery,
        attempts: 0,
        deliveredAt: null,
        abandonedAt: null,
        lastError: null,
        createdAt: this.now(),
      });
    }
    return true;
  }

  async listDueDeliveries(now: Date, limit: number): Promise<ApprovalWebhookDelivery[]> {
    return [...this.deliveries.values()]
      .filter(
        (delivery) =>
          delivery.deliveredAt === null &&
          delivery.abandonedAt === null &&
          delivery.nextAttemptAt <= now,
      )
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit)
      .map((delivery) => ({ ...delivery }));
  }

  async claimDelivery(id: string, expectedAttempts: number, leaseUntil: Date): Promise<boolean> {
    const delivery = this.deliveries.get(id);
    if (
      delivery === undefined ||
      delivery.attempts !== expectedAttempts ||
      delivery.deliveredAt !== null ||
      delivery.abandonedAt !== null
    ) {
      return false;
    }
    delivery.attempts += 1;
    delivery.nextAttemptAt = leaseUntil;
    return true;
  }

  async markDelivered(id: string, at: Date): Promise<void> {
    const delivery = this.deliveries.get(id);
    if (delivery !== undefined) {
      delivery.deliveredAt = at;
      delivery.lastError = null;
    }
  }

  async markFailed(id: string, error: string, nextAttemptAt: Date | null, at: Date): Promise<void> {
    const delivery = this.deliveries.get(id);
    if (delivery === undefined) return;
    delivery.lastError = error;
    if (nextAttemptAt === null) delivery.abandonedAt = at;
    else delivery.nextAttemptAt = nextAttemptAt;
  }

  async purge(before: Date): Promise<void> {
    for (const [id, delivery] of this.deliveries) {
      const finishedAt = delivery.deliveredAt ?? delivery.abandonedAt;
      if (finishedAt !== null && finishedAt < before) this.deliveries.delete(id);
    }
    for (const [id, subscription] of this.subscriptions) {
      if (!subscription.open && subscription.expiresAt < before) this.subscriptions.delete(id);
    }
  }

  /** Test helper: every queued delivery, oldest first. */
  allDeliveries(): ApprovalWebhookDelivery[] {
    return [...this.deliveries.values()]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .map((delivery) => ({ ...delivery }));
  }
}

// ── Signing ─────────────────────────────────────────────────────

/** The endpoint's signing secret. Derived, never stored. */
export function approvalWebhookSecret(signingKey: string, endpoint: ApprovalWebhookEndpoint): string {
  const digest = createHmac("sha256", signingKey)
    .update(`trusty-squire/approval-webhook/v1\n${endpoint.id}\n${endpoint.secretSalt}`)
    .digest("base64url");
  return `whsec_${digest}`;
}

export function signApprovalWebhook(secret: string, timestampSeconds: number, body: string): string {
  const v1 = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${v1}`;
}

export interface ApprovalWebhookEvent {
  id: string;
  type: `approval.${ApprovalStatus}`;
  created_at: string;
  approval: ApprovalCard;
}

// ── Registration URL check ──────────────────────────────────────

/**
 * Local development only: accept and deliver to a loopback http endpoint.
 * Off unless APPROVAL_WEBHOOK_ALLOW_LOOPBACK=1, and never in production.
 */
export function loopbackWebhooksAllowed(): boolean {
  return (
    process.env.APPROVAL_WEBHOOK_ALLOW_LOOPBACK === "1" && process.env.NODE_ENV !== "production"
  );
}

/**
 * An endpoint must be https with no credentials in the URL. Plain http to
 * loopback is accepted only when loopbackWebhooksAllowed().
 */
export function validateApprovalWebhookUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (raw.length > 2048 || url.username !== "" || url.password !== "" || url.hash !== "") {
    return null;
  }
  if (url.protocol === "https:") return url;
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "http:" && loopback && loopbackWebhooksAllowed()) return url;
  return null;
}

// ── Transport ───────────────────────────────────────────────────

export type ApprovalWebhookPoster = (input: {
  url: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ status: number }>;

/**
 * POST with the same SSRF posture as the vault proxy: resolve once, refuse a
 * private, loopback, link-local, CGNAT or NAT64 address, and pin the
 * connection to the address that passed the check.
 */
export function createApprovalWebhookPoster(
  opts: { timeoutMs?: number; allowPrivate?: boolean } = {},
): ApprovalWebhookPoster {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return async ({ url, headers, body }) => {
    const target = new URL(url);
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    const resolved =
      isIP(hostname) !== 0
        ? { address: hostname, family: isIP(hostname) }
        : await new Promise<{ address: string; family: number }>((resolve, reject) => {
            dnsLookup(hostname, (error, address, family) => {
              if (error !== null) reject(error);
              else resolve({ address, family });
            });
          });
    if (opts.allowPrivate !== true && isBlockedAddress(resolved.address)) {
      throw new Error("blocked_address");
    }
    const send = target.protocol === "http:" ? httpRequest : httpsRequest;
    return await new Promise<{ status: number }>((resolve, reject) => {
      const req = send(
        {
          method: "POST",
          hostname: target.hostname,
          ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
          port: target.port !== "" ? Number(target.port) : undefined,
          path: `${target.pathname}${target.search}`,
          headers: {
            ...headers,
            "content-length": String(Buffer.byteLength(body)),
          },
          lookup: (_host, lookupOpts, callback) => {
            if (lookupOpts.all === true) {
              callback(null, [{ address: resolved.address, family: resolved.family }]);
            } else {
              callback(null, resolved.address, resolved.family);
            }
          },
        },
        (res) => {
          // The receiver's body means nothing to us; drain and discard it.
          res.resume();
          res.once("end", () => resolve({ status: res.statusCode ?? 0 }));
          res.once("error", reject);
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
      req.once("error", reject);
      req.end(body);
    });
  };
}

// ── Service ─────────────────────────────────────────────────────

/** Seconds after each failed attempt; the delivery is abandoned after the last. */
export const APPROVAL_WEBHOOK_BACKOFF_MS = [
  10_000,
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
] as const;

const DELIVERY_LEASE_MS = 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface ApprovalWebhookServiceOptions {
  store: ApprovalWebhookStore;
  readCard: (accountId: string, id: string, kind: ApprovalKind) => Promise<ApprovalCard | null>;
  signingKey: string;
  now?: () => Date;
  post?: ApprovalWebhookPoster;
  backoffMs?: readonly number[];
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export class ApprovalWebhookService {
  private readonly store: ApprovalWebhookStore;
  private readonly readCard: ApprovalWebhookServiceOptions["readCard"];
  private readonly signingKey: string;
  private readonly now: () => Date;
  private readonly post: ApprovalWebhookPoster;
  private readonly backoffMs: readonly number[];
  private readonly log: (event: string, detail: Record<string, unknown>) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  // Background work started by track/notify, so a sweep can wait for it.
  private readonly inflight = new Set<Promise<void>>();
  private lastPurge = 0;

  constructor(opts: ApprovalWebhookServiceOptions) {
    this.store = opts.store;
    this.readCard = opts.readCard;
    this.signingKey = opts.signingKey;
    this.now = opts.now ?? (() => new Date());
    this.post = opts.post ?? createApprovalWebhookPoster();
    this.backoffMs = opts.backoffMs ?? APPROVAL_WEBHOOK_BACKOFF_MS;
    this.log = opts.log ?? (() => {});
  }

  secretFor(endpoint: ApprovalWebhookEndpoint): string {
    return approvalWebhookSecret(this.signingKey, endpoint);
  }

  /**
   * Watch a freshly requested approval for the requesting session's endpoint,
   * and announce it. A session without an endpoint costs one read.
   */
  async track(input: {
    kind: ApprovalKind;
    approvalId: string;
    accountId: string;
    agentSessionId: string | null;
    expiresAt: Date;
  }): Promise<void> {
    if (input.agentSessionId === null) return;
    try {
      const endpoint = await this.store.getEndpointForSession(input.agentSessionId);
      if (endpoint === null || endpoint.accountId !== input.accountId) return;
      await this.store.subscribe({
        approvalId: input.approvalId,
        kind: input.kind,
        accountId: input.accountId,
        endpointId: endpoint.id,
        expiresAt: input.expiresAt,
      });
      await this.sync(input.approvalId);
      this.background(this.deliverDue());
    } catch (error) {
      this.log("approval_webhook_track_failed", { approval_id: input.approvalId, error: errorText(error) });
    }
  }

  /** Something may have moved this approval: announce it now, not at the next tick. */
  notify(approvalId: string): void {
    this.background(this.sync(approvalId).then(() => this.deliverDue()));
  }

  private background(work: Promise<void>): void {
    const tracked = work
      .catch((error: unknown) => {
        this.log("approval_webhook_background_failed", { error: errorText(error) });
      })
      .finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  /** Wait for background sends started by track/notify. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  /** Compare the approval's current status with the last one announced. */
  async sync(approvalId: string): Promise<void> {
    const subscription = await this.store.getSubscription(approvalId);
    if (subscription === null || !subscription.open) return;
    await this.syncSubscription(subscription);
  }

  private async syncSubscription(subscription: ApprovalWebhookSubscription): Promise<void> {
    const card = await this.readCard(
      subscription.accountId,
      subscription.approvalId,
      subscription.kind,
    );
    const endpoint =
      card === null ? null : await this.store.getEndpointById(subscription.endpointId);
    if (card === null || endpoint === null) {
      // The approval was swept or the endpoint removed: stop watching quietly.
      await this.store.advanceSubscription(
        subscription.approvalId,
        subscription.lastStatus,
        subscription.lastStatus ?? "expired",
        false,
        null,
      );
      return;
    }
    if (card.status === subscription.lastStatus) return;
    const terminal = isTerminalApprovalStatus(card.status);
    const now = this.now();
    const event: ApprovalWebhookEvent = {
      id: `evt_${ulid()}`,
      type: `approval.${card.status}`,
      created_at: now.toISOString(),
      approval: card,
    };
    const moved = await this.store.advanceSubscription(
      subscription.approvalId,
      subscription.lastStatus,
      card.status,
      !terminal,
      {
        id: event.id,
        endpointId: endpoint.id,
        approvalId: subscription.approvalId,
        payload: JSON.stringify(event),
        nextAttemptAt: now,
      },
    );
    if (moved) {
      this.log("approval_webhook_queued", {
        approval_id: subscription.approvalId,
        event_id: event.id,
        status: card.status,
      });
    }
  }

  /** Send every due delivery once. */
  async deliverDue(limit = 50): Promise<void> {
    const due = await this.store.listDueDeliveries(this.now(), limit);
    await Promise.all(due.map((delivery) => this.attempt(delivery)));
  }

  private async attempt(delivery: ApprovalWebhookDelivery): Promise<void> {
    const startedAt = this.now();
    const claimed = await this.store.claimDelivery(
      delivery.id,
      delivery.attempts,
      new Date(startedAt.getTime() + DELIVERY_LEASE_MS),
    );
    if (!claimed) return;
    const attemptNumber = delivery.attempts + 1;
    const endpoint = await this.store.getEndpointById(delivery.endpointId);
    if (endpoint === null) {
      await this.store.markFailed(delivery.id, "endpoint_removed", null, startedAt);
      return;
    }
    const timestamp = Math.floor(startedAt.getTime() / 1000);
    let error: string | null = null;
    try {
      const response = await this.post({
        url: endpoint.url,
        headers: {
          "content-type": "application/json",
          "user-agent": "trusty-squire-webhooks/1.0 (+https://trustysquire.ai)",
          [APPROVAL_WEBHOOK_EVENT_ID_HEADER]: delivery.id,
          [APPROVAL_WEBHOOK_SIGNATURE_HEADER]: signApprovalWebhook(
            this.secretFor(endpoint),
            timestamp,
            delivery.payload,
          ),
        },
        body: delivery.payload,
      });
      if (response.status < 200 || response.status >= 300) error = `http_${response.status}`;
    } catch (caught) {
      error = errorText(caught);
    }
    const finishedAt = this.now();
    if (error === null) {
      await this.store.markDelivered(delivery.id, finishedAt);
      this.log("approval_webhook_delivered", { event_id: delivery.id, attempt: attemptNumber });
      return;
    }
    const waitMs = this.backoffMs[attemptNumber - 1];
    await this.store.markFailed(
      delivery.id,
      error,
      waitMs === undefined ? null : new Date(finishedAt.getTime() + waitMs),
      finishedAt,
    );
    this.log(waitMs === undefined ? "approval_webhook_abandoned" : "approval_webhook_retry", {
      event_id: delivery.id,
      attempt: attemptNumber,
      error,
    });
  }

  /**
   * One sweep: announce changes no route reported (expiry is lazy, so this is
   * where an unanswered approval's expiry goes out), then send what is due.
   */
  async tick(): Promise<void> {
    if (this.ticking !== null) return await this.ticking;
    this.ticking = (async () => {
      try {
        await this.drain();
        const open = await this.store.listOpenSubscriptions(500);
        for (const subscription of open) {
          try {
            await this.syncSubscription(subscription);
          } catch (error) {
            this.log("approval_webhook_sync_failed", {
              approval_id: subscription.approvalId,
              error: errorText(error),
            });
          }
        }
        await this.deliverDue();
        const now = this.now().getTime();
        if (now - this.lastPurge > 60 * 60_000) {
          this.lastPurge = now;
          await this.store.purge(new Date(now - RETENTION_MS));
        }
      } catch (error) {
        this.log("approval_webhook_tick_failed", { error: errorText(error) });
      } finally {
        this.ticking = null;
      }
    })();
    return await this.ticking;
  }

  start(intervalMs = 5_000): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "unknown_error";
}
