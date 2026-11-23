// /install/done — the install wizard's standalone success view.
//
// The wizard lands here after Finish, once it has recorded Finish on the
// server; the broker reads that record, not this page, to close the window.
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
