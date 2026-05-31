// System-styled 404 in the centered auth-card vocabulary. Flat, mono-
// forward — the brand mark, a mono status code, and a way home.

import Link from "next/link";
import { Shield } from "./components/Shield";

export default function NotFound() {
  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="mark">
          <Shield glyph />
        </div>
        <div className="nf-code">404</div>
        <h1>Page not found</h1>
        <p className="auth-sub">
          That page doesn&apos;t exist — it may have moved.
        </p>
        <div className="auth-actions">
          <Link className="oauth-btn" href="/">
            Back to home
          </Link>
        </div>
      </div>
    </main>
  );
}
