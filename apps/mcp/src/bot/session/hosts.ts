// Phase 2 of the operator session-management restructure: the host-scope views
// derived from a Session's allow-set, plus the URL→host helper they share.
//
// These are pure reads of `Session.allowedHosts` with no live browser or
// registry state, so they sit BELOW both the lifecycle transaction and the
// observe/act surface — both of which need them, and neither of which may
// import the other. Behavior is unchanged from provision-session.ts.
import type { Session } from "./model.js";

export function registrableHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Plain host list for the pieces that only need the names (goto gate, audit,
// observed-hosts). The source metadata stays on the Session.
export function hostStrings(session: Session): string[] {
  return session.allowedHosts.map((e) => e.host);
}

const SERVICE_LOGIN_ROUTE_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "neon.com": ["console.neon.tech"],
};

export function serviceLoginRouteHosts(allowedHosts: readonly string[]): string[] {
  return [
    ...new Set(
      allowedHosts.flatMap(
        (allowed) => SERVICE_LOGIN_ROUTE_HOSTS[allowed.trim().toLowerCase()] ?? [],
      ),
    ),
  ];
}

export function requestScopeHostStrings(session: Session): string[] {
  const allowedHosts = hostStrings(session);
  return [...allowedHosts, ...serviceLoginRouteHosts(allowedHosts)];
}

// Hosts that may seed credential EGRESS (where a stored key is later sent by
// the proxy): start + auto_widen, never mid_session task scope — a wide operate
// scope must not silently over-grant a key's egress allow-list (Codex). The
// vault unions these with the service-default + any agent-declared egress_hosts.
export function egressSeedHosts(session: Session): string[] {
  return session.allowedHosts.filter((e) => e.source !== "mid_session").map((e) => e.host);
}

export function merchantSiblingSeedHosts(session: Session): string[] {
  return session.allowedHosts.filter((e) => e.source !== "mid_session").map((e) => e.host);
}
