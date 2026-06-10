// release-guard.ts (C3) — the structural fence that keeps the autonomous
// fix-agent on the `next` (RC) channel and OUT of `latest`.
// See docs/DESIGN-autonomous-output-loop.md.
//
// The fix-agent only ever commits to `staging` with a prerelease version, so
// release.yml publishes the `next` dist-tag and its shape-check makes `latest`
// structurally unreachable. This module is the agent's OWN guard (belt to that
// braces): it refuses to compute or accept anything that could land on
// `main`/`latest`, and it derives the next `-rc.N` bump.
//
// Operator-only (housekeeper/, excluded from the npm tarball).

export class ReleaseFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseFenceError";
  }
}

// SemVer prerelease check: anything with a `-<pre>` segment (mirrors
// release.yml's `is_prerelease` detection).
export function isPrerelease(version: string): boolean {
  return /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(version.trim());
}

// Throw unless we're on `staging` with a prerelease version — the only
// (branch, version) shape the fix-agent is allowed to push. `main` (or a
// stable version) is a hard stop: that channel ships to all users and is the
// human-gated promote, never the agent's.
export function assertStagingPrerelease(input: {
  branch: string;
  version: string;
}): void {
  const branch = input.branch.trim();
  if (branch === "main") {
    throw new ReleaseFenceError(
      `fix-agent may not push to main (latest ships to all users — that's the human promote). branch=${branch}`,
    );
  }
  if (branch !== "staging") {
    throw new ReleaseFenceError(
      `fix-agent only pushes to staging (the next/RC channel), got branch=${branch}`,
    );
  }
  if (!isPrerelease(input.version)) {
    throw new ReleaseFenceError(
      `staging requires a prerelease version (e.g. 0.9.1-rc.1), got ${input.version}`,
    );
  }
}

// Bump to the next RC. Rules:
//   • stable "X.Y.Z"        → "X.Y.(Z+1)-rc.1"  (open a fresh RC line)
//   • prerelease "…-rc.N"   → "…-rc.(N+1)"      (advance the current RC)
//   • prerelease "…-<other>"→ append "-rc.1"-style next is ambiguous → throw
// Pure. The result always satisfies isPrerelease().
export function computeNextRc(current: string): string {
  const v = current.trim();
  const stable = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (stable !== null) {
    const [, maj, min, patch] = stable;
    return `${maj}.${min}.${Number(patch) + 1}-rc.1`;
  }
  const rc = /^(\d+\.\d+\.\d+)-rc\.(\d+)$/.exec(v);
  if (rc !== null) {
    const [, base, n] = rc;
    return `${base}-rc.${Number(n) + 1}`;
  }
  throw new ReleaseFenceError(
    `cannot derive the next rc from "${current}" — expected X.Y.Z or X.Y.Z-rc.N`,
  );
}
