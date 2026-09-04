// MCP session storage.
//
// ONE store, ONE pathway: a 0600 JSON file at
// $XDG_CONFIG_HOME/trusty-squire/session.json (or ~/.config/trusty-squire/
// session.json). The OS-keychain (keytar) path is gone. It selected itself on
// headless Linux — the write/delete probe PASSES there — while the per-login
// gnome-keyring "session" collection is wiped between SSH logins, so the saved
// session silently vanished and `connect` re-paired on every run. The
// TRUSTY_SQUIRE_SESSION_FILE escape hatch existed only to opt out of that, so
// it goes with it: two pathways WAS the ambiguity about where state lives.
//
// The file holds ONE ENTRY PER ACCOUNT, keyed by `account_id`, in an
// `accounts` map.
//
// It used to hold a single flat object, and that is the bug this closes. On a
// live box `account_id` moved from 01KS0BKRYTVE9T9FAQQ31A4MK3 to
// 01M1N0CBVSCX7GGR94S0JYQW1G when the operator connected under a SECOND Trusty
// Squire account: the second connect overwrote the first account's binding, so
// servers still serving the first account read the second account's scope and
// produced a real `credential_not_found` for a credential that exists in the
// first account's vault. Keyed by account, a connect under a new account ADDS
// an entry and destroys nothing; the first account's servers keep working.
//
// Keying by ACCOUNT is namespacing, not the per-process fragmentation that
// session-simplify removed: an account is a real, stable identity — the same
// one the vault is scoped to — while a process is not.
//
// TWO RULES KEEP THIS SAFE FOR SERVERS THAT ARE ALREADY RUNNING. Those cannot
// be upgraded in place: a live box carries several `mcp server` processes that
// each loaded their build weeks ago and read this same file.
//
//  1. READS NEVER WRITE. An earlier revision migrated the file on read, so
//     merely reading it from a new build reshaped the file under four running
//     older servers, which could then no longer read it. Reading accepts both
//     shapes and rewrites nothing; the shape is upgraded only by an explicit
//     write.
//  2. A WRITE STAYS READABLE BY AN OLD BUILD. The document written is a
//     SUPERSET: the current account's entry stays at the TOP LEVEL exactly
//     where a pre-v2 build looks for it, and the `accounts` map sits beside it
//     as an extra key that an old build parses and ignores. So a v2 write is
//     never what breaks an old reader.
//
// The residual mixed-build cost is bounded and one-directional: an OLD build's
// write emits only the flat shape, dropping `accounts`, so other accounts'
// entries are lost and the file falls back to exactly its pre-v2 behaviour for
// the account that old build serves. Nothing is corrupted, and the next write
// from a v2 build re-establishes the map.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VERSION } from "./version.js";

// rc.21 — DO NOT cache the file path at module-load time. Tests sandbox via
// beforeEach { process.env.HOME = tmpdir }; a path cached at import time
// captures the REAL ~/.config/trusty-squire/ and the test then writes the
// test-fixture session.json to the user's actual home, destroying live
// credentials. Resolve per-call so the env override in effect at write-time
// wins.
function resolveSessionFile(): string {
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "trusty-squire",
    "session.json",
  );
}

// One account's session. Holds the account-bound credentials the squire needs
// to act on that account's behalf:
//   - machine_token: bot-internal credential for the operator inbox-OTP
//     service, bound to the account at claim time.
//   - agent_session_token: bearer token the MCP server presents on vault
//     writes, mandate-aware tool calls, and any other authed API surface.
//   - account_id: the account this entry belongs to — also its key in the file.
//
// Fields stay optional in the type so the install CLI can write a transient
// entry with just machine_token while the browser claim is in flight. At
// tool-call time, every field is required — missing fields surface a
// "re-install" message.
export interface SessionData {
  api_base_url: string;
  saved_at: string;
  machine_token?: string;
  agent_session_token?: string;
  account_id?: string;
  // OAuth providers observed by the most recent install-time live probe for
  // THIS account. Connect UX data, never an authority for provider availability.
  //
  // Values are OAuthProviderId strings ("google" | "github"); kept as string[]
  // here to avoid a circular import.
  connected_providers?: string[];
  // Install-time preferences. Inbox reads default on when this older optional
  // field is missing; explicit false remains the opt-out.
  consent_skillify_telemetry?: boolean;
  consent_operator_inbox_otp?: boolean;
}

