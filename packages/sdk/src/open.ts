// Show the Squire approval page over the host app.
//
// Passkeys sign only for the site that created them, so the user signs on
// trustysquire.ai, never inside the host app's own page. `openApproval` puts
// that page in a sheet over the conversation (an iframe with the passkey
// permission), shows its address, and resolves when the page reports the
// decision. Where a sheet cannot run passkeys the page offers a popup, and if
// a popup cannot open either it asks the host to redirect.
//
// Page → host messages (window.postMessage, checked here by origin AND by the
// exact window that sent them):
//
//   { source: "trusty-squire", type: "approval.decision", approvalId, status }
//   { source: "trusty-squire", type: "approval.close", approvalId }
//   { source: "trusty-squire", type: "approval.fallback", approvalId }
//
// The page posts only to the `return_origin` it was opened with, so a message
// reaches no one else.

import type { Approval, ApprovalStatus } from "./approval.js";
import { ApprovalOpenError } from "./errors.js";

export const MESSAGE_SOURCE = "trusty-squire";

export type OpenMode = "auto" | "sheet" | "popup" | "redirect";

export interface OpenApprovalOptions {
  /** `auto` (default) uses the sheet; the page itself falls back to a popup or redirect. */
  mode?: OpenMode;
  /** Redirect mode: where the Squire page sends the user back. Default: the current page. */
  returnUrl?: string;
  /** Sheet mode: the element the sheet mounts in. Default: document.body. */
  container?: HTMLElement;
  /** Close the sheet or popup and resolve `dismissed`. */
  signal?: AbortSignal;
  /**
   * Sheet mode: how long the sheet stays up after the decision so the user
   * sees it, in ms. The page's "Return to app" closes it at once. Default 1500.
   */
  closeDelayMs?: number;
}

export interface ApprovalOutcome {
  approvalId: string;
  /**
   * The approval's status when the page reported back, `dismissed` when the
   * user closed it without deciding, or `redirected` when the browser is
   * leaving for the Squire page. Read the final status from your webhook or
   * `approvals.get()` — the status a page reports is a hint, not a record.
   */
  status: ApprovalStatus | "dismissed" | "redirected";
}

type ApprovalRef = Pick<Approval, "id" | "approveUrl">;

interface PageMessage {
  source: typeof MESSAGE_SOURCE;
  type: "approval.decision" | "approval.close" | "approval.fallback";
  approvalId: string;
  status?: ApprovalStatus;
}

const STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "approved",
  "processing",
  "completed",
  "failed",
  "denied",
  "expired",
]);

/** Parse a message from the approval page; null for anything else. */
export function readPageMessage(data: unknown, approvalId: string): PageMessage | null {
  if (data === null || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.source !== MESSAGE_SOURCE || message.approvalId !== approvalId) return null;
  if (message.type === "approval.close" || message.type === "approval.fallback") {
    return { source: MESSAGE_SOURCE, type: message.type, approvalId };
  }
  if (
    message.type === "approval.decision" &&
    typeof message.status === "string" &&
    STATUSES.has(message.status)
  ) {
    return {
      source: MESSAGE_SOURCE,
      type: "approval.decision",
      approvalId,
      status: message.status as ApprovalStatus,
    };
  }
  return null;
}

/**
 * The approval page URL for one opening mode. Use it directly where there is no
 * DOM — for example open it in an in-app browser (ASWebAuthenticationSession,
 * Custom Tabs) with `mode: "redirect"` and your app's return URL.
 */
export function approvalPageUrl(
  approval: ApprovalRef,
  mode: Exclude<OpenMode, "auto">,
  ret: { returnOrigin?: string; returnUrl?: string } = {},
): string {
  let url: URL;
  try {
    url = new URL(approval.approveUrl);
  } catch {
    throw new ApprovalOpenError("invalid_approval_url", "The approval has no valid approve URL.");
  }
  if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
    throw new ApprovalOpenError("invalid_approval_url", "The approve URL must be https.");
  }
  url.searchParams.set("embed", mode);
  if (mode === "redirect") {
    if (ret.returnUrl !== undefined) url.searchParams.set("return_to", ret.returnUrl);
  } else if (ret.returnOrigin !== undefined) {
    url.searchParams.set("return_origin", ret.returnOrigin);
  }
  return url.toString();
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * Open the Squire approval page for `approval`. Call it from the Approve
 * button's click handler: a popup needs that user gesture.
 */
export function openApproval(
  approval: ApprovalRef,
  options: OpenApprovalOptions = {},
): Promise<ApprovalOutcome> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(
      new ApprovalOpenError(
        "no_browser",
        "openApproval needs a browser. Elsewhere, open approvalPageUrl(approval, \"redirect\", { returnUrl }).",
      ),
    );
  }
  const mode = options.mode ?? "auto";
  try {
    if (mode === "redirect") return Promise.resolve(redirect(approval, options));
    if (mode === "popup") return openPopup(approval, options);
    return openSheet(approval, options);
  } catch (error) {
    return Promise.reject(error);
  }
}

function redirect(approval: ApprovalRef, options: OpenApprovalOptions): ApprovalOutcome {
  const url = approvalPageUrl(approval, "redirect", {
    returnUrl: options.returnUrl ?? window.location.href,
  });
  window.location.assign(url);
  return { approvalId: approval.id, status: "redirected" };
}

