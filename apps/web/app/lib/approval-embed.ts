// The approval page opened from inside another app (the SDK's
// `approvals.open()`), instead of from a Telegram or agent link.
//
//   ?embed=sheet&return_origin=<app origin>   in an iframe sheet over the app
//   ?embed=popup&return_origin=<app origin>   in a popup the app opened
//   ?embed=redirect&return_to=<app URL>       full-page, then back to the app
//
// The page reports the decision to the app with postMessage, addressed to
// `return_origin` only, so no other origin receives it. It carries the
// approval id and status — no secret, no card data, nothing the approval link
// does not already reveal. The message shape matches @trusty-squire/sdk's
// `readPageMessage`.

export const MESSAGE_SOURCE = "trusty-squire";

export type EmbedMode = "sheet" | "popup" | "redirect";

/** The status vocabulary the SDK understands. */
export type HostStatus =
  | "pending"
  | "approved"
  | "processing"
  | "completed"
  | "failed"
  | "denied"
  | "expired";

export interface ApprovalEmbed {
  mode: EmbedMode;
  returnOrigin: string | null;
  returnTo: string | null;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/** An exact origin (no path), https, or http on loopback for local development. */
export function isAllowedReturnOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== value) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  } catch {
    return false;
  }
}

// Schemes that would run code or read local data instead of returning to an app.
const BLOCKED_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
  "filesystem:",
]);

/** https, loopback http, or an app's own custom scheme (e.g. beeline://). */
export function isAllowedReturnTo(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") return isLoopback(url.hostname);
    return !BLOCKED_SCHEMES.has(url.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
  } catch {
    return false;
  }
}

/** The embed request in a query string, or null for the ordinary standalone page. */
export function readApprovalEmbed(search: string): ApprovalEmbed | null {
  const params = new URLSearchParams(search);
  const mode = params.get("embed");
  if (mode === "sheet" || mode === "popup") {
    const origin = params.get("return_origin");
    return origin !== null && isAllowedReturnOrigin(origin)
      ? { mode, returnOrigin: origin, returnTo: null }
      : null;
  }
  if (mode === "redirect") {
    const to = params.get("return_to");
    return { mode, returnOrigin: null, returnTo: to !== null && isAllowedReturnTo(to) ? to : null };
  }
  return null;
}

export type HostMessage =
  | { type: "approval.decision"; approvalId: string; status: HostStatus }
  | { type: "approval.close"; approvalId: string }
  | { type: "approval.fallback"; approvalId: string };

/** Post to the app that opened this page. False when there is no app to tell. */
export function postToHost(embed: ApprovalEmbed, message: HostMessage, win: Window = window): boolean {
  if (embed.returnOrigin === null) return false;
  const host =
    embed.mode === "sheet"
      ? win.parent !== win
        ? win.parent
        : null
      : embed.mode === "popup"
        ? (win.opener as Window | null)
        : null;
  if (host === null) return false;
  host.postMessage({ source: MESSAGE_SOURCE, ...message }, embed.returnOrigin);
  return true;
}

/** Where redirect mode sends the user back, with the outcome in the query. */
export function returnToUrl(embed: ApprovalEmbed, approvalId: string, status: HostStatus): string | null {
  if (embed.returnTo === null) return null;
  const url = new URL(embed.returnTo);
  url.searchParams.set("squire_approval_id", approvalId);
  url.searchParams.set("squire_approval_status", status);
  return url.toString();
}

/** This page in a popup of its own, reporting back to this same origin. */
export function popupUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.set("embed", "popup");
  url.searchParams.set("return_origin", url.origin);
  url.searchParams.delete("return_to");
  return url.toString();
}

/**
 * Whether a frame may ask for a passkey. Browsers that expose a permissions
 * policy answer directly; elsewhere the page tries and falls back on error.
 */
export function passkeysAllowedHere(doc: Document = document): boolean {
  const policy = (
    doc as Document & {
      featurePolicy?: { allowsFeature(feature: string): boolean };
      permissionsPolicy?: { allowsFeature(feature: string): boolean };
    }
  ).permissionsPolicy ?? (doc as Document & { featurePolicy?: { allowsFeature(feature: string): boolean } }).featurePolicy;
  if (policy === undefined || typeof policy.allowsFeature !== "function") return true;
  return policy.allowsFeature("publickey-credentials-get");
}

/** A WebAuthn refusal that a top-level window may not hit. */
export function isFramePasskeyFailure(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "NotAllowedError" || name === "SecurityError" || name === "NotSupportedError";
}

/** Map one approval page's own status words to the SDK's. */
export function hostStatus(
  kind: "payment" | "credential_fetch" | "credential_mutation" | "card_mutation",
  pageStatus: string,
): HostStatus | null {
  if (pageStatus === "pending" || pageStatus === "denied" || pageStatus === "expired") {
    return pageStatus;
  }
  if (pageStatus === "failed") return "failed";
  if (kind === "credential_fetch") {
    if (pageStatus === "approved") return "approved";
    if (pageStatus === "consumed") return "completed";
    return null;
  }
  if (kind === "payment") {
    // The page's "submitted" is the user's signature; the record's "approved"
    // is the broker confirming the released card, so checkout is under way.
    if (pageStatus === "submitted") return "approved";
    if (pageStatus === "approved") return "processing";
    return null;
  }
  // Mutations run in the same step that accepts the signature.
  return pageStatus === "approved" ? "completed" : null;
}
