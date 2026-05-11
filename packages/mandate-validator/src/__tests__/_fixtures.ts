// Test fixtures: keypair generation + signing helpers + canonical
// mandate / delta builders. Keeps the per-test files focused on
// assertions rather than crypto plumbing.

import { Buffer } from "node:buffer";
import {
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
  type KeyObject,
} from "node:crypto";
import { canonicalBytes } from "../canonicalize.js";
import { computeRunBinding } from "../run-binding.js";
import type {
  Delta,
  DeltaSignature,
  Mandate,
  MandateSignature,
  SignatureAlg,
  SignedDelta,
  SignedMandate,
  SigningDevice,
} from "../types.js";

// ── Keypair holders ──────────────────────────────────────────

export interface Ed25519Pair {
  alg: "Ed25519";
  privateKey: KeyObject;
  publicKeyB64Url: string; // raw 32 bytes, base64url
}

export interface Es256Pair {
  alg: "ES256";
  privateKey: KeyObject;
  publicKeyB64Url: string; // SPKI DER, base64url
}

export type AnyPair = Ed25519Pair | Es256Pair;

export function generateEd25519(): Ed25519Pair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  // Raw key sits at the end of the SPKI DER (last 32 bytes after the
  // fixed 12-byte Ed25519 SPKI prefix).
  const spki = publicKey.export({ format: "der", type: "spki" });
  const raw = spki.subarray(spki.length - 32);
  return {
    alg: "Ed25519",
    privateKey,
    publicKeyB64Url: Buffer.from(raw).toString("base64url"),
  };
}

export function generateEs256(): Es256Pair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    alg: "ES256",
    privateKey,
    publicKeyB64Url: Buffer.from(spki).toString("base64url"),
  };
}

// ── Signing ──────────────────────────────────────────────────

export function signEd25519(privateKey: KeyObject, message: Uint8Array): string {
  const sig = nodeSign(null, Buffer.from(message), privateKey);
  return Buffer.from(sig).toString("base64url");
}

export function signEs256Der(privateKey: KeyObject, message: Uint8Array): string {
  const sig = nodeSign("sha256", Buffer.from(message), { key: privateKey, dsaEncoding: "der" });
  return Buffer.from(sig).toString("base64url");
}

