// oauth-lock.ts — process-wide serialization for OAuth signup runs (T8).
//
// Every signup run launches Chrome from the one shared persistent
// profile (profile.ts / browser.ts). Chrome single-instances a
// userDataDir: two concurrent launchPersistentContext calls on the
// same directory lock-contend or corrupt the profile. Decision D2
// (eng review) chose serialization over copy-on-write clones — clones
// are fragile on ext4 and Google's device-bound (DBSC) cookies do not
// survive a copy — so OAuth runs queue through this mutex instead.
//
// `provision` is async (it returns a run_id and works in
// the background), so two OAuth runs genuinely can overlap in one MCP
// server process. The second one waits here for the first to release.

// The tail of the queue: each acquirer chains onto it, so callers run
// strictly one after another in arrival order.
let tail: Promise<unknown> = Promise.resolve();

// Run `fn` with the OAuth profile lock held — it starts only once
// every previously-queued run has settled. The lock is released (the
// chain advances) however `fn` settles, success or failure, so one
// crashed run never wedges the queue.
export function withOAuthLock<T>(fn: () => Promise<T>): Promise<T> {
  // `.then(fn, fn)` runs `fn` regardless of how the previous link
  // settled — a rejected predecessor still releases the lock.
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
