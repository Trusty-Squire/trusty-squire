// Lazy loader for the API's Prisma client.
//
// The schema lives at apps/api/prisma/schema.prisma and generates to
// apps/api/node_modules/.prisma/api-client (custom output, kept from when
// a second schema shared the workspace's default @prisma/client).
//
// We createRequire so test runs without an applied migration don't
// fail at import; the in-memory fallback handles them.

import { createRequire } from "node:module";

// Minimal structural type — just what our stores call. Keeps the type
// surface narrow even though the real generated client has hundreds of
// methods.
// Shape returned by machineToken read/write ops. The asn_* fields are
// nullable optionals — the underlying schema makes them nullable
// columns, and older rows (issued before the migration) come back as
// nulls. Callers that don't care about asn ignore them.
interface MachineTokenRow {
  token: string;
  created_at: Date;
  last_used_at: Date | null;
  paired_account_id: string | null;
  asn_class?: string | null;
  asn_number?: string | null;
  asn_org?: string | null;
  asn_country?: string | null;
}

// ── account account-layer row shapes ──────────────────────────
// Hand-typed structural rows for the account/session/agent stores,
// matching the new Prisma models. Same narrow-surface discipline as
// MachineTokenRow above.

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  default_vault: string | null;
  created_at: Date;
  stripe_customer_id: string | null;
  subscription_status: string;
  subscription_id: string | null;
  current_period_end: Date | null;
  cancel_at: Date | null;
}

interface OAuthIdentityRow {
  id: string;
  account_id: string;
  provider: string;
  provider_user_id: string;
  email: string;
  created_at: Date;
}


interface WebSessionRow {
  id: string;
  account_id: string;
  jwt_id: string;
  issued_at: Date;
  last_active_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  revocation_reason: string | null;
  ip: string | null;
  user_agent: string | null;
}

interface AgentSessionRow {
  id: string;
  account_id: string;
  token_hash: string;
  agent_identity: string | null;
  agent_version: string | null;
  issued_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  use_count: number;
  revoked_at: Date | null;
  revocation_reason: string | null;
}

interface CredentialRow {
  id: string;
  reference: string;
  account_id: string;
  subscription_id: string;
  type: string | null;
  env_var_suggestion: string | null;
  label: string;
  field_names: string[];
  allowed_hosts: string[];
  ciphertext: Buffer;
  encrypted_dek: Buffer;
  account_kek_blob: Buffer;
  algorithm: string;
  metadata: unknown;
  rotated_at: Date | null;
  retrieval_count: number;
  last_retrieved_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
}

interface VaultAuditEventRow {
  id: string;
  account_id: string;
  type: string;
  payload: unknown;
  emitted_at: Date;
}

interface E2ECredentialRow {
  id: string;
  account_id: string;
  label: string;
  blob: string;
  created_at: Date;
  updated_at: Date;
}

interface PaymentAuditEventRow {
  id: string;
  account_id: string;
  merchant: string;
  amount_cents: number;
  currency: string;
  last4: string;
  status: string;
  mandate_id: string | null;
  created_at: Date;
}

interface EgressGrantRow {
  id: string;
  account_id: string;
  credential_ref: string;
  token_hash: string;
  rate_limit_per_hour: number;
  spend_cap_usd: number | null;
  created_at: Date;
  revoked_at: Date | null;
}

