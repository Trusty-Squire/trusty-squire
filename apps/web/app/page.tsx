import Link from "next/link";
import { CopyChip } from "./components/CopyChip";
import { Reveal } from "./components/Reveal";
import { TerminalDemo } from "./components/TerminalDemo";
import { SignupsDemo } from "./components/SignupsDemo";
import { SecretsDemo } from "./components/SecretsDemo";
import { GuardrailsDemo } from "./components/GuardrailsDemo";

const DOCS_URL = "https://github.com/trusty-squire/trusty-squire#readme";
const NPM_URL = "https://www.npmjs.com/package/@trusty-squire/mcp";
const GITHUB_URL = "https://github.com/trusty-squire/trusty-squire";

function Shield({
  size = 22,
  stroke = "#f5f5f7",
  glyph = false,
}: {
  size?: number;
  stroke?: string;
  glyph?: boolean;
}) {
  return (
    <svg viewBox="0 0 100 100" fill="none" style={{ width: size, height: size }}>
      <path
        d="M18 16 H82 V48 Q82 72 50 88 Q18 72 18 48 Z"
        stroke={stroke}
        strokeWidth="6"
        strokeLinejoin="round"
      />
      {glyph && (
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
      )}
    </svg>
  );
}

export default function Page() {
  return (
    <main>
      {/* Keep content visible if JS is disabled (reveals start hidden). */}
      <noscript>
        <style>{`.reveal,.panel.demo{opacity:1!important;transform:none!important}`}</style>
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
            <a className="pill" href={NPM_URL}>
              Install
            </a>
          </div>
        </div>
      </nav>

      {/* ---------------- HERO ---------------- */}
      <header className="hero">
        <div className="glow" />
        <div className="grid" />
        <div className="wrap">
          <div className="hero-in">
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

      {/* ---------------- PRODUCT MOCK ---------------- */}
      <section className="wrap">
        <div className="shot">
          <div className="halo" />
          <TerminalDemo />
        </div>
      </section>

      {/* ---------------- FEATURES ---------------- */}
      <section className="wrap features">
        <Reveal>
          <div className="feat">
            <div className="ftext">
              <div className="fnum">01 / automate</div>
              <h3>Automates signups</h3>
              <p>
                The Trusty Squire MCP signs you up to the SaaS platforms you
                need, right inside Claude Code, Codex, Goose, and Cursor. No
                verification-email detours, no digging dashboards for an API
                key.
              </p>
            </div>
            <SignupsDemo />
          </div>
        </Reveal>

        <Reveal>
          <div className="feat flip">
            <div className="ftext">
              <div className="fnum">02 / secure</div>
              <h3>Keeps your secrets</h3>
              <p>
                Stop hand-managing dozens of production keys. Your squire stores
                them in your hardware or a trusted password manager and grants
                only safe, scoped access.
              </p>
            </div>
            <SecretsDemo />
          </div>
        </Reveal>

        <Reveal>
          <div className="feat">
            <div className="ftext">
              <div className="fnum">03 / guardrails</div>
              <h3>Spends within your guardrails</h3>
              <p>
                Squire agents run under provable spending limits and trust
                boundaries. Anything that costs real money is surfaced to you
                for biometric approval.
              </p>
            </div>
            <GuardrailsDemo />
          </div>
        </Reveal>
      </section>

      {/* ---------------- CTA ---------------- */}
      <section className="endcta">
        <div className="glow" />
        <Reveal className="wrap">
          <h2>Install the squire. Get back to building.</h2>
          <p>One command. Plugs into your agent of choice. Free to start.</p>
          <div className="cta">
            <CopyChip />
            <a className="docs" href={DOCS_URL}>
              Read the docs →
            </a>
          </div>
        </Reveal>
      </section>

      {/* ---------------- FOOTER ---------------- */}
      <footer>
        <div className="wrap">
          <div className="foot">
            <Link className="brand" href="/">
              <Shield size={17} stroke="#8b8b95" />
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
