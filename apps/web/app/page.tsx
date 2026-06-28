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
              Your squire signs up for the SaaS you need, does the click-work
              behind every login, and seals each key in a vault that never leaks
              it. You just keep shipping.
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
          <div className="cap-num">01 / provision</div>
          <div className="cap-body">
            <h3>Your agent handles signups</h3>
            <p>
              Ask for a service — your squire creates the account, clears the
              verification email, and brings back the API key. No fifteen-tab
              signup detour, right inside Claude Code, Codex, Goose, and Cursor.
            </p>
          </div>
        </Reveal>
        <Reveal className="cap">
          <div className="cap-num">02 / vault</div>
          <div className="cap-body">
            <h3>No secret ever leaves the vault</h3>
            <p>
              Stop scattering keys across <span className="m">.env</span> files
              and cloud secret stores. Keys go in write-only; your code uses them
              through a proxy that injects the value server-side and never hands
              it back — so there&apos;s nothing to leak.
            </p>
          </div>
        </Reveal>
        <Reveal className="cap">
          <div className="cap-num">03 / operate</div>
          <div className="cap-body">
            <h3>Operate anything behind a login</h3>
            <p>
              Complete complex tasks hidden behind auth walls with a single
              prompt — wire up OAuth across consoles, configure webhooks, stand
              up projects. Your squire does the click-work; the secret never
              crosses into chat.
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
