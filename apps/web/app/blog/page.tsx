import Link from "next/link";
import { Shield } from "../components/Shield";
import { publicMetadata } from "../lib/public-metadata";
import { POSTS } from "./posts";

const NPM_URL = "https://www.npmjs.com/package/@trusty-squire/mcp";
const GITHUB_URL = "https://github.com/Trusty-Squire/trusty-squire";

export const metadata = publicMetadata(
  "Blog",
  "Notes from building Trusty Squire: website signup automation, coding agents, credential safety, and the work behind authenticated setup.",
  "/blog",
);

export default function BlogIndex() {
  return (
    <main>
      <nav className="site-nav">
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

      <section className="blog-list">
        <h1>Blog</h1>
        <p className="lead">
          Notes from building Trusty Squire — anti-bot, vaults, and how secrets
          should work in an agent world.
        </p>
        <div className="post-rows">
          {POSTS.map((p) => (
            <Link key={p.slug} className="post-row" href={`/blog/${p.slug}`}>
              <time className="r-date" dateTime={p.iso}>
                {p.date}
              </time>
              <span className="r-title">{p.title}</span>
              <span className="r-desc">{p.description}</span>
            </Link>
          ))}
        </div>
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
