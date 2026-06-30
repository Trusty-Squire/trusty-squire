import Link from "next/link";
import { Shield } from "../components/Shield";

const NPM_URL = "https://www.npmjs.com/package/@trusty-squire/mcp";
const GITHUB_URL = "https://github.com/trusty-squire/trusty-squire";

// A flat, hairline-ruled two-tier table — mono prices, one accent-marked
// focal column (Pro). No glossy cards, no gradients (see DESIGN.md).
export default function PricingPage() {
  return (
    <main>
      {/* ---------------- NAV ---------------- */}
      <nav>
        <div className="nav-in">
          <Link className="brand" href="/">
            <Shield size={22} glyph />
            Trusty Squire
          </Link>
          <div className="nav-r">
            <Link href="/pricing">Pricing</Link>
            <a href={GITHUB_URL}>GitHub</a>
            <Link className="signin" href="/login">
              Sign in
            </Link>
            <Link className="pill" href="/start">
              Install
            </Link>
          </div>
        </div>
      </nav>

      {/* ---------------- HEADER (stub — paid plans not finalized) ---------------- */}
      <header className="price-hero">
        <div className="wrap">
          <h1>Free during beta</h1>
          <p>
            Trusty Squire is free while in beta — every feature unlocked, no
            card required. We haven&apos;t finalized paid plans yet; pricing will
            be announced here before anything changes.
          </p>
          <p>
            <Link className="pill" href="/start">
              Install
            </Link>
          </p>
        </div>
      </header>

      {/* ---------------- FOOTER ---------------- */}
      <footer>
        <div className="wrap">
          <div className="foot">
            <Link className="brand" href="/">
              <Shield size={17} />
              Trusty Squire
            </Link>
            <div className="foot-l">
              <Link href="/pricing">Pricing</Link>
              <Link href="/privacy">Privacy</Link>
              <Link href="/terms">Terms</Link>
              <a href={NPM_URL}>npm</a>
              <a href={GITHUB_URL}>GitHub</a>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
