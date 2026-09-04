// MCP session storage.
//
// ONE store, ONE pathway: 0600 JSON files under
// $XDG_CONFIG_HOME/trusty-squire/ (or ~/.config/trusty-squire/). The
// OS-keychain (keytar) path is gone. It selected itself on headless Linux — the
// write/delete probe PASSES there — while the per-login gnome-keyring "session"
// collection is wiped between SSH logins, so the saved session silently
// vanished and `connect` re-paired on every run. The TRUSTY_SQUIRE_SESSION_FILE
// escape hatch existed only to opt out of that, so it goes with it: two
// pathways WAS the ambiguity about where state lives.
//
// ONE FILE PER ACCOUNT: `sessions/<account_id>.json`.
//
// The bug this closes: state used to live in a single flat `session.json`. On a
// live box `account_id` moved from 01KS0BKRYTVE9T9FAQQ31A4MK3 to
// 01M1N0CBVSCX7GGR94S0JYQW1G when the operator connected under a SECOND Trusty
// Squire account. The second connect overwrote the first account's binding, so
// servers still serving the first account read the second account's scope and
// produced a real `credential_not_found` for a credential that exists in the
// first account's vault.
//
// Per-account files make "adding an account NEVER destroys another's"
// STRUCTURAL rather than enforced. Writing account B touches only B's file, so
// there is no shared document to read-modify-write and therefore no race to
// lose an update in. An earlier revision kept the single-file map and added a
// cross-process lock to serialize writers; that lock then had to solve stale
// reclaim, PID reuse, crash-wedged holders, and self-stale payloads — three
// failure modes (lost update, permanent wedge, stale-reclaim-while-live) that
// simply do not exist here. Do not reintroduce it: if you find yourself needing
// a lock, something has gone back to sharing one document.
//
// Keying by ACCOUNT is namespacing, not the per-process fragmentation that
// session-simplify removed: an account is a real, stable identity — the same
// one the vault is scoped to — while a process is not.
//
// `session.json` SURVIVES as the current-account pointer AND the compatibility
// mirror. It holds the current account's entry in the ORIGINAL flat shape, so
// the `mcp server` processes already running on this box — which loaded a
// pre-per-account build weeks ago, read that flat file, and cannot be upgraded
// in place — keep seeing a binding they understand, including after a new
// connect. It is last-write-wins by design and needs no lock: the most recent
// connect IS the current account, so the last writer holding the pointer is the
// correct answer. It is a POINTER AND A MIRROR, never the source of truth for
// any account other than the current one.
//
// READS NEVER WRITE. An earlier revision migrated the file on read, so merely
// reading it from a new build reshaped the file under four running older
// servers, which could then no longer read it. Reads accept the legacy flat
// file as its own account's entry and rewrite nothing; migration to
// `sessions/<id>.json` happens only on an explicit write.

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
function resolveConfigDir(): string {
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "trusty-squire",
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

/** A stored entry, or null when the file is absent or not an object. */
function parseEntry(raw: unknown): SessionData | null {
  if (raw === null || typeof raw !== "object") return null;
  return withoutLegacyProxy(raw as SessionData);
}

/** Account ids are ULIDs; refuse anything that could escape the directory. */
function isSafeAccountKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(key) || key === UNBOUND_ACCOUNT_KEY;
}

export class SessionStore {
  /** The current-account pointer and pre-per-account compatibility mirror. */
  readonly path: string;
  private readonly dir: string;

  // Allow tests to override the location. When no override is supplied, resolve
  // the path NOW (constructor invocation) instead of capturing a value cached
  // at module-import time — see resolveConfigDir.
  constructor(filePath?: string) {
    this.path = filePath ?? path.join(resolveConfigDir(), "session.json");
    this.dir = path.dirname(this.path);
  }

  private get sessionsDir(): string {
    return path.join(this.dir, "sessions");
  }

  private accountFile(accountId: string): string {
    return path.join(this.sessionsDir, `${accountId}.json`);
  }

