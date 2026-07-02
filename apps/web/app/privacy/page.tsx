import Link from "next/link";
import { Shield } from "../components/Shield";

const NPM_URL = "https://www.npmjs.com/package/@trusty-squire/mcp";
const GITHUB_URL = "https://github.com/trusty-squire/trusty-squire";
const CONTACT = "privacy@trustysquire.ai";

export const metadata = {
  title: "Privacy Policy — Trusty Squire",
  description:
    "How Trusty Squire handles your data and the credentials you store — encrypted at rest, never read back to the agent.",
};

export default function PrivacyPage() {
  return (
    <main>
      <nav>
        <div className="nav-in">
          <Link className="brand" href="/">
            <Shield size={22} glyph />
            Trusty Squire
          </Link>
          <div className="nav-r">
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

      <section className="wrap legal">
        <h1>Privacy Policy</h1>
        <p className="legal-meta">Last updated 29 June 2026 · Beta</p>

        <p>
          Trusty Squire is a credential broker: it provisions SaaS accounts on
          your behalf and stores the resulting API keys and secrets in an
          encrypted vault, so your AI agent can use them without ever holding
          the raw values. This policy explains what we collect, how the vault
          works, and the control you have over your data.
        </p>

        <h2>The short version</h2>
        <ul>
          <li>
            Your stored credentials are <strong>encrypted at rest</strong> and
            are a <strong>write-only sink</strong> — the agent (and we) cannot
            read a raw secret back out. Secrets are injected server-side only
            when you explicitly use them.
          </li>
          <li>We do not sell your data, and we do not read your stored secrets.</li>
          <li>
            You can permanently delete everything at any time.
          </li>
        </ul>

        <h2>What we collect</h2>
        <ul>
          <li>
            <strong>Account identity.</strong> The email and provider id from
            the Google or GitHub account you sign in with, so your install is
            bound to your account.
          </li>
          <li>
            <strong>Credentials you ask us to vault.</strong> The API keys,
            tokens, and login secrets you store. These are encrypted with
            envelope encryption; the plaintext is never returned to the agent
            and never written to a log.
          </li>
          <li>
            <strong>Audit metadata.</strong> A record of which credential was
            stored, retrieved, rotated, or proxied, and when — with{" "}
            <em>no secret values</em>. This is the &ldquo;who touched my
            keys&rdquo; trail you can read back.
          </li>
          <li>
            <strong>Operational data.</strong> Machine/session tokens that
            authenticate your install, and minimal request logs (method, path,
            status — never headers, bodies, or secrets).
          </li>
        </ul>

        <h2>Email verification reads your own inbox</h2>
        <p>
          When a signup needs an email verification code, the operator reads it
          from <strong>your own signed-in inbox, in your own browser session</strong>,
          behind a just-in-time consent gate you approve per session. We do not
          mint email aliases for you and we do not store your inbox contents.
        </p>

        <h2>How the vault protects your secrets</h2>
        <p>
          Every credential is sealed under a per-credential key, which is itself
          wrapped by a master key held in our infrastructure and never exposed
          to the application. A secret is only ever decrypted server-side, at
          the moment you make an authenticated request through the injecting
          proxy, and the raw value is returned only to the upstream provider —
          never to the agent, the audit log, or you (you read your own plaintext
          from the web vault if you need it).
        </p>

        <h2>Third parties</h2>
        <ul>
          <li>
            <strong>Hosting</strong> — our API and database run on Fly.io.
          </li>
          <li>
            <strong>The services you provision</strong> — when you ask Trusty
            Squire to sign you up for a service, that account and its data are
            governed by <em>that service&rsquo;s</em> privacy policy and terms.
          </li>
          <li>
            We don&rsquo;t sell or share your data with advertisers or data
            brokers.
          </li>
        </ul>

        <h2>Retention &amp; your rights</h2>
        <p>
          You can <strong>permanently erase</strong> all of your data —
          credentials and the audit trail — from the web vault at any time.
          Operational logs and audit events are retained on a rolling window and
          then deleted automatically.
        </p>

        <h2>Contact</h2>
        <p>
          Questions or a data request? Email{" "}
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>
      </section>

      <footer>
        <div className="wrap">
          <div className="foot">
            <Link className="brand" href="/">
              <Shield size={17} />
              Trusty Squire
            </Link>
            <div className="foot-l">
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
