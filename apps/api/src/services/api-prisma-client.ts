// Lazy loader for the API's Prisma client.
//
// The schema lives at apps/api/prisma/schema.prisma and generates to
// apps/api/node_modules/.prisma/api-client (custom output so it
// doesn't clash with @prisma/client used by the inbox package).
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
  signup_count: number;
  last_used_at: Date | null;
  paired_account_id: string | null;
  asn_class?: string | null;
  asn_number?: string | null;
  asn_org?: string | null;
  asn_country?: string | null;
}

// ── Tier 1 account-layer row shapes ──────────────────────────
// Hand-typed structural rows for the account/session/agent stores,
// matching the new Prisma models. Same narrow-surface discipline as
// MachineTokenRow above.

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  default_vault: string | null;
  created_at: Date;
}

interface OAuthIdentityRow {
  id: string;
  account_id: string;
  provider: string;
  provider_user_id: string;
  email: string;
  created_at: Date;
}

interface DeviceRow {
  id: string;
  account_id: string;
  first_seen_at: Date;
  last_seen_at: Date;
  platform: string;
  revoked_at: Date | null;
}

interface ActiveMandateRow {
  account_id: string;
  mandate: unknown;
  signed_by_device: string;
  vouchflow_device_token: string;
  session_id: string;
  installed_at: Date;
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
  type: string;
  env_var_suggestion: string | null;
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

export interface ApiPrismaClient {
  machineToken: {
    create(args: { data: Record<string, unknown> }): Promise<MachineTokenRow>;
    findUnique(args: { where: { token: string } }): Promise<MachineTokenRow | null>;
    update(args: { where: { token: string }; data: Record<string, unknown> }): Promise<MachineTokenRow>;
    updateMany(args: { where: { token: string }; data: Record<string, unknown> }): Promise<{ count: number }>;
  };
  lLMUsageEvent: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    count(args: { where: { machine_token: string; occurred_at: { gte: Date } } }): Promise<number>;
  };
  // Captcha encounter ledger. Tightly typed for create() because that's
  // all PrismaCaptchaEventStore uses; readers (analytics queries) will
  // either come through raw SQL or use prisma directly via the full
  // generated client. Keeping the structural surface narrow protects
  // us from accidentally depending on Prisma internals here.
  captchaEvent: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
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

  // ── Tier 1 account layer ─────────────────────────────────────
  account: {
    create(args: { data: Record<string, unknown> }): Promise<AccountRow>;
    findUnique(args: {
      where: { id: string } | { email: string };
    }): Promise<AccountRow | null>;
  };
  oAuthIdentity: {
    create(args: { data: Record<string, unknown> }): Promise<OAuthIdentityRow>;
    findUnique(args: {
      where: Record<string, unknown>;
    }): Promise<OAuthIdentityRow | null>;
  };
  device: {
    upsert(args: {
      where: { id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<DeviceRow>;
    findMany(args: { where: Record<string, unknown> }): Promise<DeviceRow[]>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  activeMandate: {
    upsert(args: {
      where: { account_id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<ActiveMandateRow>;
    findUnique(args: {
      where: { account_id: string };
    }): Promise<ActiveMandateRow | null>;
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
