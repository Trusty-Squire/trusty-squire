// Composition root: wires every package together into an `ApiDeps`
// object the routes consume.
//
// For dev + tests we use in-memory implementations. Production wires
// Prisma-backed equivalents in a separate module (out-of-package).
//
// The native-provision cluster (mandate evaluator, adapter registry,
// run store, approval-token store, native adapters) was sunset in
// 0.8 — the universal browser-driven bot replaced it. What survives:
// account / session / OAuth identity / machine-token / LLM-usage /
// captcha-event / inbox / vault.

import { Buffer } from "node:buffer";
import {
  CredentialVault,
  InMemoryCredentialStore,
  InMemoryVaultAuditStore,
  LocalKMS,
  type CredentialStore,
  type VaultAuditStore,
} from "@trusty-squire/vault";
import {
  InMemoryAgentSessionStore,
  type AgentSessionStore,
} from "../auth/agent.js";
import {
  InMemoryPairingTokenStore,
  type PairingTokenStore,
} from "../auth/pairing-token.js";
import { PrismaPairingTokenStore } from "../auth/prisma-pairing-token.js";
import { PrismaSessionStore } from "../auth/prisma-session-store.js";
import { PrismaAgentSessionStore } from "../auth/prisma-agent-session-store.js";
import { PrismaAccountStore } from "./prisma-account-store.js";
import { PrismaCredentialStore } from "./prisma-credential-store.js";
import { PrismaVaultAuditStore } from "./prisma-vault-audit-store.js";
import { PrismaEgressGrantStore } from "./prisma-egress-grant-store.js";
import {
  InMemoryEgressGrantStore,
  type EgressGrantStore,
} from "./egress-grant.js";
import {
  InMemoryOAuthIdentityStore,
  PrismaOAuthIdentityStore,
  type OAuthIdentityStore,
} from "./oauth-identity-store.js";
import { getApiPrismaClient } from "./api-prisma-client.js";
import {
  collectMetrics,
  makeCachedCollector,
  type MetricsSnapshot,
} from "./metrics.js";
import {
  PrismaFunnelStatsStore,
  ZeroFunnelStatsStore,
  type FunnelStatsStore,
} from "./funnel-stats.js";
import { PrismaMachineTokenStore } from "./prisma-machine-tokens.js";
import { PrismaLLMUsageTracker } from "./prisma-llm-usage-tracker.js";
import {
  InMemoryCaptchaEventStore,
  PrismaCaptchaEventStore,
  type CaptchaEventStore,
} from "./captcha-events.js";
import { RetentionCron } from "./retention-cron.js";
import {
  InMemorySessionStore,
  type SessionStore,
} from "../auth/session.js";
import {
  InMemoryAccountStore,
  type AccountStore,
} from "./in-memory-account-store.js";
import {
  InMemoryMachineTokenStore,
  type MachineTokenStore,
} from "./machine-tokens.js";
import {
  InMemoryLLMUsageTracker,
  type LLMUsageTracker,
} from "./llm-usage-tracker.js";

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
  egressGrantStore: EgressGrantStore;
  machineTokenStore: MachineTokenStore;
  llmUsageTracker: LLMUsageTracker;
  captchaEventStore: CaptchaEventStore;
  retentionCron: RetentionCron | null;

  // Config
  sessionSecret: string;

  // Bounded DB liveness probe for the /readyz readiness endpoint — a cheap,
  // timeout-capped query so an external monitor catches a wedged DB (the 256MB
  // OOM failure mode). Resolves true when the DB answers, false on error/timeout.
  // Always true for the no-DB in-memory dev path.
  pingDb: () => Promise<boolean>;

  // Funnel + health gauges for the private Prometheus exporter
  // (metrics-server.ts). Defined only on the Prisma path — the no-DB
  // in-memory dev path has nothing real to count, so it stays undefined
  // and the exporter isn't started. Wrapped in a TTL cache so frequent
  // scrapes don't hammer the DB.
  collectMetrics?: () => Promise<MetricsSnapshot>;

  // Test injection
  now?: () => Date;
}

export interface BuildInMemoryDepsOpts {
  sessionSecret: string;
  now?: () => Date;
  // Inbox poll cadence in ms. Tests run with 1ms to keep wait loops fast;
  // omit in prod to use the default 2000ms.
  pollIntervalMs?: number;
}

