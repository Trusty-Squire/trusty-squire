// /install/done — the bot's "OK to close the browser now" signal.
//
// The install wizard navigates here when the user clicks Finish.
// The bot's openInstallConfirmInBotChrome polls the page URL; when
// it sees /install/done it tears down Chrome and the CLI continues.
//
// The page also stands alone as a normal success view for users who
// hit it directly (e.g. via browser history): a friendly confirmation
// + a link to the vault.

import Link from "next/link";

export default function InstallDonePage() {
  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="mark">
          <ShieldMark />
        </div>
        <h1>
          <span className="pair-ok">✓</span> Connected
        </h1>
        <p className="auth-sub">
          Your CLI is connected. Head back to your terminal — or open your
          vault.
        </p>
        <div className="auth-actions">
          <Link className="oauth-btn" href="/vault">
            Open your vault
          </Link>
        </div>
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