export interface ApiPrismaClient {
  machineToken: {
    create(args: { data: Record<string, unknown> }): Promise<MachineTokenRow>;
    findUnique(args: { where: { token: string } }): Promise<MachineTokenRow | null>;
    update(args: { where: { token: string }; data: Record<string, unknown> }): Promise<MachineTokenRow>;
    updateMany(args: { where: { token: string }; data: Record<string, unknown> }): Promise<{ count: number }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
    // Funnel: tokens issued in a window (Panel 1, GET /v1/admin/funnel).
    count(args: { where: Record<string, unknown> }): Promise<number>;
  };
  // Captcha encounter ledger. Tightly typed for create() because that's
  // all PrismaCaptchaEventStore uses; readers (analytics queries) will
  // either come through raw SQL or use prisma directly via the full
  // generated client. Keeping the structural surface narrow protects
  // us from accidentally depending on Prisma internals here.
  captchaEvent: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    // Metrics exporter: total captcha encounters.
    count(args?: { where?: Record<string, unknown> }): Promise<number>;
  };
  pairingToken: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    findUnique(args: { where: { token: string } }): Promise<{
      token: string;
      created_at: Date;
      expires_at: Date;
      status: string;
      agent_identity: string | null;
      agent_session_raw_token: string | null;
      account_id: string | null;
      machine_token: string | null;
    } | null>;
    update(args: { where: { token: string }; data: Record<string, unknown> }): Promise<{
      token: string;
      created_at: Date;
      expires_at: Date;
      status: string;
      agent_identity: string | null;
      agent_session_raw_token: string | null;
      account_id: string | null;
      machine_token: string | null;
    }>;
    // updateMany powers race-safe single-use claim: update only if
    // (status, expires_at) match. Returns { count: 0 } when guards
    // fire — surfaced to the caller as "claim failed", no throw.
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  receivedEmail?: {
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  };

  // ── account account layer ─────────────────────────────────────
  account: {
    create(args: { data: Record<string, unknown> }): Promise<AccountRow>;
    findUnique(args: {
      where: { id: string } | { email: string };
    }): Promise<AccountRow | null>;
    // Billing: map a Stripe customer back to its account. stripe_customer_id
    // is not a DB-unique column (see schema note), so this is findFirst, not
    // findUnique — uniqueness is guaranteed by the webhook write path.
    findFirst(args: { where: Record<string, unknown> }): Promise<AccountRow | null>;
    // Billing: the Stripe webhook flips subscription_status (+ the
    // customer/subscription ids) on the mapped account.
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<AccountRow>;
    // Hard delete — cascades OAuthIdentity, WebSession, AgentSession via
    // FK onDelete: Cascade.
    delete(args: { where: { id: string } }): Promise<AccountRow>;
    // Funnel (Panel 1): accounts created in a window + rows for the
    // daily new-accounts series. `where` carries created_at range and an
    // optional id notIn (test/demo exclusion).
    count(args: { where: Record<string, unknown> }): Promise<number>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
    }): Promise<AccountRow[]>;
  };
  oAuthIdentity: {
    create(args: { data: Record<string, unknown> }): Promise<OAuthIdentityRow>;
    findUnique(args: {
      where: Record<string, unknown>;
    }): Promise<OAuthIdentityRow | null>;
    findMany(args: {
      where: Record<string, unknown>;
    }): Promise<OAuthIdentityRow[]>;
  };
  webSession: {
    create(args: { data: Record<string, unknown> }): Promise<WebSessionRow>;
    findUnique(args: { where: { jwt_id: string } }): Promise<WebSessionRow | null>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  agentSession: {
    create(args: { data: Record<string, unknown> }): Promise<AgentSessionRow>;
    findUnique(args: {
      where: { token_hash: string };
    }): Promise<AgentSessionRow | null>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
    }): Promise<AgentSessionRow[]>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  credential: {
    create(args: { data: Record<string, unknown> }): Promise<CredentialRow>;
    // Metrics exporter: total stored credentials.
    count(args?: { where?: Record<string, unknown> }): Promise<number>;
    findFirst(args: {
      where: Record<string, unknown>;
    }): Promise<CredentialRow | null>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
    }): Promise<CredentialRow[]>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
    // Distinct enumeration for the one-time dedup migration: there is no
    // "list all accounts" credential helper, so the migration groups by
    // account_id at the DB and reads back the distinct keys.
    groupBy(args: {
      by: ["account_id"];
      where?: Record<string, unknown>;
    }): Promise<{ account_id: string }[]>;
  };
  vaultAuditEvent: {
    create(args: { data: Record<string, unknown> }): Promise<VaultAuditEventRow>;
    // Optional/broad `where` so the metrics exporter can take a grand total
    // while audit readers pass a scoped (account_id + type + window) filter.
    count(args?: { where?: Record<string, unknown> }): Promise<number>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
      take?: number;
    }): Promise<VaultAuditEventRow[]>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  e2ECredential: {
    create(args: {
      data: Record<string, unknown>;
      select: { id: true };
    }): Promise<{ id: string }>;
    findMany(args: {
      where: Record<string, unknown>;
      select: { id: true; label: true; created_at: true };
      orderBy: Record<string, unknown>;
    }): Promise<Array<Pick<E2ECredentialRow, "id" | "label" | "created_at">>>;
    findFirst(args: { where: Record<string, unknown> }): Promise<E2ECredentialRow | null>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  paymentAuditEvent: {
    create(args: {
      data: Record<string, unknown>;
      select: { id: true };
    }): Promise<{ id: string }>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: Record<string, unknown> | Array<Record<string, unknown>>;
      take: number;
    }): Promise<PaymentAuditEventRow[]>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  egressGrant: {
    create(args: { data: Record<string, unknown> }): Promise<EgressGrantRow>;
    // Metrics exporter: total grants + active (revoked_at: null) grants.
    count(args?: { where?: Record<string, unknown> }): Promise<number>;
    findUnique(args: { where: { id: string } }): Promise<EgressGrantRow | null>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
    }): Promise<EgressGrantRow[]>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<EgressGrantRow>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
}

// Cached singleton so multiple stores share one connection pool.
let cached: ApiPrismaClient | null = null;

export function getApiPrismaClient(databaseUrl: string): ApiPrismaClient {
  if (cached !== null) return cached;
  const req = createRequire(import.meta.url);
  // Custom output path from the schema. Falls back to the generated
  // location under node_modules.
  type Ctor = new (opts: { datasourceUrl: string }) => ApiPrismaClient;
  const mod = req("../../node_modules/.prisma/api-client/index.js") as { PrismaClient: Ctor };
  cached = new mod.PrismaClient({ datasourceUrl: databaseUrl });
  return cached;
}
