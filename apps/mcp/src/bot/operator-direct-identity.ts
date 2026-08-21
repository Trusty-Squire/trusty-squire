// operator-direct-identity.ts — the Google-authenticated operator path.
//
// The operator profile pool (operator-profile-pool.ts) clones the seeded
// login into a fresh per-session profile so concurrent sessions stay
// isolated. That clone carries the seed's cookies, but Google's session for
// accounts.google.com / myaccount.google.com / the Google consoles resists
// filesystem cloning even when the cookie rows are byte-identical to the
// live profile's — a fresh Chrome instance on a copy of the directory still
// hits the password wall. Whatever the exact binding mechanism (Google
// rotates short-lived session tokens, and possibly keys them to material
// that never lands in the copied Cookies DB), copying files further is not
// the fix: the only browser instance proven to hold Google's trust is the
// one that actually completed the interactive login.
//
// A caller that must act AS the signed-in user (operate_start
// require_live_identity=true — Firebase/GCP consoles, myaccount.google.com,
// anything that gates on a real Google session) gets THIS module instead of
// the pool: it launches directly against the canonical CHROME_PROFILE_DIR,
// under the same cross-process mutual exclusion profile.ts already uses for
// `mcp login` and the pre-pool signup bot (Chrome's own SingletonLock is the
// ultimate authority; acquireFreeProfileOperationGuard is the advisory lock
// in front of it). That serializes Google-identity operator sessions to one
// at a time — a real concurrency regression versus the isolated pool's two
// slots — which is the accepted tradeoff for reaching a session Google
// actually honors. Non-Google-identity sessions are unaffected: they keep
// using the isolated per-session clone pool exactly as before.

import {
  CHROME_PROFILE_DIR,
  ProfileBusyError,
  acquireFreeProfileOperationGuard,
  type ProfileCloseState,
  type ProfileOperationLease,
} from "./profile.js";
import type { OperatorWorkerIdentity } from "./operator-profile-pool.js";

const DIRECT_IDENTITY_RETRY_MS = 200;

export class OperatorDirectIdentityAcquisitionInterruptedError extends Error {
  constructor(readonly reason: "timeout" | "cancelled") {
    super(
      reason === "timeout"
        ? "operate_start capacity reached: the Google-identity operator profile is in use " +
            "by another session; finish it and retry"
        : "operate_start cancelled: operator server is shutting down",
    );
    this.name = "OperatorDirectIdentityAcquisitionInterruptedError";
  }
}

// Duck-type compatible with operator-profile-pool.ts's OperatorProfileLease
// (profileDir, bindWorker, returnWarm, destroy, retain) so the shared
// warm-browser lifecycle in provision-session.ts drives either lease kind
// identically.
export class DirectIdentityProfileLease {
  readonly profileDir: string;
  private finished = false;

  constructor(
    private readonly guard: ProfileOperationLease,
    profileDir: string,
  ) {
    this.profileDir = profileDir;
  }

  // Chrome's own SingletonLock (read by profile.ts's wait/reclaim helpers) is
  // the authority on whether a process still holds the canonical profile —
  // there is no separate per-lease descriptor to bind a worker identity to.
  bindWorker(_worker: OperatorWorkerIdentity): void {
    /* no-op — see class comment */
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.guard.release();
  }

  async returnWarm(_closeState: ProfileCloseState): Promise<void> {
    this.finish();
  }

  async destroy(): Promise<void> {
    this.finish();
  }

  async retain(_destroyRequired = false): Promise<void> {
    this.finish();
  }
}

export interface AcquireDirectIdentityProfileOptions {
  profileDir?: string;
  // Where the advisory lock lives (defaults to tmpdir(), same as
  // acquireFreeProfileOperationGuard). Overridable for test isolation.
  lockRoot?: string;
  deadline?: number;
  signal?: AbortSignal;
}

// Acquire exclusive use of the canonical Google-authenticated profile,
// polling until `deadline` (default: no deadline — wait for `signal` or
// forever) when another operator session currently holds it.
export async function acquireDirectIdentityProfile(
  opts: AcquireDirectIdentityProfileOptions = {},
): Promise<DirectIdentityProfileLease> {
  const profileDir = opts.profileDir ?? CHROME_PROFILE_DIR;
  for (;;) {
    if (opts.signal?.aborted === true) {
      throw new OperatorDirectIdentityAcquisitionInterruptedError("cancelled");
    }
    try {
      const guard = await acquireFreeProfileOperationGuard(profileDir, opts.lockRoot);
      return new DirectIdentityProfileLease(guard, profileDir);
    } catch (err) {
      if (!(err instanceof ProfileBusyError)) throw err;
    }
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
      throw new OperatorDirectIdentityAcquisitionInterruptedError("timeout");
    }
    await new Promise<void>((resolveWait) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", finish);
        resolveWait();
      };
      const timer = setTimeout(finish, DIRECT_IDENTITY_RETRY_MS);
      opts.signal?.addEventListener("abort", finish, { once: true });
    });
  }
}
