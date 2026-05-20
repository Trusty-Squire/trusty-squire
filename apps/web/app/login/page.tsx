"use client";

import { OAuthButtons } from "../components/OAuthButtons";
import { useQueryParam } from "../lib/use-query-param";

const ERRORS: Record<string, string> = {
  denied: "Sign-in was cancelled.",
  oauth_failed: "Sign-in didn't complete. Please try again.",
  state_mismatch: "Your sign-in session expired. Please try again.",
};

export default function LoginPage() {
  const errorCode = useQueryParam("error");
  const next = useQueryParam("next") ?? undefined;
  const error =
    errorCode !== null
      ? (ERRORS[errorCode] ?? "Sign-in failed. Please try again.")
      : null;

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="mark">
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
        </div>
        <h1>
          Sign in to{" "}
          <span style={{ whiteSpace: "nowrap" }}>Trusty Squire</span>
        </h1>
        <p className="auth-sub">Your vault and connected agents, in one place.</p>
        <OAuthButtons next={next} />
        {error !== null && <p className="auth-err">{error}</p>}
      </div>
    </main>
  );
}
