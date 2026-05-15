// Machine token store for Tier 0 anonymous MCP users.
//
// Product principle: the user shouldn't sign anything or create an account
// before they get value. A machine token is issued at MCP install time,
// stays bound to one device, and is good for up to QUOTA_LIMIT free
// signups. When the quota is hit, the tool surfaces a "pair this machine"
// CTA — that's where the account+mandate model kicks in (Tier 1+).
//
// In-memory backing for v1. Losing the count on API restart means a
// generous user gets a few extra free signups, which is acceptable.
// Persist to Postgres when we get there (the schema is one table:
// machine_tokens(token, created_at, signup_count, last_used_at)).

import { randomBytes } from "node:crypto";

const TOKEN_PREFIX = "tsm_";
const DEFAULT_QUOTA = Number.parseInt(process.env.MACHINE_TOKEN_QUOTA ?? "10", 10);

// Network classification recorded at install time. Used downstream to
// correlate captcha failures with egress reputation — see CaptchaEvent
// schema + /v1/install route. All fields optional because the lookup
// is best-effort and older installs predated the columns.
export interface AsnFingerprint {
  class: "residential" | "datacenter" | "unknown";
  number: string | null;
  org: string | null;
  country: string | null;
}

export interface MachineTokenRecord {
  token: string;
  created_at: Date;
  signup_count: number;
  last_used_at: Date | null;
  // Once a machine token is "paired" (linked to a Tier 1 account), the
  // quota stops applying. We keep the token around so the MCP doesn't
  // need to roll its session; it just stops counting.
  paired_account_id: string | null;
  // Captured once at issue() time. Null when the install-time lookup
  // failed or the installer was on an older client.
  asn: AsnFingerprint | null;
}

export interface MachineTokenStore {
  // Optional asn captured at install time. Stored verbatim on the
  // record so downstream services (captcha-events route, retention
  // cron, analytics) can read it without a second lookup.
  issue(now: Date, asn?: AsnFingerprint): Promise<MachineTokenRecord>;
  find(token: string): Promise<MachineTokenRecord | null>;
  incrementUsage(token: string, now: Date): Promise<MachineTokenRecord | null>;
  markPaired(token: string, accountId: string): Promise<void>;
}

export class InMemoryMachineTokenStore implements MachineTokenStore {
  private readonly byToken = new Map<string, MachineTokenRecord>();

  async issue(now: Date, asn?: AsnFingerprint): Promise<MachineTokenRecord> {
    // 32 bytes → 43 chars of url-safe base64 (no padding). Plenty of entropy.
    const random = randomBytes(32).toString("base64url");
    const token = `${TOKEN_PREFIX}${random}`;
    const record: MachineTokenRecord = {
      token,
      created_at: now,
      signup_count: 0,
      last_used_at: null,
      paired_account_id: null,
      asn: asn ?? null,
    };
    this.byToken.set(token, record);
    return record;
  }

  async find(token: string): Promise<MachineTokenRecord | null> {
    return this.byToken.get(token) ?? null;
  }

  async incrementUsage(token: string, now: Date): Promise<MachineTokenRecord | null> {
    const record = this.byToken.get(token);
    if (record === undefined) return null;
    record.signup_count += 1;
    record.last_used_at = now;
    return record;
  }

  async markPaired(token: string, accountId: string): Promise<void> {
    const record = this.byToken.get(token);
    if (record === undefined) return;
    record.paired_account_id = accountId;
  }
}

export function defaultQuota(): number {
  return DEFAULT_QUOTA;
}

export function isMachineToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}

// Quota check helper. Paired tokens have unlimited usage (they're acting
// on behalf of an account that has its own mandate-level controls).
export function isOverQuota(record: MachineTokenRecord, quota: number): boolean {
  if (record.paired_account_id !== null) return false;
  return record.signup_count >= quota;
}
