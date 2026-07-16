import Link from "next/link";
import { Shield } from "./Shield";

const DOCS_URL = "https://github.com/Trusty-Squire/trusty-squire#readme";
const GITHUB_URL = "https://github.com/Trusty-Squire/trusty-squire";
const NPM_URL = "https://www.npmjs.com/package/@trusty-squire/mcp";

export function MarketingNav() {
  return (
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
          <a href={DOCS_URL}>Docs</a>
          <Link className="signin" href="/login">
            Sign in
          </Link>
          <Link className="pill" href="/start">
            Install
          </Link>
        </div>
      </div>
    </nav>
  );
}

export function MarketingFooter() {
  return (
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
            <a href={NPM_URL}>npm</a>
            <a href={GITHUB_URL}>GitHub</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
