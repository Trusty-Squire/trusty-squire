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

const TASKS = [
  {
    label: "Add Google OAuth to your app",
    bg: "Signs into Google Cloud, creates a project, configures the OAuth consent screen, mints client credentials, and vaults the secret — the client ID drops straight into your config.",
    blk: "The Google sign-in, and they can't safely hold the client secret.",
  },
  {
    label: "Publish your mobile apps to the App Store & Play Store",
    bg: "Signs into App Store Connect and Play Console, generates and cross-signs the certificates and provisioning profiles, uploads the build, fills the listing, and submits for review.",
    blk: "The developer-account 2FA login and the certificate signing.",
  },
  {
    label: "Set up Firebase for your project",
    bg: "Creates the Firebase project, enables Auth / Firestore / Storage, generates the service-account key, vaults it, and writes your config files.",
    blk: "The Google login, and they can't hold the service-account private key.",
  },
  {
    label: "Add Stripe payments",
    bg: "Signs up for Stripe, clears business verification, creates API keys and webhook endpoints, vaults the secret key, and wires the publishable key into your frontend.",
    blk: "Signup, identity/business verification, and the secret key.",
  },
  {
    label: "Buy gifts for your friends and colleagues",
    bg: "Reaches out to get their preference and delivery address directly, picks the item, checks out with your card injected server-side and one approval, and ships it.",
    blk: "The payment, and they can't get someone's private address without you asking.",
  },
  {
    label: "Automate customer email outreach",
    bg: "Signs up for Resend, pulls your customer list from Algolia, runs the daily outreach, and handles the replies that land in your Gmail inbox.",
    blk: "The Resend signup — and their own safety filters block automated bulk sending, so the workflow never even starts.",
  },
  {
    label: "Run a paid acquisition campaign",
    bg: "Signs up for Google Ads, verifies the business, puts a card on file, launches a search campaign against your keywords, and tunes bids daily against conversions.",
    blk: "Ad-account identity verification, the card on file, and the daily spend decisions no headless agent can self-authorize.",
  },
  {
    label: "Wire up product analytics and alerts",
    bg: "Signs up for PostHog and Sentry, installs the keys, connects a Slack webhook, and routes error spikes and funnel drop-offs straight into your channel.",
    blk: "The two signups, the Slack OAuth connect, and holding each project's key.",
  },
  {
    label: "Onboard a teammate's tool stack",
    bg: "Creates their GitHub, Linear, and Slack seats, pays for each, and sends the invites — so they land ready to work.",
    blk: "The admin-console logins, per-seat billing on each tool, and SSO enrollment.",
  },
  {
    label: "Book travel or a reservation",
    bg: "Searches and selects, fills the passenger or guest details, pays behind the fence with one approval, and confirms.",
    blk: "The payment and the account login.",
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
              <b>MCP</b> · for coding agents
            </span>
            <h1>Empower agents with auth and payments.</h1>
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

      {/* ---------------- PRELUDE + TASK GALLERY ---------------- */}
      <section className="wrap">
        <p className="prelude">
          <span className="lo">Magic happens when your agents can</span> sign up, provision, and
          purchase on your behalf <span className="lo">— hard tasks in one prompt.</span>
        </p>

        <div className="gallery">
          <div className="gallery-head">
            Trusty Squire can— <span className="hint">(tap any task)</span>
          </div>
          {TASKS.map((task) => (
            <details className="task" key={task.label}>
              <summary>
                <span className="k">›</span>
                <span className="label">{task.label}</span>
              </summary>
              <div className="body">
                <div className="line bg">
                  <span className="tag">In the background</span>
                  {task.bg}
                </div>
                <div className="line blk">
                  <span className="tag">Vanilla agents stop at</span>
                  {task.blk}
                </div>
              </div>
            </details>
          ))}
          <div className="gallery-tail">…and any complex task that stalls at a signup or a payment.</div>
        </div>

        <div className="fence">
          The card is never exposed to the agent, and no charge happens without{" "}
          <b>one human approval</b>. API keys stay vaulted — the raw secret never enters the
          agent&rsquo;s context.
        </div>
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
