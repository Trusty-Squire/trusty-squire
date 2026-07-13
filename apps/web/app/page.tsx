import type { Metadata } from "next";
import Link from "next/link";
import { CopyChip } from "./components/CopyChip";
import { Reveal } from "./components/Reveal";
import { Shield } from "./components/Shield";

const DOCS_URL = "https://github.com/trusty-squire/trusty-squire#readme";
const NPM_URL = "https://www.npmjs.com/package/@trusty-squire/mcp";
const GITHUB_URL = "https://github.com/trusty-squire/trusty-squire";

export const metadata: Metadata = {
  alternates: { canonical: "https://trustysquire.ai/" },
};

const EXAMPLES = [
  {
    href: "/use-cases/website-signup",
    prompt: "Sign me up for Resend and save the API key.",
  },
  {
    href: "/use-cases/sign-in-and-configure",
    prompt: "Sign in to Sentry and configure the webhook.",
  },
  {
    href: "/use-cases/website-signup",
    prompt: "Set up Resend, Sentry, PostHog, and Postgres for this app.",
  },
  {
    href: "/use-cases/sign-in-and-configure",
    prompt: "Add Google OAuth without showing me the client secret.",
  },
  {
    href: "/use-cases/api-keys-without-env",
    prompt: "Let my app call OpenAI without giving it the OpenAI key.",
  },
  {
    href: "/use-cases/api-keys-without-env",
    prompt: "That app token leaked. Revoke its access now.",
  },
] as const;

const HOME_JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://trustysquire.ai/#organization",
      name: "Trusty Squire",
      url: "https://trustysquire.ai/",
      logo: "https://trustysquire.ai/logo-400.png",
      sameAs: [GITHUB_URL, NPM_URL],
    },
    {
      "@type": "WebSite",
      "@id": "https://trustysquire.ai/#website",
      url: "https://trustysquire.ai/",
      name: "Trusty Squire",
      description:
        "Trusty Squire signs up and signs in to websites for developers using coding agents.",
      publisher: { "@id": "https://trustysquire.ai/#organization" },
    },
  ],
};

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
          <span className="usr">sign me up for resend</span>
        </div>
        <div className="ln">
          <span className="g"> </span>
          <span className="sq">squire</span>
          <span> opening resend.com · signup, verification, API key…</span>
        </div>
        <div className="ln">
          <span className="g"> </span>
          <span className="ok">✓</span>
          <span> key sealed → vault&nbsp;</span>
          <span className="key">re_••••••••••</span>
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
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(HOME_JSON_LD).replace(/</g, "\\u003c"),
        }}
      />
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
            <Link href="/use-cases">Use cases</Link>
            <Link href="/integrations">Agents</Link>
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
            <h1>Trusty Squire signs up / in to websites for you so you don’t have to.</h1>
            <p className="sub">
              Your coding agent opens the real website, completes signup or sign-in, finishes setup,
              and saves generated credentials without putting them in chat, code, or{" "}
              <code>.env</code>.
            </p>
            <ol className="hero-asks">
              {EXAMPLES.map((example, index) => (
                <li key={example.prompt}>
                  <Link href={example.href}>
                    <span>{String(index + 1).padStart(2, "0")}</span>“{example.prompt}”
                  </Link>
                </li>
              ))}
            </ol>
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
              Ask for a service. Your squire creates the account, works through
              available verification, and stores the generated API key. No
              fifteen-tab signup detour, right inside Claude Code, Codex, Goose,
              and Cursor.
            </p>
          </div>
        </Reveal>
        <Reveal className="cap">
          <div className="cap-num">02 / vault</div>
          <div className="cap-body">
            <h3>Use keys without exposing them</h3>
            <p>
              Stop scattering keys across <span className="m">.env</span> files.
              Keys go into the vault; a proxy injects each value into the provider
              request server-side without returning it to the agent or consuming
              app.
            </p>
          </div>
        </Reveal>
        <Reveal className="cap">
          <div className="cap-num">03 / operate</div>
          <div className="cap-body">
            <h3>Finish setup behind a login</h3>
            <p>
              Wire up OAuth across consoles, configure webhooks, and stand up
              projects. Your squire does the authenticated click-work while the
              secret stays out of chat.
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
              <Link href="/use-cases">Use cases</Link>
              <Link href="/integrations">Agents</Link>
              <Link href="/blog">Blog</Link>
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
