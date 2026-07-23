// Composition root: wires every package together into an `ApiDeps`
// object the routes consume.
//
// For dev + tests we use in-memory implementations. Production wires
// Prisma-backed equivalents in a separate module (out-of-package).
//
// The native-provision cluster (mandate evaluator, adapter registry,
// run store, approval-token store, native adapters) was sunset in
// 0.8 — the universal browser-driven bot replaced it. What survives:
// account / session / OAuth identity / machine-token /
// captcha-event / inbox / vault.

import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import {
  CredentialVault,
  InMemoryCredentialStore,
  InMemoryVaultAuditStore,
  LocalKMS,
  type CredentialStore,
  type VaultAuditStore,
} from "@trusty-squire/vault";
import { InMemoryAgentSessionStore, type AgentSessionStore } from "../auth/agent.js";
import { InMemoryPairingTokenStore, type PairingTokenStore } from "../auth/pairing-token.js";
import { PrismaPairingTokenStore } from "../auth/prisma-pairing-token.js";
import { PrismaSessionStore } from "../auth/prisma-session-store.js";
import { PrismaAgentSessionStore } from "../auth/prisma-agent-session-store.js";
import { PrismaAccountStore } from "./prisma-account-store.js";
import { PrismaCredentialStore } from "./prisma-credential-store.js";
import { PrismaVaultAuditStore } from "./prisma-vault-audit-store.js";
import { PrismaEgressGrantStore } from "./prisma-egress-grant-store.js";
import { InMemoryEgressGrantStore, type EgressGrantStore } from "./egress-grant.js";
import {
  InMemoryOAuthIdentityStore,
  PrismaOAuthIdentityStore,
  type OAuthIdentityStore,
} from "./oauth-identity-store.js";
import { getApiPrismaClient } from "./api-prisma-client.js";
import { collectMetrics, makeCachedCollector, type MetricsSnapshot } from "./metrics.js";
import {
  PrismaFunnelStatsStore,
  ZeroFunnelStatsStore,
  type FunnelStatsStore,
} from "./funnel-stats.js";
import { PrismaMachineTokenStore } from "./prisma-machine-tokens.js";
import {
  InMemoryCaptchaEventStore,
  PrismaCaptchaEventStore,
  type CaptchaEventStore,
} from "./captcha-events.js";
import { RetentionCron } from "./retention-cron.js";
import { InMemorySessionStore, type SessionStore } from "../auth/session.js";
import { InMemoryAccountStore, type AccountStore } from "./in-memory-account-store.js";
import { InMemoryMachineTokenStore, type MachineTokenStore } from "./machine-tokens.js";
import {
  InMemoryE2ECredentialStore,
  type E2ECredentialStore,
} from "./in-memory-e2e-credential-store.js";
import { PrismaE2ECredentialStore } from "./prisma-e2e-credential-store.js";
import {
  InMemoryPaymentAuditStore,
  type PaymentAuditStore,
} from "./in-memory-payment-audit-store.js";
import { PrismaPaymentAuditStore } from "./prisma-payment-audit-store.js";

export interface ApiDeps {
  // Identity / auth
  accountStore: AccountStore;
  sessionStore: SessionStore;
  agentSessionStore: AgentSessionStore;
  pairingTokenStore: PairingTokenStore;
  oauthIdentityStore: OAuthIdentityStore;

  // Panel 1 acquisition-funnel: API-side counts (accounts + tokens).
  funnelStatsStore: FunnelStatsStore;

  // Credentials + inbound mail
  credentialStore: CredentialStore;
  vault: CredentialVault;
  e2eCredentialStore: E2ECredentialStore;
  paymentAuditStore: PaymentAuditStore;
  egressGrantStore: EgressGrantStore;
  machineTokenStore: MachineTokenStore;
  captchaEventStore: CaptchaEventStore;
  retentionCron: RetentionCron | null;

  // Config
  sessionSecret: string;

  // Bounded DB liveness probe for the /readyz readiness endpoint — a cheap,
  // timeout-capped query so an external monitor catches a wedged DB (the 256MB
  // OOM failure mode). Resolves true when the DB answers, false on error/timeout.
  // Always true for the no-DB in-memory dev path.
  pingDb: (observe?: DbProbeObserver) => Promise<boolean>;

  // Funnel + health gauges for the private Prometheus exporter
  // (metrics-server.ts). Defined only on the Prisma path — the no-DB
  // in-memory dev path has nothing real to count, so it stays undefined
  // and the exporter isn't started. Wrapped in a TTL cache so frequent
  // scrapes don't hammer the DB.
  collectMetrics?: () => Promise<MetricsSnapshot>;

  // Test injection
  now?: () => Date;
}

export type DbProbeFailureClass = "timeout" | "database_error" | "unknown_error";

