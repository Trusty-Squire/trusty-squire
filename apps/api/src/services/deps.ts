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
  MailgunHandler,
  type AliasStore,
  type EmailStore,
} from "@trusty-squire/inbox";
import {
  CredentialVault,
  InMemoryCredentialStore,
  InMemoryVaultAuditStore,
  LocalKMS,
  type CredentialStore,
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
import {
  InMemoryOAuthIdentityStore,
  PrismaOAuthIdentityStore,
  type OAuthIdentityStore,
} from "./oauth-identity-store.js";
import { getApiPrismaClient } from "./api-prisma-client.js";
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

  // Credentials + inbound mail
  credentialStore: CredentialStore;
  vault: CredentialVault;
  inbox: InboxService;
  mailgunHandler: MailgunHandler;
  resendHandler: ResendHandler;
  machineTokenStore: MachineTokenStore;
  llmUsageTracker: LLMUsageTracker;
  captchaEventStore: CaptchaEventStore;
  retentionCron: RetentionCron | null;

  // Config
  sessionSecret: string;
  customerId: string;

  // Test injection
  now?: () => Date;
}

export interface BuildInMemoryDepsOpts {
  sessionSecret: string;
  customerId: string;
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
  const vaultAuditStore = new InMemoryVaultAuditStore();
  const kms = LocalKMS.withFixedKey(Buffer.alloc(32, 0x7f));
  const vault = new CredentialVault({ store: credentialStore, audit: vaultAuditStore, kms });

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

  const mailgunHandler = new MailgunHandler({ aliasStore, emailStore });

  // rc.19 — Resend inbound. Same alias-resolution + dedupe contract
  // as the (now retired) SES path.
  const resendHandler = new ResendHandler({
    aliasStore,
    emailStore,
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
    pairingTokenStore,
    oauthIdentityStore,
    credentialStore,
    vault,
    inbox,
    mailgunHandler,
    resendHandler,
    machineTokenStore,
    llmUsageTracker,
    captchaEventStore,
    retentionCron,
    sessionSecret: opts.sessionSecret,
    customerId: opts.customerId,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };
}