  private async readJson(file: string): Promise<unknown | null> {
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * The legacy flat pointer/mirror. Also the pre-per-account file, which is
   * why a read falls back to it: an install that predates `sessions/` has its
   * only copy here, and reading must not require migrating it first.
   */
  private async readPointer(): Promise<SessionData | null> {
    return parseEntry(await this.readJson(this.path));
  }

  private async writeAtomic(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // Write-then-rename so a reader — including an older server reading the
    // pointer — never observes a partially written file. rename within the
    // same directory is atomic.
    const temporary = `${file}.tmp-${randomUUID()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private async writeAtomicIfMissing(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${randomUUID()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      try {
        await fs.link(temporary, file);
      } catch (err) {
        if ((err as { code?: string }).code !== "EEXIST") throw err;
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  /** Every account installed on this machine. */
  async listAccounts(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.sessionsDir);
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
      names = [];
    }
    const accounts = names
      .filter((name) => name.endsWith(".json") && !name.includes(".tmp-"))
      .map((name) => name.slice(0, -".json".length))
      .filter(isSafeAccountKey);
    // An install that predates `sessions/` lives only in the pointer file.
    if (accounts.length === 0) {
      const legacy = await this.readPointer();
      if (legacy !== null) return [accountKey(legacy)];
    }
    return accounts.sort();
  }

  /** The account the most recent connect bound, for a reader that has no own. */
  async currentAccountId(): Promise<string | null> {
    const pointer = await this.readPointer();
    if (pointer !== null) return accountKey(pointer);
    const accounts = await this.listAccounts();
    return accounts.length === 1 ? accounts[0]! : null;
  }

  /**
   * One account's entry. With `accountId`, ONLY that account's file — a caller
   * bound to an account never silently reads another's. Without it, the account
   * the most recent connect bound.
   */
  async read(accountId?: string): Promise<SessionData | null> {
    if (accountId === undefined) {
      const current = await this.currentAccountId();
      return current === null ? null : await this.read(current);
    }
    if (!isSafeAccountKey(accountId)) return null;
    const own = parseEntry(await this.readJson(this.accountFile(accountId)));
    if (own !== null) return own;
    // Mixed builds can still write a flat pointer for an account with no
    // per-account file. That fallback is required for those live sessions;
    // only a manual file deletion leaves it masking a missing account.
    const pointer = await this.readPointer();
    return pointer !== null && accountKey(pointer) === accountId ? pointer : null;
  }

  /**
   * Upsert ONE account's entry. Structurally cannot touch another account's:
   * it writes that account's own file, then refreshes the pointer/mirror.
   */
  async write(data: SessionData): Promise<void> {
    const key = accountKey(data);
    if (!isSafeAccountKey(key)) {
      throw new Error(`Invalid session account ID: ${key}`);
    }
    const entry = withoutLegacyProxy(data);
    await this.writeAtomic(this.accountFile(key), entry);
    // A claim that finally names an account supersedes the transient pre-claim
    // entry rather than leaving it behind forever.
    if (key !== UNBOUND_ACCOUNT_KEY) {
      await fs.rm(this.accountFile(UNBOUND_ACCOUNT_KEY), { force: true });
    }
    const pointer = await this.readPointer();
    if (pointer !== null) {
      const pointerKey = accountKey(pointer);
      if (
        pointerKey !== key &&
        pointerKey !== UNBOUND_ACCOUNT_KEY &&
        isSafeAccountKey(pointerKey)
      ) {
        await this.writeAtomicIfMissing(this.accountFile(pointerKey), pointer);
      }
    }
    // The pointer, in the ORIGINAL flat shape, so servers already running an
    // older build keep reading a binding they understand. Last-write-wins is
    // the correct semantics: the most recent connect IS the current account.
    await this.writeAtomic(this.path, entry);
  }

  /**
   * Remove ONE account's entry (the current one by default). Other accounts'
   * files are untouched; the pointer moves to a survivor, or is deleted when
   * nothing is left.
   */
  async clear(accountId?: string): Promise<void> {
    const key = accountId ?? (await this.currentAccountId());
    if (key === null || key === undefined) return;
    if (!isSafeAccountKey(key)) {
      throw new Error(`Invalid session account ID: ${key}`);
    }
    const pointer = await this.readPointer();
    if (pointer !== null && accountKey(pointer) === key) {
      const remaining = (await this.listAccounts()).filter((id) => id !== key);
      if (remaining.length > 0) {
        const survivor = await this.read(remaining[0]!);
        if (survivor !== null) {
          await this.writeAtomic(this.path, survivor);
        } else {
          try {
            await fs.unlink(this.path);
          } catch (err) {
            if ((err as { code?: string }).code !== "ENOENT") throw err;
          }
        }
      } else {
        try {
          await fs.unlink(this.path);
        } catch (err) {
          if ((err as { code?: string }).code !== "ENOENT") throw err;
        }
      }
    }
    const targetFile = this.accountFile(key);
    await fs.rm(targetFile, { force: true });
    // This catches a writer that re-materialized the legacy-only pointer
    // account while logout retargeted the pointer. A writer already paused
    // after its snapshot can still land later, but only for a legacy-only
    // account and only as a stale credential file, never cross-account reads.
    await fs.rm(targetFile, { force: true });
  }
}

export async function openSessionStorage(
  options: { filePath?: string } = {},
): Promise<SessionStore> {
  return new SessionStore(options.filePath);
}