export type DbProbeAttempt =
  | {
      attempt: 1 | 2;
      outcome: "success";
      duration_ms: number;
    }
  | {
      attempt: 1 | 2;
      outcome: "failure";
      duration_ms: number;
      failure_class: DbProbeFailureClass;
      error_code?: string;
    };

export type DbProbeObserver = (result: DbProbeAttempt) => void | Promise<void>;

export interface BuildInMemoryDepsOpts {
  sessionSecret: string;
  now?: () => Date;
  // Inbox poll cadence in ms. Tests run with 1ms to keep wait loops fast;
  // omit in prod to use the default 2000ms.
  pollIntervalMs?: number;
}

// Run a bounded liveness probe with a single retry. A genuinely wedged DB fails
// BOTH attempts — the wedge is sustained — so /readyz still goes 503 (within
// ~2×timeout). A momentary blip — a checkpoint write, a GC pause on the API
// machine, a one-off network hiccup — clears on the retry, so a single 2s flap
// no longer pages an on-call human for a service that self-recovers in seconds.
export async function probeWithRetry(
  probe: () => Promise<void>,
  retryDelayMs: number,
  observe?: DbProbeObserver,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const startedAt = performance.now();
    try {
      await probe();
      notifyProbeObserver(observe, {
        attempt: (attempt + 1) as 1 | 2,
        outcome: "success",
        duration_ms: elapsedMs(startedAt),
      });
      return true;
    } catch (error) {
      const failure = classifyDbProbeFailure(error);
      notifyProbeObserver(observe, {
        attempt: (attempt + 1) as 1 | 2,
        outcome: "failure",
        duration_ms: elapsedMs(startedAt),
        failure_class: failure.failure_class,
        ...(failure.error_code !== undefined ? { error_code: failure.error_code } : {}),
      });
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  return false;
}

class DbProbeTimeoutError extends Error {
  override readonly name = "DbProbeTimeoutError";
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

function classifyDbProbeFailure(error: unknown): {
  failure_class: DbProbeFailureClass;
  error_code?: string;
} {
  if (error instanceof DbProbeTimeoutError || getErrorName(error) === "DbProbeTimeoutError") {
    return { failure_class: "timeout" };
  }

  const errorCode = getSafePrismaErrorCode(error);
  if (error instanceof Error || errorCode !== undefined) {
    return {
      failure_class: "database_error",
      ...(errorCode !== undefined ? { error_code: errorCode } : {}),
    };
  }
  return { failure_class: "unknown_error" };
}

function getErrorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("name" in error)) return undefined;
  return typeof error.name === "string" ? error.name : undefined;
}

function getSafePrismaErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" && /^P\d{4}$/.test(code) ? code : undefined;
}

function notifyProbeObserver(observe: DbProbeObserver | undefined, result: DbProbeAttempt): void {
  if (observe === undefined) return;
  try {
    const observation = observe(result);
    if (observation !== undefined) {
      void observation.catch(() => {
        // Diagnostics must never turn a healthy database probe into an outage.
      });
    }
  } catch {
    // Diagnostics must never turn a healthy database probe into an outage.
  }
}

