// /install/done — the install wizard's standalone success view.
//
// A current web installer reaches this page through the nonce-scoped loopback
// completion callback. Direct navigation remains a terminal signal only for
// legacy/CDP completion paths; it cannot complete a forced provider relogin.
//
// The page also stands alone as a normal success view for users who
// hit it directly (e.g. via browser history): a friendly confirmation
// + a link to the vault.

import Link from "next/link";
import { Shield } from "../../components/Shield";

export default function InstallDonePage() {
  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="mark">
          <Shield glyph />
        </div>
        <h1>
          <span className="pair-ok">✓</span> Connected
        </h1>
        <p className="auth-sub">
          Your CLI is connected. Head back to your terminal — or open your vault.
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
