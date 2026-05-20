// Composition root: wires every package together into an `ApiDeps`
// object the routes consume.
//
// For dev + tests we use in-memory implementations. Production wires
// Prisma-backed equivalents in a separate module (out-of-package).

import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import {
  InMemoryAdapterRegistry,
  InMemoryRunStore,
  type AdapterRegistry,
  type RunStore,
  type VaultClient,
} from "@trusty-squire/runtime";
import { resendDemoManifest } from "@trusty-squire/adapter-resend";
import {
  InboxService,
  InMemoryAliasStore,
  InMemoryEmailStore,
  PrismaAliasStore,
  PrismaEmailStore,
  SesHandler,
  MailgunHandler,
  type AliasStore,
  type EmailStore,
  type RawEmailFetcher,
} from "@trusty-squire/inbox";
import {
  CredentialVault,
  InMemoryCredentialStore,
  InMemoryVaultAuditStore,
  LocalKMS,
  type CredentialStore,
} from "@trusty-squire/vault";
import {
  MandateValidator,
  VouchflowVerifier,
  type MandateValidatorDeps,
} from "@trusty-squire/mandate-validator";
import {
  InMemoryAgentSessionStore,
  type AgentSessionStore,
} from "../auth/agent.js";
import {
  InMemoryApprovalTokenStore,
  type ApprovalTokenStore,
} from "../auth/approval-token.js";
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
import { getApiPrismaClient, type ApiPrismaClient } from "./api-prisma-client.js";
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
  approvalTokenStore: ApprovalTokenStore;
  pairingTokenStore: PairingTokenStore;
  oauthIdentityStore: OAuthIdentityStore;

  // Runtime
  runStore: RunStore;
  adapterRegistry: AdapterRegistry;
  vault: VaultClient;
  credentialStore: CredentialStore;
  inbox: InboxService;
  sesHandler: SesHandler;
  mailgunHandler: MailgunHandler;
  machineTokenStore: MachineTokenStore;
  llmUsageTracker: LLMUsageTracker;
  captchaEventStore: CaptchaEventStore;
  // Hourly retention cron — purges inbox bodies after 7d, deletes
  // metadata after 90d, sweeps stale pairing tokens, trims old LLM
  // events. Null when no DB is wired (in-memory mode); otherwise
  // started by the server boot path.
  retentionCron: RetentionCron | null;

  // Mandate validation
  mandateValidator: MandateValidator;
  validatorDeps: MandateValidatorDeps;
  vouchflowVerifier: VouchflowVerifier;

  // Config
  sessionSecret: string;
  customerId: string;

  // Test injection
  now?: () => Date;
}

export interface BuildInMemoryDepsOpts {
  sessionSecret: string;
  customerId: string;
  // Override the Vouchflow JWKS for tests (so we can sign locally).
  vouchflowVerifier?: VouchflowVerifier;
  now?: () => Date;
  // Inbox poll cadence in ms. Tests run with 1ms to keep wait loops fast;
  // omit in prod to use the default 2000ms.
  pollIntervalMs?: number;
}