function pageOrigin(approval: ApprovalRef): string {
  return new URL(approval.approveUrl).origin;
}

function openPopup(approval: ApprovalRef, options: OpenApprovalOptions): Promise<ApprovalOutcome> {
  const url = approvalPageUrl(approval, "popup", { returnOrigin: window.location.origin });
  const popup = window.open(url, `trusty-squire-${approval.id}`, "popup,width=480,height=720");
  if (popup === null) {
    return Promise.reject(
      new ApprovalOpenError("popup_blocked", "The browser blocked the approval window."),
    );
  }
  const origin = pageOrigin(approval);
  return new Promise<ApprovalOutcome>((resolve) => {
    let settled = false;
    const finish = (status: ApprovalOutcome["status"]) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(closedPoll);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ approvalId: approval.id, status });
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== popup) return;
      const message = readPageMessage(event.data, approval.id);
      if (message === null) return;
      if (message.type === "approval.decision" && message.status !== "pending") {
        finish(message.status ?? "dismissed");
      } else if (message.type === "approval.close") {
        finish("dismissed");
      }
    };
    const onAbort = () => {
      popup.close();
      finish("dismissed");
    };
    // A closed popup that never reported back was dismissed.
    const closedPoll = setInterval(() => {
      if (popup.closed) finish("dismissed");
    }, 500);
    window.addEventListener("message", onMessage);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const SHEET_STYLE = {
  overlay:
    "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:flex-end;justify-content:center;" +
    "background:rgba(0,0,0,.45);",
  panel:
    "width:min(560px,100%);height:min(640px,92vh);display:flex;flex-direction:column;" +
    "border-radius:12px 12px 0 0;overflow:hidden;box-shadow:0 -8px 30px rgba(0,0,0,.35);" +
    "background:Canvas;color:CanvasText;color-scheme:light dark;",
  bar:
    "display:flex;align-items:center;gap:8px;padding:8px 10px;font:12px/1.3 ui-monospace,Menlo,monospace;" +
    "border-bottom:1px solid rgba(127,127,127,.35);",
  address: "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
  close:
    "border:0;background:transparent;color:inherit;font:16px/1 system-ui,sans-serif;cursor:pointer;" +
    "padding:4px 8px;",
  frame: "flex:1;width:100%;border:0;background:Canvas;",
} as const;

function openSheet(approval: ApprovalRef, options: OpenApprovalOptions): Promise<ApprovalOutcome> {
  const url = approvalPageUrl(approval, "sheet", { returnOrigin: window.location.origin });
  const page = new URL(url);
  const origin = page.origin;

  const overlay = document.createElement("div");
  overlay.setAttribute("style", SHEET_STYLE.overlay);
  overlay.setAttribute("data-trusty-squire-sheet", approval.id);
  const panel = document.createElement("div");
  panel.setAttribute("style", SHEET_STYLE.panel);
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Trusty Squire approval");

  // The address the user checks before trusting the sheet: always the real
  // origin and path of the page inside it.
  const bar = document.createElement("div");
  bar.setAttribute("style", SHEET_STYLE.bar);
  const lock = document.createElement("span");
  lock.textContent = "🔒";
  lock.setAttribute("aria-hidden", "true");
  const address = document.createElement("span");
  address.setAttribute("style", SHEET_STYLE.address);
  address.setAttribute("data-trusty-squire-address", "");
  address.textContent = `${page.host}${page.pathname}`;
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("style", SHEET_STYLE.close);
  close.setAttribute("aria-label", "Close");
  close.textContent = "✕";
  bar.append(lock, address, close);

  const frame = document.createElement("iframe");
  frame.setAttribute("style", SHEET_STYLE.frame);
  frame.setAttribute("title", "Trusty Squire approval");
  // Without these the page cannot reach the user's passkey from inside a frame.
  frame.setAttribute("allow", `publickey-credentials-get ${origin}; publickey-credentials-create ${origin}`);
  frame.src = url;

  panel.append(bar, frame);
  overlay.append(panel);
  (options.container ?? document.body).append(overlay);

  return new Promise<ApprovalOutcome>((resolve) => {
    let settled = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const teardown = () => {
      clearTimeout(closeTimer);
      window.removeEventListener("message", onMessage);
      options.signal?.removeEventListener("abort", onAbort);
      overlay.remove();
    };
    const settle = (status: ApprovalOutcome["status"]) => {
      if (settled) return;
      settled = true;
      resolve({ approvalId: approval.id, status });
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.contentWindow) return;
      const message = readPageMessage(event.data, approval.id);
      if (message === null) return;
      if (message.type === "approval.decision" && message.status !== undefined && message.status !== "pending") {
        // Your card can update now; the sheet stays a moment so the user sees the result.
        settle(message.status);
        clearTimeout(closeTimer);
        closeTimer = setTimeout(teardown, options.closeDelayMs ?? 1_500);
      } else if (message.type === "approval.close") {
        teardown();
        settle("dismissed");
      } else if (message.type === "approval.fallback") {
        // The page cannot run passkeys here and could not open a popup either.
        teardown();
        if (!settled) {
          settled = true;
          resolve(redirect(approval, options));
        }
      }
    };
    const onAbort = () => {
      teardown();
      settle("dismissed");
    };
    close.addEventListener("click", onAbort);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) onAbort();
    });
    window.addEventListener("message", onMessage);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