export function buildInMemoryDeps(opts: BuildInMemoryDepsOpts): ApiDeps {
  // Auth Prisma client — loaded once and shared across the account,
  // session, agent-session, pairing-token, machine-token, and LLM
  // stores. Conditional on AUTH_DATABASE_URL so tests/local dev use
  // the in-memory stores.
  const authDatabaseUrl = process.env.AUTH_DATABASE_URL;
  const authPrisma =
    authDatabaseUrl !== undefined && authDatabaseUrl.length > 0
      ? getApiPrismaClient(authDatabaseUrl)
      : null;

  const accountStore: AccountStore =
    authPrisma !== null
      ? new PrismaAccountStore(authPrisma)
      : new InMemoryAccountStore();
  const sessionStore: SessionStore =
    authPrisma !== null
      ? new PrismaSessionStore(authPrisma)
      : new InMemorySessionStore();
  const agentSessionStore: AgentSessionStore =
    authPrisma !== null
      ? new PrismaAgentSessionStore(authPrisma)
      : new InMemoryAgentSessionStore();

  const pairingTokenStore: PairingTokenStore =
    authPrisma !== null
      ? new PrismaPairingTokenStore(authPrisma)
      : new InMemoryPairingTokenStore();

  const oauthIdentityStore: OAuthIdentityStore =
    authPrisma !== null
      ? new PrismaOAuthIdentityStore(authPrisma)
      : new InMemoryOAuthIdentityStore();

  const credentialStore: CredentialStore =
    authPrisma !== null
      ? new PrismaCredentialStore(authPrisma)
      : new InMemoryCredentialStore();
  const vaultAuditStore: VaultAuditStore =
    authPrisma !== null
      ? new PrismaVaultAuditStore(authPrisma)
      : new InMemoryVaultAuditStore();
  // Panel 1 funnel: Prisma-backed when the auth DB is wired, else a
  // zero store (the funnel is a prod operator feature).
  const funnelStatsStore: FunnelStatsStore =
    authPrisma !== null
      ? new PrismaFunnelStatsStore(authPrisma)
      : new ZeroFunnelStatsStore();

  // Egress grants: Prisma-backed when the auth DB is wired, else in-memory.
  // Grants are re-mintable, so in-memory loss on restart is tolerable in dev;
  // production persists so a deployed workload's grant survives an API redeploy.
  const egressGrantStore: EgressGrantStore =
    authPrisma !== null
      ? new PrismaEgressGrantStore(authPrisma)
      : new InMemoryEgressGrantStore();

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
    authPrisma !== null
      ? new PrismaMachineTokenStore(authPrisma)
      : new InMemoryMachineTokenStore();

  const llmUsageTracker: LLMUsageTracker =
    authPrisma !== null
      ? new PrismaLLMUsageTracker(authPrisma)
      : new InMemoryLLMUsageTracker();

  const captchaEventStore: CaptchaEventStore =
    authPrisma !== null
      ? new PrismaCaptchaEventStore(authPrisma)
      : new InMemoryCaptchaEventStore();

  const retentionCron: RetentionCron | null =
    authPrisma !== null
      ? new RetentionCron({
          authPrisma: authPrisma ?? undefined,
          ...(opts.now !== undefined ? { now: opts.now } : {}),
        })
      : null;

  const pingDb = async (): Promise<boolean> => {
    // No DB wired (in-memory dev/test) → always ready.
    if (authPrisma === null) return true;
    try {
      // Cheap DB touch (the narrowed client has no $queryRaw); time-capped so a
      // wedged/unreachable DB fails fast instead of hanging the probe.
      await Promise.race([
        authPrisma.machineToken.count({ where: { token: "__readyz_probe__" } }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("db ping timeout")), 2000),
        ),
      ]);
      return true;
    } catch {
      return false;
    }
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
    egressGrantStore,
    machineTokenStore,
    llmUsageTracker,
    captchaEventStore,
    retentionCron,
    sessionSecret: opts.sessionSecret,
    pingDb,
    ...(collectMetricsFn !== undefined ? { collectMetrics: collectMetricsFn } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };
}