export function buildInMemoryDeps(opts: BuildInMemoryDepsOpts): ApiDeps {
  const approvalTokenStore = new InMemoryApprovalTokenStore();

  // Auth Prisma client — loaded once and shared across the account,
  // session, agent-session, pairing-token, machine-token, and LLM
  // stores. Conditional on AUTH_DATABASE_URL so tests/local dev use
  // the in-memory stores.
  const authDatabaseUrl = process.env.AUTH_DATABASE_URL;
  const authPrisma =
    authDatabaseUrl !== undefined && authDatabaseUrl.length > 0
      ? getApiPrismaClient(authDatabaseUrl)
      : null;

  // Identity / auth stores. Postgres-backed when a DB is wired so
  // accounts, web sessions, and paired CLI sessions survive restarts
  // and redeploys; in-memory for tests + DB-less local dev.
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

  const runStore = new InMemoryRunStore();
  const adapterRegistry = new InMemoryAdapterRegistry();

  // Demo mode preloads the mock-target Resend manifest so `pnpm demo`
  // can run the full provisioning loop end-to-end without a separate
  // registry-api process. Production wires a RegistryClient against
  // the live registry-api in its own composition root.
  if (process.env.DEMO_MODE === "true") {
    adapterRegistry.register(resendDemoManifest);
  }

  // Credential store: Postgres-backed when a DB is wired so the vault's
  // contents survive restarts; in-memory for tests + DB-less dev. The
  // audit store stays in-memory for now (rate-limit window is
  // per-process; durable audit is a follow-up).
  const credentialStore: CredentialStore =
    authPrisma !== null
      ? new PrismaCredentialStore(authPrisma)
      : new InMemoryCredentialStore();
  const vaultAuditStore = new InMemoryVaultAuditStore();
  const kms = LocalKMS.withFixedKey(Buffer.alloc(32, 0x7f));
  const vault = new CredentialVault({ store: credentialStore, audit: vaultAuditStore, kms });

  // Inbox stores: Postgres-backed when INBOX_DATABASE_URL is set,
  // in-memory otherwise. Tests + the demo use in-memory; prod wires
  // Postgres via the Fly secret. The PrismaClient is loaded lazily via
  // createRequire so test runs without @prisma/client installed don't
  // fail at import.
  let aliasStore: AliasStore;
  let emailStore: EmailStore;
  // Captured for the retention cron — null in in-memory mode.
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

  // Alias domain. In prod we issue aliases under trustysquire.ai so SES
  // inbound (which has a catch-all rule for all 4 of our domains) routes
  // them in. Local/test mode falls back to test.local so unit tests don't
  // accidentally hit real DNS resolution.
  const aliasDomain =
    process.env.INBOX_ALIAS_DOMAIN ??
    (process.env.NODE_ENV === "production" ? "trustysquire.ai" : "test.local");
  const inbox = new InboxService({
    aliasStore,
    emailStore,
    domain: aliasDomain,
    // pollIntervalMs intentionally omitted in prod — default is 2s which
    // is the right cadence for long-poll endpoints serving the universal
    // signup bot. Tests can wire this down through buildInMemoryDeps opts.
    ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
  });

  // S3 fetcher for inbound SES emails. In production we use a real S3 client;
  // tests/dev get a mock that returns empty buffers. This is the same fetch
  // path the ses-webhook route uses for personal-Gmail forwarding, just
  // exposed through the SesHandler abstraction so the inbox-store fallback
  // works too. Lazy-init keeps buildInMemoryDeps sync and avoids loading the
  // AWS SDK in test runs.
  let fetcher: RawEmailFetcher;
  if (process.env.NODE_ENV === "production") {
    type S3ClientCtor = typeof import("@aws-sdk/client-s3").S3Client;
    type GetObjectCmdCtor = typeof import("@aws-sdk/client-s3").GetObjectCommand;
    let s3Bits: Promise<{ s3: InstanceType<S3ClientCtor>; GetObjectCommand: GetObjectCmdCtor }> | null = null;
    const getS3 = (): Promise<{ s3: InstanceType<S3ClientCtor>; GetObjectCommand: GetObjectCmdCtor }> => {
      if (s3Bits === null) {
        s3Bits = (async () => {
          const mod = await import("@aws-sdk/client-s3");
          return {
            s3: new mod.S3Client({ region: process.env.AWS_REGION ?? "us-east-1" }),
            GetObjectCommand: mod.GetObjectCommand,
          };
        })();
      }
      return s3Bits;
    };
    fetcher = {
      async fetch(bucket: string, key: string): Promise<Buffer> {
        const { s3, GetObjectCommand } = await getS3();
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (res.Body === undefined) throw new Error("s3_empty_body");
        const chunks: Buffer[] = [];
        // @ts-expect-error — AWS SDK v3 stream typing
        for await (const chunk of res.Body) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
      },
    };
  } else {
    fetcher = { fetch: async () => Buffer.from("") };
  }

  const sesHandler = new SesHandler({
    aliasStore,
    emailStore,
    fetcher,
  });

  const mailgunHandler = new MailgunHandler({
    aliasStore,
    emailStore,
  });

  const usedNonces = new Set<string>();
  const revokedMandates = new Set<string>();
  const validatorDeps: MandateValidatorDeps = {
    recordNonce: async (n) => {
      usedNonces.add(n);
    },
    isNonceUsed: async (n) => usedNonces.has(n),
    getRecentSpend: async () => 0,
    getProvisionedServices: async () => [],
    getProvisionedCategories: async () => [],
    getRevokedMandates: async () => revokedMandates,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };

  const vouchflowVerifier =
    opts.vouchflowVerifier ?? new VouchflowVerifier({ customerId: opts.customerId });
  const mandateValidator = new MandateValidator(validatorDeps, vouchflowVerifier);

  // Machine tokens — the bot-internal credential for LLM proxy + inbox
  // alias service. Bound to an account at install-claim time; free up
  // to ACCOUNT_FREE_QUOTA signups before payment_required.
  const machineTokenStore: MachineTokenStore =
    authPrisma !== null
      ? new PrismaMachineTokenStore(authPrisma)
      : new InMemoryMachineTokenStore();

  // Rolling per-machine-token LLM-call counter. Server-side ceiling so a
  // runaway client can't drill our wallet past the per-signup cap the
  // bot enforces on itself.
  const llmUsageTracker: LLMUsageTracker =
    authPrisma !== null
      ? new PrismaLLMUsageTracker(authPrisma)
      : new InMemoryLLMUsageTracker();

  // Captcha-encounter ledger. Same Prisma-or-in-memory split — tests
  // and DB-less local dev get the in-memory store; prod writes to the
  // CaptchaEvent table. See captcha-events.ts for the analytics
  // motivation.
  const captchaEventStore: CaptchaEventStore =
    authPrisma !== null
      ? new PrismaCaptchaEventStore(authPrisma)
      : new InMemoryCaptchaEventStore();

  // Retention cron only runs when at least one DB is wired — there's
  // nothing to purge from in-memory stores.
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
    approvalTokenStore,
    pairingTokenStore,
    oauthIdentityStore,
    runStore,
    adapterRegistry,
    vault,
    credentialStore,
    inbox,
    sesHandler,
    mailgunHandler,
    machineTokenStore,
    llmUsageTracker,
    captchaEventStore,
    retentionCron,
    mandateValidator,
    validatorDeps,
    vouchflowVerifier,
    sessionSecret: opts.sessionSecret,
    customerId: opts.customerId,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };
}
