// Setup-token store for the MCP install handshake.
//
// Lifecycle (single-tier auth):
//   1. CLI POSTs /v1/mcp/install/initiate (no auth) → server mints a
//      setup token (base64url 32 bytes), returns it to the CLI as
//      `setup_code` plus the browser confirm URL.
//   2. Browser hits /install?token=<>, PWA POSTs /v1/mcp/install/:code/
//      claim with the user's web session. Server creates an
//      AgentSession and stashes the raw bearer on the setup record.
//   3. CLI polls GET /v1/mcp/install/:code/status. Once `claimed`, the
//      response carries the raw bearer exactly once; subsequent polls
//      return `expired`.
//
// 10-minute TTL; single-use claim. The model name is "PairingToken"
// for now — internal-only, can be renamed in a follow-up DB migration.

import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;
const PAIR_TTL_MS = 10 * 60 * 1000;

export type PairingStatus = "pending" | "claimed" | "expired" | "delivered";

export interface PairingTokenRecord {
  token: string;
  created_at: Date;
  expires_at: Date;
  status: PairingStatus;
  // Captured at /initiate so the pair page can show "Trusty Squire wants
  // to pair with [Claude Code on this machine]" before the user signs.
  // Optional — the CLI may not always know which agent it's running as.
  agent_identity: string | null;
  // Set when the PWA claims the token. The CLI's status poll surfaces
  // it ONCE (status flips to `delivered` after the first delivery).
  agent_session_raw_token: string | null;
  account_id: string | null;
  // Machine token declared by the CLI at /initiate. On /claim the
  // server binds it to the authenticating account so the bot's
  // LLM-proxy + inbox calls credit the right account.
  machine_token: string | null;
  // Browser-side install choices. These ride back to the CLI with the
  // one-time agent token so the local MCP config matches what the user
  // chose in the web wizard.
  registry_enabled: boolean | null;
  consent_operator_inbox_otp: boolean | null;
  proxy_url: string | null;
}

export interface PairingTokenStore {
  insert(record: PairingTokenRecord): Promise<void>;
  find(token: string): Promise<PairingTokenRecord | null>;
  claim(
    token: string,
    accountId: string,
    rawAgentToken: string,
    now: Date,
    preferences?: InstallPreferences,
  ): Promise<boolean>;
  // Marks the record as delivered after the CLI has fetched the raw
  // agent token exactly once. Returns the raw token; subsequent calls
  // return null.
  deliverAndMarkUsed(token: string, now: Date): Promise<string | null>;
}

export interface InstallPreferences {
  registry_enabled?: boolean;
  consent_operator_inbox_otp?: boolean;
  proxy_url?: string | null;
}

export function issuePairingToken(
  now: Date,
  agentIdentity: string | null = null,
  machineToken: string | null = null,
): PairingTokenRecord {
  return {
    token: Buffer.from(randomBytes(TOKEN_BYTES)).toString("base64url"),
    created_at: now,
    expires_at: new Date(now.getTime() + PAIR_TTL_MS),
    status: "pending",
    agent_identity: agentIdentity,
    agent_session_raw_token: null,
    account_id: null,
    machine_token: machineToken,
    registry_enabled: null,
    consent_operator_inbox_otp: null,
    proxy_url: null,
  };
}

export class InMemoryPairingTokenStore implements PairingTokenStore {
  private readonly rows = new Map<string, PairingTokenRecord>();

  async insert(record: PairingTokenRecord): Promise<void> {
    this.rows.set(record.token, { ...record });
  }

  async find(token: string): Promise<PairingTokenRecord | null> {
    const r = this.rows.get(token);
    return r === undefined ? null : { ...r };
  }

  async claim(
    token: string,
    accountId: string,
    rawAgentToken: string,
    now: Date,
    preferences: InstallPreferences = {},
  ): Promise<boolean> {
    const r = this.rows.get(token);
    if (r === undefined) return false;
    if (now > r.expires_at) {
      r.status = "expired";
      return false;
    }
    if (r.status !== "pending") return false;
    r.status = "claimed";
    r.account_id = accountId;
    r.agent_session_raw_token = rawAgentToken;
    r.registry_enabled = preferences.registry_enabled ?? null;
    r.consent_operator_inbox_otp = preferences.consent_operator_inbox_otp ?? null;
    r.proxy_url = preferences.proxy_url ?? null;
    return true;
  }

  async deliverAndMarkUsed(token: string, now: Date): Promise<string | null> {
    const r = this.rows.get(token);
    if (r === undefined) return null;
    if (now > r.expires_at) {
      r.status = "expired";
      return null;
    }
    if (r.status !== "claimed" || r.agent_session_raw_token === null) return null;
    const raw = r.agent_session_raw_token;
    r.status = "delivered";
    r.agent_session_raw_token = null;
    return raw;
  }
}
