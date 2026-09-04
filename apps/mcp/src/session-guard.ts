// A server's account-scoped view of the session store.
//
// The store keeps one entry per account, so a `connect` under a second account
// no longer overwrites the first account's binding. What remains is telling the
// server WHICH account it is: it binds one at startup and reads only that
// entry, so it can never fall back to another account's scope, and it says so
// loudly if its own entry is removed.
//
// The account a server binds comes from TRUSTY_SQUIRE_ACCOUNT_ID — `connect`
// writes it into the host agent's MCP config env, so an already-running server
// keeps the account it was launched for even after a later connect installs a
// different one. Without that env (a config written before this existed) it
// falls back to the store's most recently connected account.

import {
  AccountSessionMissingError,
  openSessionStorage,
  type SessionData,
  type SessionStore,
} from "./session.js";
import { VERSION } from "./version.js";

export interface SessionStateProblem {
  code: "account_session_missing";
  message: string;
}

export interface SessionGuardReport {
  /** Non-null means the read cannot be trusted; surface it as a tool error. */
  problem: SessionStateProblem | null;
}

export interface SessionGuard {
  /** Read this server's account entry, adopting an account on first success. */
  bind(): Promise<SessionData | null>;
  /** Per-tool-call check; never throws. */
  inspect(): Promise<SessionGuardReport>;
  /** The account this server is serving, once bound. */
  boundAccountId(): string | null;
}

// The account THIS process is acting for, published by whoever owns the guard.
//
// Tools must read it from here and must NEVER fall back to the store's
// current-account pointer: a server launched from a pre-pin config binds by
// fallback, and re-resolving later would hand it whichever account connected
// most recently — the original "acting as an account it never bound to"
// defect. The launch env is a different thing and is a legitimate source: it
// is the pinned value the guard itself starts from, and operator/CI paths
// (skill CLI, direct registry publishes) run with no guard at all.
let servingAccount: string | null = null;

export function setServingAccountId(accountId: string | null): void {
  servingAccount = accountId;
}

export function servingAccountId(): string | undefined {
  if (servingAccount !== null) return servingAccount;
  return accountFromEnv();
}

function accountFromEnv(): string | undefined {
  const id = (process.env.TRUSTY_SQUIRE_ACCOUNT_ID ?? "").trim();
  return id.length > 0 ? id : undefined;
}

export function createSessionGuard(
  options: {
    openStorage?: () => Promise<SessionStore>;
    self?: { pid: number; version: string };
    accountId?: string | undefined;
  } = {},
): SessionGuard {
  const openStorage = options.openStorage ?? (async () => await openSessionStorage());
  const self = options.self ?? { pid: process.pid, version: VERSION };
  const configured = "accountId" in options ? options.accountId : accountFromEnv();
  let bound: string | null = configured ?? null;
  // Only an account this server has actually served can go missing. Before
  // that, a read that comes back empty is "not installed yet" — the install
  // ceremony can still publish while this server is already running — and the
  // existing unauthenticated path owns that message.
  let served = false;

  const readOwn = async (storage: SessionStore): Promise<SessionData | null> =>
    bound === null ? await storage.read() : await storage.read(bound);

  return {
    async bind(): Promise<SessionData | null> {
      const storage = await openStorage();
      const data = await readOwn(storage);
      if (data !== null && data.agent_session_token !== undefined && data.account_id !== undefined) {
        bound = data.account_id;
        served = true;
      }
      return data;
    },

    async inspect(): Promise<SessionGuardReport> {
      if (bound === null || !served) return { problem: null };
      let storage: SessionStore;
      let data: SessionData | null;
      try {
        storage = await openStorage();
        data = await storage.read(bound);
      } catch {
        // A transient read failure is not evidence the account is gone. Stay
        // quiet and let the existing unauthenticated path report it.
        return { problem: null };
      }
      if (data !== null) return { problem: null };
      const available = await storage.listAccounts().catch(() => []);
      const error = new AccountSessionMissingError(bound, available, self);
      return { problem: { code: error.code, message: error.message } };
    },

    boundAccountId: () => bound,
  };
}
