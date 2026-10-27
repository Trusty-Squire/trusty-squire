"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppShell } from "./AppShell";
import {
  popupUrl,
  postToHost,
  readApprovalEmbed,
  returnToUrl,
  type ApprovalEmbed,
  type HostStatus,
} from "../lib/approval-embed";

const noopSubscribe = (): (() => void) => () => {};
let cachedSearch: string | null = null;
let cachedEmbed: ApprovalEmbed | null = null;

function embedSnapshot(): ApprovalEmbed | null {
  // useSyncExternalStore needs a stable value for an unchanged URL.
  if (cachedSearch !== window.location.search) {
    cachedSearch = window.location.search;
    cachedEmbed = readApprovalEmbed(cachedSearch);
  }
  return cachedEmbed;
}

export interface ApprovalEmbedState {
  embed: ApprovalEmbed | null;
  /** In a sheet, passkeys or sign-in cannot run: offer a window of our own. */
  needsWindow: boolean;
  requireWindow: () => void;
  openWindow: () => void;
  /** `/login?next=…` back to `path`, keeping the embed request across sign-in. */
  loginUrl: (path: string) => string;
  /** Back to the app that opened this page; false when standalone. */
  leave: (status: HostStatus) => boolean;
}

function leaveTo(embed: ApprovalEmbed | null, approvalId: string, status: HostStatus): boolean {
  if (embed === null) return false;
  if (embed.mode === "sheet") return postToHost(embed, { type: "approval.close", approvalId });
  if (embed.mode === "popup") {
    window.close();
    return true;
  }
  const href = returnToUrl(embed, approvalId, status);
  if (href === null) return false;
  window.location.assign(href);
  return true;
}

/**
 * The embed request for this approval page, and the fallback from a sheet to
 * a popup (or, when even a popup is blocked, to a host redirect). While the
 * popup is open the sheet re-reads the approval, so its own decision effect
 * reports the outcome to the app.
 */
export function useApprovalEmbed(approvalId: string, refresh: () => Promise<void>): ApprovalEmbedState {
  const embed = useSyncExternalStore(noopSubscribe, embedSnapshot, () => null);
  const [needsWindow, setNeedsWindow] = useState(false);
  const [windowOpen, setWindowOpen] = useState(false);
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  const requireWindow = useCallback(() => setNeedsWindow(true), []);

  const openWindow = useCallback(() => {
    const opened = window.open(
      popupUrl(window.location.href),
      `trusty-squire-${approvalId}`,
      "popup,width=480,height=720",
    );
    if (opened === null) {
      // No popup either: ask the app to send the whole page to Squire.
      if (embed !== null) postToHost(embed, { type: "approval.fallback", approvalId });
      return;
    }
    setWindowOpen(true);
  }, [approvalId, embed]);

  useEffect(() => {
    if (!windowOpen) return;
    const timer = setInterval(() => void refreshRef.current().catch(() => {}), 2_000);
    return () => clearInterval(timer);
  }, [windowOpen]);

  const loginUrl = useCallback(
    (path: string) =>
      embed === null
        ? `/login?next=${path}`
        : `/login?next=${encodeURIComponent(`${path}${window.location.search}`)}`,
    [embed],
  );

  const leave = useCallback(
    (status: HostStatus) => leaveTo(embed, approvalId, status),
    [approvalId, embed],
  );

  return { embed, needsWindow, requireWindow, openWindow, loginUrl, leave };
}

/**
 * The approval page's frame. Standalone it is the ordinary anonymous app
 * shell. Opened from another app it drops the site chrome — the app's sheet
 * shows the trustysquire.ai address — reports each status change to the app,
 * and ends with a step back to the app.
 */
export function ApprovalFrame({
  state,
  approvalId,
  status,
  children,
}: {
  state: ApprovalEmbedState;
  approvalId: string;
  status: HostStatus | null;
  children: ReactNode;
}) {
  const { embed, needsWindow, openWindow, leave } = state;
  const fallbackRef = useRef<HTMLDivElement>(null);

  // The user just tapped Approve far down the sheet: bring the way forward into view.
  useEffect(() => {
    if (needsWindow) fallbackRef.current?.scrollIntoView?.({ block: "center" });
  }, [needsWindow]);

  useEffect(() => {
    if (embed === null || status === null) return;
    postToHost(embed, { type: "approval.decision", approvalId, status });
    if (embed.mode === "popup" && status !== "pending") {
      // The opener has the decision; give the user a moment to read it.
      const timer = setTimeout(() => window.close(), 1_500);
      return () => clearTimeout(timer);
    }
    return;
  }, [approvalId, embed, status]);

  if (embed === null) return <AppShell anonymous>{children}</AppShell>;

  const decided = status !== null && status !== "pending";
  const canReturn = embed.mode !== "redirect" || embed.returnTo !== null;

  return (
    <div className="approval-embed">
      <main className="approval-embed-main">
        {children}
        {needsWindow && !decided && (
          <div className="app-banner" role="status" ref={fallbackRef}>
            This app&apos;s window can&apos;t use your passkey. Continue on Trusty Squire in a new
            window.
            <div className="approval-actions">
              <button className="btn-secondary" type="button" onClick={openWindow}>
                Continue in a new window
              </button>
            </div>
          </div>
        )}
        {decided && canReturn && (
          <div className="approval-actions">
            <button className="btn-primary" type="button" onClick={() => leave(status)}>
              Return to app
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
