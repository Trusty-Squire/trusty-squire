// provision-gate.ts — the refuse-walled pre-flight for the `provision` tool.
//
// A user asks the agent to "sign up for X". For genuinely-disposable free-tier
// services we bot it. But some services are PERMANENT walls — identity/payment
// anchors (Stripe KYC, phone-gated signups) or operator-dequeued services — that
// no bot can or should automate. Botting one wastes ~6 min + a free-quota signup
// + a robot identity and returns a confusing failure. This gate refuses those
// fast, with an honest message that routes the user to bring-your-own-key.
//
// CRITICAL — refuse ONLY permanent walls, never temporary / bot-bug walls
// (anti_bot, nav, planner_loop, oauth_handshake, …). Those are exactly what the
// discover/heal loop exists to crack; refusing them would freeze coverage at
// today's bugs ("no such thing as a wall"). The permanent set mirrors the
// housekeeper router's CAPABILITY_WALL_STAGES {phone, payment, manual}. We can't
// import that constant (housekeeper/ is operator-only, excluded from the npm
// tarball), so it's duplicated here with this note; keep the two in sync.

// The slice of the registry's ServiceState dossier this gate reads.
export interface ProvisionServiceState {
  // CompatState: skill-active | working | struggling | hard-block
  status: string;
  // null | "wall" (falsified, with a falsification record) | "unservable" (dequeued)
  wall_classification: string | null;
  // most recent FAILURE's kind (raw or coarse)
  last_failure_kind: string | null;
}

// Coarse failure kinds that mark a PERMANENT, identity/faculty wall — a bot
// can't (and shouldn't) clear them. Mirror of the router's CAPABILITY_WALL_STAGES
// plus `kyc` (an explicit alias some flows emit).
export const PERMANENT_WALL_KINDS: ReadonlySet<string> = new Set([
  "phone",
  "payment",
  "manual",
  "kyc",
]);

export type ProvisionGateDecision =
  | { decision: "allow" }
  | { decision: "refuse"; wall_kind: string; reason: string };

// The coarse kind = the token before the first ':' lowercased. ServiceState's
// last_failure_kind may be raw ("phone: SMS code never arrived") or already
// coarse ("phone"); both normalize to "phone".
export function coarseKind(kind: string): string {
  const head = kind.split(":")[0];
  return head !== undefined ? head.trim().toLowerCase() : "";
}

// Decide whether the live `provision` tool should refuse a service outright.
//
// Fail-OPEN: a null state (no registry, registry hiccup, unknown service) always
// ALLOWS — a registry gap must never block a real provision. We refuse only on a
// CONFIRMED permanent wall.
export function evaluateProvisionGate(
  state: ProvisionServiceState | null,
): ProvisionGateDecision {
  if (state === null) return { decision: "allow" };

  const kind =
    state.last_failure_kind !== null && state.last_failure_kind.length > 0
      ? coarseKind(state.last_failure_kind)
      : null;

  // Operator dequeued the service as genuinely unservable → permanent, refuse
  // regardless of the (possibly absent) failure kind.
  if (state.wall_classification === "unservable") {
    return {
      decision: "refuse",
      wall_kind: kind ?? "unservable",
      reason: "the registry marks this service unservable (operator-dequeued)",
    };
  }

  // A FALSIFIED wall, or the projection's own hard-block, refuses ONLY when its
  // failure kind is a permanent/identity class. anti_bot / nav / planner_loop /
  // oauth stay ALLOWED so the discover loop keeps cracking them.
  const isWall =
    state.wall_classification === "wall" || state.status === "hard-block";
  if (isWall && kind !== null && PERMANENT_WALL_KINDS.has(kind)) {
    return {
      decision: "refuse",
      wall_kind: kind,
      reason: `signup is gated behind ${kind} verification — an identity/payment anchor a bot can't (and shouldn't) automate`,
    };
  }

  return { decision: "allow" };
}
