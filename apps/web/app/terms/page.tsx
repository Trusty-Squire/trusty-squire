import Link from "next/link";
import { Shield } from "../components/Shield";

const NPM_URL = "https://www.npmjs.com/package/@trusty-squire/mcp";
const GITHUB_URL = "https://github.com/trusty-squire/trusty-squire";
const CONTACT = "support@trustysquire.ai";

export const metadata = {
  title: "Terms of Service — Trusty Squire",
  description: "The terms governing your use of Trusty Squire during the beta.",
};

export default function TermsPage() {
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
        <h1>Terms of Service</h1>
        <p className="legal-meta">Last updated 29 June 2026 · Beta</p>

        <p>
          These terms govern your use of Trusty Squire (the &ldquo;Service&rdquo;).
          By installing or using it, you agree to them. If you don&rsquo;t agree,
          don&rsquo;t use the Service.
        </p>

        <h2>What the Service does</h2>
        <p>
          Trusty Squire provisions SaaS accounts on your behalf — under{" "}
          <strong>your own identity</strong> — and stores the resulting
          credentials in an encrypted vault for your agent and apps to use
          through a key-injecting proxy. The Service is currently in{" "}
          <strong>beta and free to use</strong>.
        </p>

        <h2>You sign up as yourself</h2>
        <p>
          When you direct Trusty Squire to create an account on a third-party
          service, it acts <strong>as you</strong>, using your own Google or
          GitHub identity. You are responsible for complying with each
          third-party service&rsquo;s own terms — including any rules about
          automated sign-ups or account creation. Some services restrict
          automation; deciding to provision them is your call and your
          responsibility.
        </p>

        <h2>Your responsibilities</h2>
        <ul>
          <li>
            Keep your own machine, browser session, and account secure — they
            are how the Service acts on your behalf.
          </li>
          <li>
            <strong>Egress grant tokens are backend-only.</strong> A grant token
            lets a deployed app spend a vaulted key through the proxy; treat it
            as a secret, keep it server-side, and revoke it if it leaks.
          </li>
          <li>
            Don&rsquo;t use the Service to break the law, to abuse or attack
            others, to infringe anyone&rsquo;s rights, or to circumvent a
            provider&rsquo;s protections in violation of their terms.
          </li>
        </ul>

        <h2>Beta — provided &ldquo;as is&rdquo;</h2>
        <p>
          The Service is provided <strong>&ldquo;as is&rdquo; and &ldquo;as
          available,&rdquo; without warranties of any kind</strong>, express or
          implied. Provisioning automated sign-ups against live third-party
          sites is inherently best-effort: some will fail, stall on a captcha or
          phone gate, or change without notice. We do not guarantee that any
          particular sign-up will succeed, or any uptime or service level.
        </p>

        <h2>Third-party services</h2>
        <p>
          Accounts and keys you create through Trusty Squire live with the
          respective third-party providers and are governed by their terms. We
          are not responsible for those services, their availability, their
          billing, or anything you do with the credentials.
        </p>

        <h2>Limitation of liability</h2>
        <p>
          To the maximum extent permitted by law, Trusty Squire and its
          operators are not liable for any indirect, incidental, special,
          consequential, or punitive damages, or for any loss of data, profits,
          or credentials, arising from your use of the Service.
        </p>

        <h2>Changes &amp; termination</h2>
        <p>
          We may update these terms or the Service, and may suspend or terminate
          access that violates them. Continued use after a change means you
          accept it. You can stop using the Service and delete your data at any
          time from the web vault.
        </p>

        <h2>Contact</h2>
        <p>
          Questions? Email <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
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
