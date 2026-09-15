// Session-scope state that hangs off the live-session registry: the
// start-anchored host allow-list and the id-keyed session lookups the tool
// layer reads. The registry map itself and its lifecycle transaction live in
// lifecycle.ts; every function here takes a looked-up Session (or an id it
// looks up through sessionForCall) and never touches the browser.
import { audit, sessionForCall } from "./lifecycle.js";
import { hostStrings, registrableHost } from "./hosts.js";
import type { Session } from "./model.js";

function baseDomain(host: string): string {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

export function widenAllowedHostsFromUrl(session: Session, url: string): void {
  const host = registrableHost(url);
  if (host === null || session.allowedHosts.some((e) => e.host === host)) return;
  const currentBase = baseDomain(host);
  // Chain ONLY off START-sourced hosts: an organic redirect that shares a base
  // domain with a host the user declared at start is trusted. We do NOT chain
  // off mid_session or prior auto_widen hosts — that would let a single
  // agent-declared host silently pull in a whole sibling tree (scope creep).
  if (
    session.allowedHosts.some((e) => e.source === "start" && baseDomain(e.host) === currentBase)
  ) {
    session.allowedHosts.push({ host, source: "auto_widen" });
    audit(session.id, "scope_widen", {
      host,
      source: "auto_widen",
      allowed_hosts: hostStrings(session),
    });
  }
}

// PR3c — the user's own email captured at login (the authoritative signup
// address), or null when none was captured. The tool layer reads this to fill
// username/password signups so the account is user-owned.
export function getSessionUserEmail(sessionId: string): string | null {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  return session.userEmail;
}
