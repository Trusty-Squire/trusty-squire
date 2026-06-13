// fresh-verify.ts — verify a service by FRESH-signing-up as N independent robot
// identities and requiring AGREEMENT, instead of replaying the recipe against
// the one returning-user account (which diverges — see the verify redesign).
//
// Each picked identity is a distinct Cloud Identity Free Google robot with its
// own profile + egress, so every run is a genuine fresh signup matching the
// recorded recipe's context. Promotion needs `agreement` independent successes
// (default 2-of-N) — which kills flukes, IP-specific passes, and single-account
// artifacts, and doubles as a real virgin-signup success (OF#2).
//
// The signup itself is INJECTED (`runSignup`) so this module is pure-logic +
// testable; the housekeeper provides the closure that drives UniversalSignupBot
// through the identity's profile/proxy.

import {
  pickUnspentIdentities,
  type IdentityProvider,
  type UsageRecord,
  type VerifyIdentity,
} from "./identity-pool.js";

export interface FreshVerifyOutcome {
  identityId: string;
  success: boolean;
  credential?: string;
  reason?: string;
}

export interface FreshVerifyResult {
  kind: "verified" | "insufficient_identities";
  service: string;
  agreement: number;
  promoted: boolean;
  available?: number; // set on insufficient_identities
  outcomes: FreshVerifyOutcome[];
}

// Pure: did enough independent identities succeed to clear the agreement bar?
export function meetsAgreement(
  outcomes: readonly FreshVerifyOutcome[],
  agreement: number,
): boolean {
  return outcomes.filter((o) => o.success).length >= agreement;
}

// Run a fresh-identity verification for one service. Picks `agreement` unspent
// identities, signs up as each (SEQUENTIAL — one shared-profile-lock + don't
// burst one egress IP), marks each spent, and reports whether the agreement bar
// was met. A genuine credential is the success signal; the caller decides what
// to do with `promoted` (registry 2-of-N gate).
export async function freshVerifyService(opts: {
  service: string;
  provider: IdentityProvider;
  agreement?: number;
  identities: readonly VerifyIdentity[];
  usage: readonly UsageRecord[];
  runSignup: (
    identity: VerifyIdentity,
  ) => Promise<{ success: boolean; credential?: string; reason?: string }>;
  markSpent: (identityId: string, service: string) => void;
  log?: (msg: string) => void;
}): Promise<FreshVerifyResult> {
  const agreement = opts.agreement ?? 2;
  const log = opts.log ?? (() => undefined);
  const picked = pickUnspentIdentities(
    opts.identities,
    opts.usage,
    opts.service,
    opts.provider,
    agreement,
  );

  if (picked.length < agreement) {
    log(
      `[fresh-verify] ${opts.service}: only ${picked.length} unspent ${opts.provider} ` +
        `identit${picked.length === 1 ? "y" : "ies"} (need ${agreement}) — pool exhausted for this ` +
        `service; mint more robots or fall back to refetch`,
    );
    return {
      kind: "insufficient_identities",
      service: opts.service,
      agreement,
      promoted: false,
      available: picked.length,
      outcomes: [],
    };
  }

  const outcomes: FreshVerifyOutcome[] = [];
  for (const identity of picked) {
    log(`[fresh-verify] ${opts.service}: signing up as ${identity.id} (${identity.email})`);
    let res: { success: boolean; credential?: string; reason?: string };
    try {
      res = await opts.runSignup(identity);
    } catch (err) {
      res = { success: false, reason: err instanceof Error ? err.message : String(err) };
    }
    // One-shot: this identity is now a returning user at the service, recorded
    // even on failure (it still created/attempted an account there).
    opts.markSpent(identity.id, opts.service);
    outcomes.push({
      identityId: identity.id,
      success: res.success,
      ...(res.credential !== undefined ? { credential: res.credential } : {}),
      ...(res.reason !== undefined ? { reason: res.reason } : {}),
    });
    log(
      `[fresh-verify] ${opts.service}: ${identity.id} → ${res.success ? "success" : "fail"}` +
        (res.reason !== undefined ? ` (${res.reason})` : ""),
    );
  }

  const promoted = meetsAgreement(outcomes, agreement);
  log(
    `[fresh-verify] ${opts.service}: ${outcomes.filter((o) => o.success).length}/${agreement} agreed → ` +
      (promoted ? "PROMOTE" : "hold"),
  );
  return { kind: "verified", service: opts.service, agreement, promoted, outcomes };
}