export function buildInMemoryDeps(opts: BuildInMemoryDepsOpts): ApiDeps {
  // Auth Prisma client — loaded once and shared across the account,
  // session, agent-session, pairing-token, and machine-token stores.
  // Conditional on AUTH_DATABASE_URL so tests/local dev use the
  // in-memory stores.
  const authDatabaseUrl = process.env.AUTH_DATABASE_URL;
  const authPrisma =
    authDatabaseUrl !== undefined && authDatabaseUrl.length > 0
      ? getApiPrismaClient(authDatabaseUrl)
      : null;

  const accountStore: AccountStore =
    authPrisma !== null ? new PrismaAccountStore(authPrisma) : new InMemoryAccountStore();
  const sessionStore: SessionStore =
    authPrisma !== null ? new PrismaSessionStore(authPrisma) : new InMemorySessionStore();
  const agentSessionStore: AgentSessionStore =
    authPrisma !== null ? new PrismaAgentSessionStore(authPrisma) : new InMemoryAgentSessionStore();

  const pairingTokenStore: PairingTokenStore =
    authPrisma !== null ? new PrismaPairingTokenStore(authPrisma) : new InMemoryPairingTokenStore();

  const oauthIdentityStore: OAuthIdentityStore =
    authPrisma !== null
      ? new PrismaOAuthIdentityStore(authPrisma)
      : new InMemoryOAuthIdentityStore();

  const credentialStore: CredentialStore =
    authPrisma !== null ? new PrismaCredentialStore(authPrisma) : new InMemoryCredentialStore();
  const vaultAuditStore: VaultAuditStore =
    authPrisma !== null ? new PrismaVaultAuditStore(authPrisma) : new InMemoryVaultAuditStore();
  const e2eCredentialStore: E2ECredentialStore =
    authPrisma !== null
      ? new PrismaE2ECredentialStore(authPrisma)
      : new InMemoryE2ECredentialStore(opts.now);
  const paymentAuditStore: PaymentAuditStore =
    authPrisma !== null
      ? new PrismaPaymentAuditStore(authPrisma)
      : new InMemoryPaymentAuditStore(opts.now);
  // Panel 1 funnel: Prisma-backed when the auth DB is wired, else a
  // zero store (the funnel is a prod operator feature).
  const funnelStatsStore: FunnelStatsStore =
    authPrisma !== null ? new PrismaFunnelStatsStore(authPrisma) : new ZeroFunnelStatsStore();

  // Egress grants: Prisma-backed when the auth DB is wired, else in-memory.
  // Grants are re-mintable, so in-memory loss on restart is tolerable in dev;
  // production persists so a deployed workload's grant survives an API redeploy.
  const egressGrantStore: EgressGrantStore =
    authPrisma !== null ? new PrismaEgressGrantStore(authPrisma) : new InMemoryEgressGrantStore();

  // KMS master key — wraps every credential's KEK. In PRODUCTION it MUST come
  // from LOCAL_KMS_KEY and MUST NOT be the hardcoded dev key: that key is a
  // constant in this open-source repo, so encrypting the prod vault under it
  // makes every stored secret decryptable by anyone with the repo + the DB.
  // Fail closed in prod (mirrors the SESSION_JWT_SECRET guard); the hardcoded
  // 0x7f key survives ONLY for the no-key dev/test path (disposable data).
  let kms: LocalKMS;
  if (process.env.NODE_ENV === "production") {
    if ((process.env.LOCAL_KMS_KEY ?? "").length === 0) {
      throw new Error(
        "LOCAL_KMS_KEY must be set in production — refusing to encrypt the vault " +
          "with a non-durable/dev key. Generate one: " +
          `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      );
    }
    kms = LocalKMS.fromEnv();
  } else if ((process.env.LOCAL_KMS_KEY ?? "").length > 0) {
    // Non-prod but an explicit key is set (a dev pointing at a real DB) — honor it.
    kms = LocalKMS.fromEnv();
  } else {
    // No key + non-prod: deterministic dev/test key, no env required. The data
    // is in-memory/disposable here; never reached in production.
    kms = LocalKMS.withFixedKey(Buffer.alloc(32, 0x7f));
  }
  const vault = new CredentialVault({
    store: credentialStore,
    audit: vaultAuditStore,
    kms,
    proxyAuditFailureMode: "best_effort",
  });

  const machineTokenStore: MachineTokenStore =
    authPrisma !== null ? new PrismaMachineTokenStore(authPrisma) : new InMemoryMachineTokenStore();

  const captchaEventStore: CaptchaEventStore =
    authPrisma !== null ? new PrismaCaptchaEventStore(authPrisma) : new InMemoryCaptchaEventStore();

  const retentionCron: RetentionCron | null =
    authPrisma !== null
      ? new RetentionCron({
          authPrisma: authPrisma ?? undefined,
          ...(opts.now !== undefined ? { now: opts.now } : {}),
        })
      : null;

  const pingDb = async (observe?: DbProbeObserver): Promise<boolean> => {
    // No DB wired (in-memory dev/test) → always ready.
    if (authPrisma === null) return true;
    // Cheap DB touch (the narrowed client has no $queryRaw); time-capped so a
    // wedged/unreachable DB fails fast instead of hanging the probe.
    const probe = async (): Promise<void> => {
      await Promise.race([
        authPrisma.machineToken.count({ where: { token: "__readyz_probe__" } }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new DbProbeTimeoutError("database probe timed out")), 2000),
        ),
      ]);
    };
    // One retry absorbs a single transient blip; a real wedge fails both.
    return probeWithRetry(probe, 250, observe);
  };

  // Metrics exporter only makes sense against a real DB. 15s TTL matches a
  // typical Prometheus scrape interval, so back-to-back scrapes share one
  // count pass.
  const collectMetricsFn: (() => Promise<MetricsSnapshot>) | undefined =
    authPrisma !== null
      ? makeCachedCollector(
          () => collectMetrics(authPrisma, pingDb),
          15000,
          () => Date.now(),
        )
      : undefined;

  return {
    accountStore,
    sessionStore,
    agentSessionStore,
    funnelStatsStore,
    pairingTokenStore,
    oauthIdentityStore,
    credentialStore,
    vault,
    e2eCredentialStore,
    paymentAuditStore,
    egressGrantStore,
    machineTokenStore,
    captchaEventStore,
    retentionCron,
    sessionSecret: opts.sessionSecret,
    pingDb,
    ...(collectMetricsFn !== undefined ? { collectMetrics: collectMetricsFn } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };
}
