"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, apiGet, apiPost } from "../lib/api";
import { OAuthButtons } from "../components/OAuthButtons";
import { useQueryParam } from "../lib/use-query-param";

type Phase =
  | "loading"
  | "ready"
  | "claiming"
  | "done"
  | "needs_login"
  | "expired"
  | "error";

interface InstallStatus {
  status: string;
  agent_identity?: string | null;
}

const loadingStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "9px",
} as const;

export default function InstallPage() {
  const token = useQueryParam("token");
  // Set when the user signed in mid-flow — the OAuth round-trip carries
  // `&claim=1` back. They already consented (clicked Approve before the
  // sign-in detour), so the install finishes automatically on return
  // rather than dumping them on the confirm screen again.
  const autoClaim = useQueryParam("claim") === "1";
  const [phase, setPhase] = useState<Phase>("loading");
  const [agent, setAgent] = useState<string | null>(null);
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    if (token === null) return;
    let cancelled = false;
    (async () => {
      try {
        const status = await apiGet<InstallStatus>(
          `/v1/mcp/install/${encodeURIComponent(token)}/state`,
        );
        if (cancelled) return;
        if (status.status === "expired") {
          setPhase("expired");
          return;
        }
        if (status.status !== "pending") {
          setPhase("done");
          return;
        }
        setAgent(status.agent_identity ?? null);
        if (!autoClaim) {
          setPhase("ready");
          return;
        }
        // Back from sign-in — finish the claim the user already approved.
        setPhase("claiming");
        try {
          await apiPost(
            `/v1/mcp/install/${encodeURIComponent(token)}/claim`,
            status.agent_identity
              ? { agent_identity: status.agent_identity }
              : {},
          );
          if (!cancelled) setPhase("done");
        } catch (err) {
          if (cancelled) return;
          if (err instanceof ApiError && err.status === 401) {
            setPhase("needs_login");
          } else {
            setPhase("error");
            setErrorText(
              err instanceof Error ? err.message : "Install failed. Try again.",
            );
          }
        }
      } catch (err) {
        if (cancelled) return;
        setPhase("error");
        setErrorText(
          err instanceof Error
            ? err.message
            : "Couldn't load this install request.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, autoClaim]);

  const claimInstall = useCallback(async () => {
    if (token === null) return;
    setPhase("claiming");
    try {
      await apiPost(
        `/v1/mcp/install/${encodeURIComponent(token)}/claim`,
        agent !== null ? { agent_identity: agent } : {},
      );
      setPhase("done");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setPhase("needs_login");
        return;
      }
      setPhase("error");
      setErrorText(
        err instanceof Error ? err.message : "Install failed. Try again.",
      );
    }
  }, [token, agent]);

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="mark">
          <ShieldMark />
        </div>

        {token === null ? (
          <>
            <h1>Invalid install link</h1>
            <p className="auth-sub">
              This link is missing its setup token. Run{" "}
              <code>npx @trusty-squire/mcp install</code> again for a fresh
              one.
            </p>
          </>
        ) : (
          <>
            {(phase === "loading" || phase === "claiming") && (
              <p className="auth-sub" style={loadingStyle}>
                <span className="spinner" />
                {phase === "loading"
                  ? "Loading install request…"
                  : "Connecting…"}
              </p>
            )}

            {phase === "ready" && (
              <>
                <h1>Connect a CLI</h1>
                <p className="auth-sub">
                  An agent on your machine wants to connect to your Trusty
                  Squire account.
                </p>
                <div className="pair-agent">
                  <div className="glyph">
                    <TerminalGlyph />
                  </div>
                  <div>
                    <div className="pa-name">{agent ?? "Coding agent"}</div>
                    <div className="pa-sub">
                      Requesting access to your account
                    </div>
                  </div>
                </div>
                <button
                  className="btn-primary"
                  type="button"
                  onClick={claimInstall}
                >
                  Approve &amp; connect
                </button>
              </>
            )}

            {phase === "done" && (
              <>
                <h1>
                  <span className="pair-ok">✓</span> Connected
                </h1>
                <p className="auth-sub">
                  Your CLI is connected. Head back to your terminal — or open
                  your vault.
                </p>
                <div className="auth-actions">
                  <Link className="oauth-btn" href="/vault">
                    Open your vault
                  </Link>
                </div>
              </>
            )}

            {phase === "needs_login" && (
              <>
                <h1>Sign in to approve</h1>
                <p className="auth-sub">
                  Sign in and we&apos;ll bring you right back to finish
                  connecting your CLI.
                </p>
                <OAuthButtons
                  next={`/install?token=${encodeURIComponent(token)}&claim=1`}
                />
              </>
            )}

            {phase === "expired" && (
              <>
                <h1>Install link expired</h1>
                <p className="auth-sub">
                  Install links last 10 minutes. Run{" "}
                  <code>npx @trusty-squire/mcp install</code> again for a
                  fresh one.
                </p>
              </>
            )}

            {phase === "error" && (
              <>
                <h1>Something went wrong</h1>
                <p className="auth-sub">{errorText}</p>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function ShieldMark() {
  return (
    <svg viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <path
        d="M18 16 H82 V48 Q82 72 50 88 Q18 72 18 48 Z"
        stroke="#f5f5f7"
        strokeWidth="6"
        strokeLinejoin="round"
      />
      <text
        x="50"
        y="60"
        fontFamily="monospace"
        fontSize="30"
        fontWeight="700"
        fill="#8b89ff"
        textAnchor="middle"
      >
        {"{ }"}
      </text>
    </svg>
  );
}

function TerminalGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 7l4 4-4 4" />
      <path d="M12 16h7" />
    </svg>
  );
}