/**
 * Slot for an entry whose claim has not landed yet, so it has no account to be
 * keyed by. A real account_id is a ULID, so this can never collide with one.
 */
export const UNBOUND_ACCOUNT_KEY = "__unbound__";

/**
 * The on-disk document: the current account's entry at the top level — where a
 * pre-v2 build reads it, unchanged — plus every account's entry under
 * `accounts`, which an old build parses as an unknown key and ignores.
 */
export type SessionFile = SessionData & { accounts?: Record<string, SessionData> };

/** The parsed view: which accounts exist, and which one is current. */
export interface SessionAccounts {
  currentAccountId: string | null;
  accounts: Record<string, SessionData>;
  /** True when the document had no `accounts` map — a pre-v2 flat file. */
  flatOnly: boolean;
}

export function accountKey(data: SessionData): string {
  const id = data.account_id;
  return id !== undefined && id.length > 0 ? id : UNBOUND_ACCOUNT_KEY;
}

/**
 * The account entry a server bound to is gone — logged out, or erased by hand.
 * Loud rather than an empty read, because an empty read reports "not installed"
 * for a machine that is installed, just not under this account any more.
 */
export class AccountSessionMissingError extends Error {
  readonly code = "account_session_missing";
  constructor(
    readonly accountId: string,
    readonly available: string[],
    self: { pid: number; version: string } = { pid: process.pid, version: VERSION },
  ) {
    super(
      `This Trusty Squire server (pid ${self.pid}, v${self.version}) is bound to account ` +
        `${accountId}, but that account no longer has a session on this machine ` +
        `(${available.length === 0 ? "no accounts are installed" : `installed: ${available.join(", ")}`}). ` +
        `Refusing to fall back to another account — a credential in one account's vault is ` +
        `not visible from another. Re-run \`npx @trusty-squire/mcp connect\` under account ` +
        `${accountId}, or restart this host agent's Trusty Squire connection to adopt the ` +
        `account it is now installed under.`,
    );
    this.name = "AccountSessionMissingError";
  }
}

function withoutLegacyProxy(data: SessionData): SessionData {
  const stored = data as SessionData & { proxy_url?: unknown };
  if (!Object.prototype.hasOwnProperty.call(stored, "proxy_url")) return data;
  const clean = { ...stored };
  delete clean.proxy_url;
  return clean;
}

/**
 * Read both shapes without touching the file. A pre-v2 document has no
 * `accounts` map: it IS one account's entry, so it reads as that account's
 * entry — which is exactly what it always meant.
 */
export function parseSessionAccounts(raw: unknown): SessionAccounts {
  if (raw === null || typeof raw !== "object") {
    return { currentAccountId: null, accounts: {}, flatOnly: true };
  }
  const document = raw as SessionFile;
  const top = withoutLegacyProxy(document as SessionData);
  const currentKey = accountKey(top);
  const map = document.accounts;
  if (map === undefined || map === null || typeof map !== "object") {
    return { currentAccountId: currentKey, accounts: { [currentKey]: stripMap(top) }, flatOnly: true };
  }
  const accounts: Record<string, SessionData> = {};
  for (const [key, entry] of Object.entries(map)) {
    if (entry !== null && typeof entry === "object") accounts[key] = withoutLegacyProxy(entry);
  }
  // The top level is the current account's copy of an entry the map also
  // holds. Keep it authoritative for that account so a write by an OLD build —
  // which updates only the top level — is not shadowed by its stale map entry.
  accounts[currentKey] = stripMap(top);
  return { currentAccountId: currentKey, accounts, flatOnly: false };
}

