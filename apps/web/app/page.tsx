import type { Metadata } from "next";
import Link from "next/link";
import { CopyChip } from "./components/CopyChip";
import { JsonLd } from "./components/JsonLd";
import { Reveal } from "./components/Reveal";
import { Shield } from "./components/Shield";
import { softwareApplicationJsonLd } from "./lib/structured-data";

const DOCS_URL = "https://github.com/trusty-squire/trusty-squire#readme";
const NPM_URL = "https://www.npmjs.com/package/@trusty-squire/mcp";
const GITHUB_URL = "https://github.com/trusty-squire/trusty-squire";

export const metadata: Metadata = {
  alternates: { canonical: "https://trustysquire.ai/" },
};

const EXAMPLES = [
  {
    href: "/services/braintrust",
    prompt: "Sign up for Braintrust and save its API key outside agent context.",
  },
  {
    href: "/services/cerebras",
    prompt: "Set up Cerebras inference without putting its API key in this project.",
  },
  {
    href: "/services/clerk",
    prompt: "Sign up for Clerk, create an app, and save the secret key.",
  },
  {
    href: "/services/deepinfra",
    prompt: "Create a DeepInfra account and wire the vaulted token into my backend.",
  },
  {
    href: "/services/zilliz",
    prompt: "Sign up for Zilliz Cloud and keep its API key out of .env.",
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
          <span className="usr">sign me up for Clerk and wire it into this app</span>
        </div>
        <div className="ln">
          <span className="g"> </span>
          <span className="sq">squire</span>
          <span> opening Clerk · email signup, secret key…</span>
        </div>
        <div className="ln">
          <span className="g"> </span>
          <span className="ok">✓</span>
          <span> key sealed → vault&nbsp;</span>
          <span className="key">cred_clerk_••••••</span>
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
      <JsonLd data={HOME_JSON_LD} />
      <JsonLd data={softwareApplicationJsonLd} />
      <noscript>
        <style>{`.reveal{opacity:1!important;transform:none!important}`}</style>
      </noscript>

      {/* ---------------- NAV ---------------- */}
      <nav className="site-nav">
        <div className="nav-in">
          <Link className="brand" href="/">
            <Shield size={22} glyph />
            Trusty Squire
          </Link>
          <div className="nav-r">
            <Link href="/services">Services</Link>
            <Link href="/guides">Guides</Link>
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
              Browser operators often stop at signup walls and bot detection. Trusty Squire opens
              the real website, completes signup or sign-in, finishes setup, and saves generated
              credentials without putting them in chat, code, or <code>.env</code>.
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
              <div className="badge">OpenCode</div>
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

      <section className="wrap home-explainer" aria-labelledby="what-is-trusty-squire">
        <div className="home-explainer-label">What developers ask</div>
        <div>
          <h2 id="what-is-trusty-squire">What is Trusty Squire?</h2>
          <p>
            Trusty Squire is an MCP server for coding agents. Claude Code, Codex, Cursor, OpenCode,
            or Goose plans the job; Trusty Squire operates the website and keeps the generated
            secret on the safe side of the boundary.
          </p>
          <h3>How does it work?</h3>
          <ol>
            <li>Your agent names the website and the finished outcome.</li>
            <li>Trusty Squire drives the real signup, sign-in, or setup flow.</li>
            <li>
              The credential is encrypted in a write-only vault and injected server-side when used.
            </li>
          </ol>
          <p className="home-limit">
            If a site requires a phone, hard CAPTCHA, payment, or a decision only you should make,
            the run stops and tells you instead of guessing.
          </p>
        </div>
      </section>

      {/* ---------------- CAPABILITIES ---------------- */}
      <section className="wrap caps">
        <Reveal className="cap">
          <div className="cap-num">01 / provision</div>
          <div className="cap-body">
            <h3>Your agent handles signups</h3>
            <p>
              Ask for a service. Your squire creates the account, works through available
              verification, and stores the generated API key. No fifteen-tab signup detour, right
              inside Claude Code, Codex, OpenCode, Goose, and Cursor.
            </p>
          </div>
        </Reveal>
        <Reveal className="cap">
          <div className="cap-num">02 / vault</div>
          <div className="cap-body">
            <h3>Use keys without exposing them</h3>
            <p>
              Stop scattering keys across <span className="m">.env</span> files. Keys go into the
              vault; a proxy injects each value into the provider request server-side without
              returning it to the agent or consuming app.
            </p>
          </div>
        </Reveal>
        <Reveal className="cap">
          <div className="cap-num">03 / operate</div>
          <div className="cap-body">
            <h3>Finish setup behind a login</h3>
            <p>
              Wire up OAuth across consoles, configure webhooks, and stand up projects. Your squire
              does the authenticated click-work while the secret stays out of chat.
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
              <Link href="/services">Services</Link>
              <Link href="/guides">Guides</Link>
              <Link href="/compare">Compare</Link>
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
