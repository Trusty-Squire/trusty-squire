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

      {/* ---------------- HEADER ---------------- */}
      <header className="price-hero">
        <div className="wrap">
          <h1>Simple pricing</h1>
          <p>
            Provisioning is free. You pay when your code goes to production —
            for the price of your AI editor.
          </p>
        </div>
      </header>

      {/* ---------------- TIERS ---------------- */}
      <section className="wrap">
        <p className="price-beta">
          Free while in beta — Pro features are unlocked for everyone, no card
          required. Pricing below is where it&apos;s headed.
        </p>
        <div className="price-grid">
          {/* Free */}
          <div className="tier">
            <div className="tier-name">Free</div>
            <div className="tier-price">
              <span className="amt">$0</span>
            </div>
            <div className="tier-tag">For building and personal projects.</div>
            <Link className="tier-cta" href="/start">
              Install
            </Link>
            <ul className="tier-feats">
              <li>Signup &amp; SaaS provisioning</li>
              <li>Operate tasks behind any login</li>
              <li>Write-only vault</li>
              <li>Personal use via the injecting proxy</li>
              <li>7-day audit trail</li>
              <li>Manual rotation</li>
            </ul>
          </div>

          {/* Pro — focal */}
          <div className="tier featured">
            <div className="tier-name">Pro</div>
            <div className="tier-price">
              <span className="amt">$20</span>
              <span className="per">/mo</span>
            </div>
            <div className="tier-tag">For shipping real apps to production.</div>
            <Link className="tier-cta primary" href="/start">
              Install
            </Link>
            <ul className="tier-feats">
              <li>Everything in Free</li>
              <li>
                <strong>Egress grants</strong> — scoped, revocable keys for
                deployed apps
              </li>
              <li>365-day audit trail + export</li>
              <li>Generous fair-use egress</li>
              <li>
                <strong>Automated rotation</strong> <em>(coming soon)</em>
              </li>
            </ul>
          </div>
        </div>
      </section>

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
              <a href={NPM_URL}>npm</a>
              <a href={GITHUB_URL}>GitHub</a>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