/** The top-level document minus the map, i.e. just the account's own fields. */
function stripMap(document: SessionData): SessionData {
  const entry = { ...(document as SessionFile) };
  delete entry.accounts;
  return entry;
}

/**
 * The document to write: the current account flat at the top level (a pre-v2
 * build reads it there, unchanged) with every account under `accounts`.
 */
export function composeSessionFile(
  accounts: Record<string, SessionData>,
  currentAccountId: string,
): SessionFile {
  const current = accounts[currentAccountId];
  if (current === undefined) throw new Error(`no session entry for account ${currentAccountId}`);
  return { ...current, accounts };
}

export class SessionStore {
  readonly path: string;
  // Allow tests to override the default file path. When no override is
  // supplied, resolve the path NOW (constructor invocation) instead of
  // capturing a value cached at module-import time — see resolveSessionFile.
  constructor(filePath?: string) {
    this.path = filePath ?? resolveSessionFile();
  }

  /**
   * The parsed accounts view. READ-ONLY on purpose: nothing on the read path
   * may reshape a file that already-running older servers are reading too.
   */
  private async load(): Promise<SessionAccounts | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return null;
      throw err;
    }
    return parseSessionAccounts(JSON.parse(raw) as unknown);
  }

  private async persist(file: SessionFile): Promise<void> {
    await fs.mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    // Write-then-rename: several `mcp server` instances and a concurrent
    // `connect` do write this file, and a partially-written session.json is
    // unreadable to every one of them. rename within the directory is atomic,
    // so a racing reader sees either the old file or the new one.
    const temporary = `${this.path}.tmp-${randomUUID()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporary, this.path);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  /** Every account installed on this machine. */
  async listAccounts(): Promise<string[]> {
    return Object.keys((await this.load())?.accounts ?? {});
  }

  /** The account the most recent connect bound, for a reader that has no own. */
  async currentAccountId(): Promise<string | null> {
    return (await this.load())?.currentAccountId ?? null;
  }

  /**
   * One account's entry. With `accountId`, ONLY that account's — a caller bound
   * to an account never silently reads another's. Without it, the account the
   * most recent connect bound.
   */
  async read(accountId?: string): Promise<SessionData | null> {
    const view = await this.load();
    if (view === null) return null;
    const key = accountId ?? view.currentAccountId;
    return key === null ? null : (view.accounts[key] ?? null);
  }

  /** Upsert ONE account's entry. Never touches another account's. */
  async write(data: SessionData): Promise<void> {
    const view = (await this.load()) ?? {
      currentAccountId: null,
      accounts: {},
      flatOnly: true,
    };
    const key = accountKey(data);
    const accounts = { ...view.accounts, [key]: stripMap(withoutLegacyProxy(data)) };
    // A claim that finally names an account supersedes the transient pre-claim
    // entry rather than leaving it behind forever.
    if (key !== UNBOUND_ACCOUNT_KEY) delete accounts[UNBOUND_ACCOUNT_KEY];
    await this.persist(composeSessionFile(accounts, key));
  }

  /**
   * Remove ONE account's entry (the current one by default). Other accounts
   * survive; the file is deleted only when nothing is left.
   */
  async clear(accountId?: string): Promise<void> {
    const view = await this.load();
    if (view === null) return;
    const key = accountId ?? view.currentAccountId;
    if (key === null || key === undefined) return;
    // Nothing to remove: don't rewrite a file other servers are reading.
    if (!Object.prototype.hasOwnProperty.call(view.accounts, key)) return;
    const accounts = { ...view.accounts };
    delete accounts[key];
    const remaining = Object.keys(accounts);
    if (remaining.length === 0) {
      try {
        await fs.unlink(this.path);
      } catch (err) {
        if ((err as { code?: string }).code !== "ENOENT") throw err;
      }
      return;
    }
    const current = view.currentAccountId;
    await this.persist(
      composeSessionFile(accounts, current !== null && current !== key ? current : remaining[0]!),
    );
  }
}

export async function openSessionStorage(
  options: { filePath?: string } = {},
): Promise<SessionStore> {
  return new SessionStore(options.filePath);
}
