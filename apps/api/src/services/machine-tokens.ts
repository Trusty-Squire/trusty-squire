// Machine token store. A machine_token is the bot-internal credential
// the universal signup bot uses for the LLM proxy + the inbox alias
// service; it's bound to the user's account during the install-claim
// handshake (see routes/mcp-install.ts).
//
// Quota: each machine_token gets ACCOUNT_FREE_QUOTA free signups before
// the alias-create path returns payment_required. Per-account
// aggregation (sum across all machine_tokens for an account) is a
// follow-up; today the count tracks per machine_token, which lines up
// with the typical one-account-one-machine case.

import { randomBytes } from "node:crypto";

const TOKEN_PREFIX = "tsm_";
const DEFAULT_QUOTA = Number.parseInt(
  process.env.ACCOUNT_FREE_QUOTA ?? "10",
  10,
);

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
  // The account this machine token is bound to (set by the install-
  // claim handshake). Internal field name retains the `paired_` prefix
  // for now to limit DB-migration scope; rename in a follow-up.
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

// Quota check helper. Single-tier: every machine_token is account-bound
// (or about to be), so the free-signup limit applies uniformly. The
// account upgrades to paid by signing for billing — quota_enforcement
// stops at that point, not at the pairing step.
export function isOverQuota(record: MachineTokenRecord, quota: number): boolean {
  return record.signup_count >= quota;
}
