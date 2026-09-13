// Host metadata retained for credential egress and recipe capture; never browser filtering.
import type { Session } from "./model.js";

export function registrableHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Plain host list for the pieces that only need the names (audit,
// observed-hosts). The source metadata stays on the Session.
export function hostStrings(session: Session): string[] {
  return session.allowedHosts.map((e) => e.host);
}

// Hosts that may seed credential EGRESS (where a stored key is later sent by
// the proxy): start + auto_widen, never mid_session task scope — a wide operate
// scope must not silently over-grant a key's egress allow-list (Codex). The
// vault unions these with the service-default + any agent-declared egress_hosts.
export function egressSeedHosts(session: Session): string[] {
  return session.allowedHosts.filter((e) => e.source !== "mid_session").map((e) => e.host);
}
