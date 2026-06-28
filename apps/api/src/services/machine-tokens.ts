// Machine token store. A machine_token is the bot-internal credential
// the universal signup bot uses for the LLM proxy + the inbox alias
// service; it's bound to the user's account during the install-claim
// handshake (see routes/mcp-install.ts).
//
// There is no signup quota: provisioning is free during beta. The 402
// paywall + per-token counter were removed (see routes/inbox.ts).

import { randomBytes } from "node:crypto";

const TOKEN_PREFIX = "tsm_";

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
  markPaired(token: string, accountId: string): Promise<void>;
  // Hard-delete every machine token paired to an account. Used by account
  // erasure — the account is gone, so its machine credentials must go too.
  // Returns the number deleted.
  deleteByAccount(accountId: string): Promise<number>;
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

  async markPaired(token: string, accountId: string): Promise<void> {
    const record = this.byToken.get(token);
    if (record === undefined) return;
    record.paired_account_id = accountId;
  }

  async deleteByAccount(accountId: string): Promise<number> {
    let deleted = 0;
    for (const [token, record] of this.byToken) {
      if (record.paired_account_id === accountId) {
        this.byToken.delete(token);
        deleted += 1;
      }
    }
    return deleted;
  }
}

export function isMachineToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}
