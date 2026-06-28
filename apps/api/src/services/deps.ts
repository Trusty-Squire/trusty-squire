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
import { createRequire } from "node:module";
import {
  InboxService,
  InMemoryAliasStore,
  InMemoryEmailStore,
  PrismaAliasStore,
  PrismaEmailStore,
  ResendHandler,
  type AliasStore,
  type EmailStore,
} from "@trusty-squire/inbox";
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
import { RetentionCron, type InboxPrismaClientLike } from "./retention-cron.js";
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
  inbox: InboxService;
  resendHandler: ResendHandler;
  machineTokenStore: MachineTokenStore;
  llmUsageTracker: LLMUsageTracker;
  captchaEventStore: CaptchaEventStore;
  retentionCron: RetentionCron | null;

  // Config
  sessionSecret: string;

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

  const kms = LocalKMS.withFixedKey(Buffer.alloc(32, 0x7f));
  const vault = new CredentialVault({
    store: credentialStore,
    audit: vaultAuditStore,
    kms,
    proxyAuditFailureMode: "best_effort",
  });

  // Inbox stores: Postgres-backed when INBOX_DATABASE_URL is set,
  // in-memory otherwise. The PrismaClient is loaded lazily via
  // createRequire so test runs without @prisma/client installed don't
  // fail at import.
  let aliasStore: AliasStore;
  let emailStore: EmailStore;
  let inboxPrismaForCron: InboxPrismaClientLike | null = null;
  if (process.env.INBOX_DATABASE_URL !== undefined && process.env.INBOX_DATABASE_URL.length > 0) {
    const req = createRequire(import.meta.url);
    const { PrismaClient } = req("@prisma/client") as typeof import("@prisma/client");
    const prisma = new PrismaClient({ datasourceUrl: process.env.INBOX_DATABASE_URL });
    aliasStore = new PrismaAliasStore(prisma);
    emailStore = new PrismaEmailStore(prisma);
    inboxPrismaForCron = prisma as unknown as InboxPrismaClientLike;
  } else {
    aliasStore = new InMemoryAliasStore();
    emailStore = new InMemoryEmailStore();
  }

  const aliasDomain =
    process.env.INBOX_ALIAS_DOMAIN ??
    (process.env.NODE_ENV === "production" ? "trustysquire.ai" : "test.local");
  const inbox = new InboxService({
    aliasStore,
    emailStore,
    domain: aliasDomain,
    ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
  });

  // rc.19 — Resend inbound. Same alias-resolution + dedupe contract
  // as the (now retired) SES path.
  const resendContentFetcher = buildResendReceivingFetcher();
  const resendHandler = new ResendHandler({
    aliasStore,
    emailStore,
    ...(resendContentFetcher !== undefined ? { fetchEmailContent: resendContentFetcher } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
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
    inboxPrismaForCron !== null || authPrisma !== null
      ? new RetentionCron({
          inboxPrisma: inboxPrismaForCron ?? undefined,
          authPrisma: authPrisma ?? undefined,
          ...(opts.now !== undefined ? { now: opts.now } : {}),
        })
      : null;

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
    inbox,
    resendHandler,
    machineTokenStore,
    llmUsageTracker,
    captchaEventStore,
    retentionCron,
    sessionSecret: opts.sessionSecret,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };
}

function buildResendReceivingFetcher():
  | ((emailId: string) => Promise<{ text?: string | null; html?: string | null; received_at?: string | null } | null>)
  | undefined {
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  return async (emailId) => {
    const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return {
      text: typeof data["text"] === "string" ? data["text"] : null,
      html: typeof data["html"] === "string" ? data["html"] : null,
      received_at: typeof data["created_at"] === "string" ? data["created_at"] : null,
    };
  };
}
