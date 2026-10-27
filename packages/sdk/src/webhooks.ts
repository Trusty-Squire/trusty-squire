// Verify a signed decision webhook from Trusty Squire.
//
//   squire-event-id: evt_<ulid>
//   squire-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
//
// Pass the RAW request body (the exact bytes received), not a re-serialized
// object: re-serializing changes the bytes and the signature will not match.
// A delivery is accepted only if a v1 signature matches AND its timestamp is
// within the tolerance, which bounds how long a captured request can be
// replayed. Retries of one event keep the same event id; pass `seen` to drop
// an id you already handled.

import { approvalFromWire, type Approval, type ApprovalStatus, type ApprovalWire } from "./approval.js";
import { WebhookVerificationError } from "./errors.js";

export const SIGNATURE_HEADER = "squire-signature";
export const EVENT_ID_HEADER = "squire-event-id";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type HeadersLike =
  | Headers
  | Record<string, string | string[] | undefined>
  | Iterable<[string, string]>;

export interface ApprovalEvent {
  /** Stable across retries; dedupe on it. */
  id: string;
  type: `approval.${ApprovalStatus}`;
  createdAt: string;
  approvalId: string;
  /** The approval's status after this change. Same as `approval.status`. */
  decision: ApprovalStatus;
  approval: Approval;
}

export interface VerifyWebhookOptions {
  /** Max age (and future skew) of the signed timestamp. Default 300 seconds. */
  toleranceSeconds?: number;
  /** Clock in milliseconds, for tests. */
  now?: () => number;
  /** Return true for an event id you already handled; the call then throws `replayed_event`. */
  seen?: (eventId: string) => boolean | Promise<boolean>;
}

function headerValue(headers: HeadersLike, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const entries: Iterable<[string, string | string[] | undefined]> =
    Symbol.iterator in (headers as object)
      ? (headers as Iterable<[string, string]>)
      : Object.entries(headers as Record<string, string | string[] | undefined>);
  for (const [key, value] of entries) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function parseSignature(value: string): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of value.split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const item = part.slice(index + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(item)) timestamp = Number(item);
    if (key === "v1" && /^[0-9a-f]{64}$/i.test(item)) signatures.push(item.toLowerCase());
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function subtle(): SubtleCrypto {
  const crypto = globalThis.crypto;
  if (crypto?.subtle === undefined) {
    throw new Error("Web Crypto is unavailable; verifyWebhook needs Node 20+ or a modern runtime.");
  }
  return crypto.subtle;
}

function isApprovalWire(value: unknown): value is ApprovalWire {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.title === "string" &&
    Array.isArray(candidate.details) &&
    typeof candidate.approve_url === "string"
  );
}

/** Verify and parse one delivery. Throws WebhookVerificationError on any mismatch. */
export async function verifyWebhook(
  body: string | Uint8Array,
  headers: HeadersLike,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<ApprovalEvent> {
  if (secret.length === 0) {
    throw new WebhookVerificationError("missing_secret", "No webhook secret was configured.");
  }
  const header = headerValue(headers, SIGNATURE_HEADER);
  if (header === undefined || header.length === 0) {
    throw new WebhookVerificationError("missing_signature", `Missing ${SIGNATURE_HEADER} header.`);
  }
  const parsed = parseSignature(header);
  if (parsed === null) {
    throw new WebhookVerificationError("malformed_signature", `Malformed ${SIGNATURE_HEADER} header.`);
  }
  const raw = typeof body === "string" ? body : new TextDecoder().decode(body);
  const encoder = new TextEncoder();
  const key = await subtle().importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = encoder.encode(`${parsed.timestamp}.${raw}`);
  let matched = false;
  for (const signature of parsed.signatures) {
    // subtle.verify compares in constant time.
    if (await subtle().verify("HMAC", key, hexToBytes(signature) as BufferSource, signed)) {
      matched = true;
      break;
    }
  }
  if (!matched) {
    throw new WebhookVerificationError("invalid_signature", "Webhook signature does not match.");
  }
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) {
    throw new WebhookVerificationError(
      "timestamp_out_of_range",
      "Webhook timestamp is outside the tolerance; treat it as a replay.",
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new WebhookVerificationError("invalid_payload", "Webhook body is not JSON.");
  }
  const event = payload as { id?: unknown; type?: unknown; created_at?: unknown; approval?: unknown };
  if (
    typeof event.id !== "string" ||
    typeof event.type !== "string" ||
    !event.type.startsWith("approval.") ||
    typeof event.created_at !== "string" ||
    !isApprovalWire(event.approval)
  ) {
    throw new WebhookVerificationError("invalid_payload", "Webhook body is not an approval event.");
  }
  const headerEventId = headerValue(headers, EVENT_ID_HEADER);
  if (headerEventId !== undefined && headerEventId !== event.id) {
    throw new WebhookVerificationError("invalid_payload", "Event id header does not match the body.");
  }
  if (options.seen !== undefined && (await options.seen(event.id))) {
    throw new WebhookVerificationError("replayed_event", `Event ${event.id} was already handled.`);
  }
  const approval = approvalFromWire(event.approval);
  return {
    id: event.id,
    type: event.type as ApprovalEvent["type"],
    createdAt: event.created_at,
    approvalId: approval.id,
    decision: approval.status,
    approval,
  };
}
