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

const PILLARS = [
  {
    name: "Provision & Ship",
    sub: "for builders; keys never exposed",
    cards: [
      {
        prompt: "Add Google OAuth in one prompt",
        outcome: "Working OAuth login, no dashboard tour.",
        kills: "Kills the client-secret copy/paste into .env.",
        status: "Proven",
      },
      {
        prompt: "Add Stripe payments in one prompt",
        outcome: "Live Checkout and webhook wiring.",
        kills: "Kills hand-typing API keys into code.",
        status: "Proven",
      },
      {
        prompt: "Go live: deploy, custom domain, and SSL",
        outcome: "A real URL, HTTPS, DNS done.",
        kills: "Kills the deploy-dashboard round trip.",
        status: "Proven",
      },
      {
        prompt: "Publish to iOS + Android",
        outcome: "App-store listings live.",
        kills: "Kills the Apple/Google console slog — 2FA, notarization, review.",
        status: "Vision",
      },
    ],
  },
  {
    name: "Transact & Coordinate Privately",
    sub: "for everyone; card + contacts never exposed",
    cards: [
      {
        prompt: "Send gifts privately (Hermes)",
        outcome: "A gift sent, no address shared.",
        kills: "Kills texting your address or card to a friend.",
        status: "Proven",
      },
      {
        prompt: "Book it for me — dinner, flights, tickets",
        outcome: "A confirmed reservation.",
        kills: "Kills the phone tree / booking-site form.",
        status: "Proven",
      },
      {
        prompt: "Never share your card or address again",
        outcome: "Any checkout completed.",
        kills: "Kills pasting card numbers into forms.",
        status: "Proven",
      },
    ],
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
        "MCP tools that let coding agents provision, ship, and pay on your behalf — keys and card never leave the vault.",
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
          <span className="usr">add Google OAuth in one prompt</span>
        </div>
        <div className="ln">
          <span className="g"> </span>
          <span className="sq">squire</span>
          <span> opening Google Cloud Console · OAuth client, secret…</span>
        </div>
        <div className="ln">
          <span className="g"> </span>
          <span className="ok">✓</span>
          <span> secret sealed → vault&nbsp;</span>
          <span className="key">cred_oauth_••••••</span>
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
              <b>MCP</b> · agency for your agents
            </span>
            <h1>Give your agents agency.</h1>
            <p className="sub">
              MCP tools to automate auth and pay — your keys and card never leave the vault.
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
            or Goose plans the job; Trusty Squire operates the website, wires up the integration, or
            completes the purchase — keeping the generated secret or card on the safe side of the
            boundary.
          </p>
          <h3>How does it work?</h3>
          <ol>
            <li>Your agent names the outcome — an account, an integration, or a purchase.</li>
            <li>Trusty Squire drives the real signup, setup, or checkout flow.</li>
            <li>
              The credential or card is encrypted in a write-only vault and injected server-side
              when used.
            </li>
          </ol>
          <p className="home-limit">
            If a site requires a phone, hard CAPTCHA, or a decision only you should make, the run
            stops and tells you instead of guessing.
          </p>
        </div>
      </section>

      {/* ---------------- PILLAR EXAMPLE GRID ---------------- */}
      <section className="wrap pillars" aria-labelledby="pillars-prelude">
        <p id="pillars-prelude" className="pillars-prelude">
          Magic happens when your agents can sign up, provision, and purchase on your behalf — hard
          tasks in one prompt.
        </p>
        {PILLARS.map((pillar) => (
          <div className="pillar" key={pillar.name}>
            <div className="pillar-head">
              <h3>{pillar.name}</h3>
              <span className="pillar-sub">{pillar.sub}</span>
            </div>
            <div className="caps">
              {pillar.cards.map((card, index) => (
                <Reveal className="cap" key={card.prompt}>
                  <div className="cap-num">
                    {String(index + 1).padStart(2, "0")}
                    <span className={card.status === "Proven" ? "row-tag" : "row-tag vision"}>
                      {card.status}
                    </span>
                  </div>
                  <div className="cap-body">
                    <h3>“{card.prompt}”</h3>
                    <p>
                      {card.outcome} {card.kills}
                    </p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        ))}
      </section>

      {/* ---------------- CTA ---------------- */}
      <section className="endcta">
        <Reveal className="wrap">
          <h2>Install the squire. Let it handle the rest.</h2>
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
