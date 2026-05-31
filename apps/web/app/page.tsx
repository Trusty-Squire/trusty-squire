import Link from "next/link";
import { CopyChip } from "./components/CopyChip";
import { Reveal } from "./components/Reveal";
import { Shield } from "./components/Shield";

const DOCS_URL = "https://github.com/trusty-squire/trusty-squire#readme";
const NPM_URL = "https://www.npmjs.com/package/@trusty-squire/mcp";
const GITHUB_URL = "https://github.com/trusty-squire/trusty-squire";

// A single static terminal still — the one product surface. No typing
// animation, no caret, no spinners; the precision carries it.
function ProductStill() {
  return (
    <div className="panel">
      <div className="panel-bar">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
        <span className="t">claude code — trusty-squire</span>
      </div>
      <div className="panel-body">
        <div className="ln">
          <span className="g">$</span>
          <span className="usr">provision stripe</span>
        </div>
        <div className="ln">
          <span className="g"> </span>
          <span className="sq">squire</span>
          <span> signing up — oauth, verification, key extraction…</span>
        </div>
        <div className="ln">
          <span className="g"> </span>
          <span className="ok">✓</span>
          <span> key sealed → vault&nbsp;</span>
          <span className="key">sk_live_••••••••••</span>
        </div>
        <div className="ln">
          <span className="g"> </span>
          <span className="cmt"># used via the proxy — never shown to the agent</span>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <main>
      <noscript>
        <style>{`.reveal{opacity:1!important;transform:none!important}`}</style>
      </noscript>

      {/* ---------------- NAV ---------------- */}
      <nav>
        <div className="nav-in">
          <Link className="brand" href="/">
            <Shield size={22} glyph />
            Trusty Squire
          </Link>
          <div className="nav-r">
            <a href={DOCS_URL}>Docs</a>
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

      {/* ---------------- HERO ---------------- */}
      <header className="hero">
        <div className="glow" />
        <div className="grid" />
        <div className="wrap">
          <div className="hero-in">
            <span className="hero-logo">
              <Shield size={54} glyph />
            </span>
            <span className="eyebrow">
              <b>MCP</b> · built for agentic coding
            </span>
            <h1>
              Vibe code.{" "}
              <span className="dim">Your trusty squire handles the rest.</span>
            </h1>
            <p className="sub">
              Trusty Squire automates SaaS signups in your coding agent&apos;s
              context and secures the keys in your hardware — so you can focus
              on building.
            </p>
            <div className="cta">
              <CopyChip />
              <a className="docs" href={DOCS_URL}>
                Read the docs →
              </a>
            </div>
            <div className="agents">
              <span>Works inside</span>
              <div className="badge">Claude Code</div>
              <div className="badge">Codex</div>
              <div className="badge">Goose</div>
              <div className="badge">Cursor</div>
            </div>
          </div>
        </div>
      </header>

      {/* ---------------- PRODUCT SURFACE ---------------- */}
      <section className="wrap">
        <Reveal className="shot">
          <ProductStill />
        </Reveal>
      </section>

      {/* ---------------- CAPABILITIES ---------------- */}
      <section className="wrap caps">
        <Reveal className="cap">
          <div className="cap-num">01 / automate</div>
          <div className="cap-body">
            <h3>Automates signups</h3>
            <p>
              The MCP signs you up to the SaaS platforms you need, right inside
              Claude Code, Codex, Goose, and Cursor. No verification-email
              detours, no digging dashboards for an API key.
            </p>
          </div>
        </Reveal>
        <Reveal className="cap">
          <div className="cap-num">02 / secure</div>
          <div className="cap-body">
            <h3>Keeps your secrets</h3>
            <p>
              Stop hand-managing dozens of production keys. Your squire stores
              them in your hardware or a trusted password manager and grants
              only safe, scoped access — used via the proxy, never shown to an
              agent.
            </p>
          </div>
        </Reveal>
        <Reveal className="cap">
          <div className="cap-num">03 / guardrails</div>
          <div className="cap-body">
            <h3>Spends within your guardrails</h3>
            <p>
              Squire agents run under provable spending limits and trust
              boundaries. Anything that costs real money is surfaced to you for
              biometric approval.
            </p>
          </div>
        </Reveal>
      </section>

      {/* ---------------- CTA ---------------- */}
      <section className="endcta">
        <Reveal className="wrap">
          <h2>Install the squire. Get back to building.</h2>
          <p>One command. Plugs into your agent of choice. Free to start.</p>
          <div className="cta">
            <CopyChip />
            <Link className="docs" href="/start">
              Get started →
            </Link>
          </div>
        </Reveal>
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
              <a href={DOCS_URL}>Docs</a>
              <a href={NPM_URL}>npm</a>
              <a href={GITHUB_URL}>GitHub</a>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