export function signEs256Raw(privateKey: KeyObject, message: Uint8Array): string {
  const sig = nodeSign("sha256", Buffer.from(message), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return Buffer.from(sig).toString("base64url");
}

// ── Mandate builder ──────────────────────────────────────────

export interface SignedMandateOptions {
  pair: AnyPair;
  deviceId?: string;
  signedAt?: string;
  nonce?: string;
  // For ES256 only: choose DER (default) or raw r||s encoding
  es256Encoding?: "der" | "raw";
  // Override pieces of the payload before signing
  overrides?: Partial<Mandate>;
}

const FIXED_DEVICE_ID = "01HDEVICEAAAAAAAAAAAAAAAAA";

const DEFAULT_NOW = "2026-05-10T08:00:00.000Z";
const DEFAULT_NOT_BEFORE = "2026-05-10T00:00:00.000Z";
const DEFAULT_NOT_AFTER = "2026-08-10T00:00:00.000Z";

export function makeMandatePayload(
  pair: AnyPair,
  overrides: Partial<Mandate> = {},
  deviceOverrides: Partial<SigningDevice> = {},
): Mandate {
  const device: SigningDevice = {
    id: FIXED_DEVICE_ID,
    alg: pair.alg,
    public_key: pair.publicKeyB64Url,
    platform: "web",
    registered_at: DEFAULT_NOT_BEFORE,
    revoked_at: null,
    ...deviceOverrides,
  };

  return {
    v: 1,
    id: "01HMANDATEAAAAAAAAAAAAAAAA",
    account_id: "01HACCOUNTAAAAAAAAAAAAAAAA",
    monthly_budget_cents: 50_000,
    daily_silent_max_cents: 10_000,
    per_action_silent_max_cents: 5_000,
    per_subscription_max_cents: 5_000,
    allowed_categories: ["email", "monitoring"],
    allowed_services: "*",
    blocked_services: [],
    step_up_triggers: {
      above_silent_max: true,
      new_category: true,
      novel_service: true,
      near_daily_limit: true,
      near_monthly_limit: true,
      velocity_anomaly: false,
      session_anomaly: true,
      recurring_commitment: true,
      cross_account_action: false,
    },
    silently_approved_services: [],
    confidence_requirements: {
      // Tracks DEFAULT_CONFIDENCE_REQUIREMENTS (or above) — the
      // lower-bound invariant added in chunk 10 rejects mandates that
      // try to LOWER any default. Tests of the invariant override this
      // map explicitly.
      provision: "medium",
      rotate: "medium",
      cancel: "low",
      amend_mandate: "high",
      release_identity: "high",
    },
    not_before: DEFAULT_NOT_BEFORE,
    not_after: DEFAULT_NOT_AFTER,
    signing_devices: [device],
    issuer: { domain: "trustysquire.ai", web_bot_auth_key: "ts-2026-q1" },
    ...overrides,
  };
}

export function buildSignedMandate(opts: SignedMandateOptions): SignedMandate {
  const payload = makeMandatePayload(opts.pair, opts.overrides);
  const message = canonicalBytes(payload);
  const sig =
    opts.pair.alg === "Ed25519"
      ? signEd25519(opts.pair.privateKey, message)
      : opts.es256Encoding === "raw"
        ? signEs256Raw(opts.pair.privateKey, message)
        : signEs256Der(opts.pair.privateKey, message);

  const signature: MandateSignature = {
    alg: opts.pair.alg,
    sig,
    signed_at: opts.signedAt ?? DEFAULT_NOW,
    nonce: opts.nonce ?? `nonce-${randomHex(8)}`,
    signing_device_id: opts.deviceId ?? FIXED_DEVICE_ID,
  };
  return { payload, signature };
}

// ── Delta builder ────────────────────────────────────────────

export interface SignedDeltaOptions {
  pair: AnyPair;
  mandate: Mandate;
  signedAt?: string;
  nonce?: string;
  deviceId?: string;
  actionOverrides?: Partial<Delta["action"]>;
  payloadOverrides?: Partial<Delta>;
}

export function buildSignedDelta(opts: SignedDeltaOptions): SignedDelta {
  const action: Delta["action"] = {
    type: "provision",
    run_id: "01HRUNAAAAAAAAAAAAAAAAAAAA",
    service: "resend",
    plan: "pro",
    cost_cents: 2000,
    recurrence: "monthly",
    ...opts.actionOverrides,
  };

  const payload: Delta = {
    v: 1,
    id: "01HDELTAAAAAAAAAAAAAAAAAAA",
    mandate_id: opts.mandate.id,
    account_id: opts.mandate.account_id,
    action,
    remember: null,
    not_before: DEFAULT_NOT_BEFORE,
    not_after: "2026-05-10T08:05:00.000Z",
    nonce: opts.nonce ?? `delta-nonce-${randomHex(8)}`,
    run_binding: computeRunBinding(action),
    ...opts.payloadOverrides,
  };

  const message = canonicalBytes(payload);
  const sig =
    opts.pair.alg === "Ed25519"
      ? signEd25519(opts.pair.privateKey, message)
      : signEs256Der(opts.pair.privateKey, message);

  const signature: DeltaSignature = {
    alg: opts.pair.alg,
    sig,
    signed_at: opts.signedAt ?? DEFAULT_NOW,
    signing_device_id: opts.deviceId ?? FIXED_DEVICE_ID,
  };
  return { payload, signature };
}

// ── Misc helpers ─────────────────────────────────────────────

function randomHex(bytes: number): string {
  return Buffer.from(randomBytes(bytes)).toString("hex");
}

export function makeDeps(overrides: Partial<MockDeps> = {}): MockDeps {
  const usedNonces = new Set<string>();
  const revokedMandates = new Set<string>();
  return {
    usedNonces,
    revokedMandates,
    recordNonce: async (n: string) => {
      usedNonces.add(n);
    },
    isNonceUsed: async (n: string) => usedNonces.has(n),
    getRecentSpend: async () => 0,
    getProvisionedServices: async () => [],
    getProvisionedCategories: async () => [],
    getRevokedMandates: async () => revokedMandates,
    now: () => new Date(DEFAULT_NOW),
    ...overrides,
  };
}

export interface MockDeps {
  usedNonces: Set<string>;
  revokedMandates: Set<string>;
  recordNonce: (n: string) => Promise<void>;
  isNonceUsed: (n: string) => Promise<boolean>;
  getRecentSpend: (accountId: string, since: Date) => Promise<number>;
  getProvisionedServices: (accountId: string) => Promise<string[]>;
  getProvisionedCategories: (accountId: string) => Promise<string[]>;
  getRevokedMandates: () => Promise<Set<string>>;
  now: () => Date;
}

export const NOW = DEFAULT_NOW;
export const DEVICE_ID = FIXED_DEVICE_ID;
export type { SignatureAlg };
