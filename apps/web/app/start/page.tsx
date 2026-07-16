// /start — the public getting-started page. The brand-quality destination
// the landing's "Install" CTA points to (so users never land on the raw
// npm README). Distinct from /install, which is the token-gated
// OAuth-binding wizard the CLI opens.

import Link from "next/link";
import { CopyChip } from "../components/CopyChip";
import { Shield } from "../components/Shield";
import { publicMetadata } from "../lib/public-metadata";

const DOCS_URL = "https://github.com/trusty-squire/trusty-squire#readme";
const NPM_URL = "https://www.npmjs.com/package/@trusty-squire/mcp";
const GITHUB_URL = "https://github.com/trusty-squire/trusty-squire";

const AGENTS = [
  "claude-code",
  "cursor",
  "codex",
  "goose",
  "cline",
  "continue",
  "hermes",
];

export const metadata = publicMetadata(
  "Install for your coding agent",
  "Install Trusty Squire in one command. The installer detects Claude Code, Codex, Cursor, and other supported agents and writes their MCP configuration.",
  "/start",
);

export default function StartPage() {
  return (
    <>
      <nav className="site-nav">
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
          </div>
        </div>
      </nav>

      <main className="start">
        <span className="start-logo">
          <Shield size={44} glyph />
        </span>
        <h1>Install Trusty Squire</h1>
        <p className="start-sub">
          One command. It auto-detects your coding agent and writes the MCP
          config — no manual setup.
        </p>
        <div className="cta">
          <CopyChip />
        </div>

        <section className="start-sec">
          <h2>Supported agents</h2>
          <div className="agent-list">
            {AGENTS.map((a) => (
              <span className="badge" key={a}>
                {a}
              </span>
            ))}
          </div>
          <p className="start-note">
            Pin a specific target with{" "}
            <code>npx @trusty-squire/mcp connect --target=goose</code>.
          </p>
        </section>

        <section className="start-sec">
          <h2>Next steps</h2>
          <div className="steps">
            <div className="step">
              <span className="step-n">01</span>
              <div>
                <b>Run the command</b>
                <p>
                  Paste it into your terminal. The installer detects your agent
                  and writes the config.
                </p>
              </div>
            </div>
            <div className="step">
              <span className="step-n">02</span>
              <div>
                <b>Restart your agent</b>
                <p>
                  Restart Claude Code, Cursor, Codex, Goose, Cline, or Continue
                  so it picks up the new tools.
                </p>
              </div>
            </div>
            <div className="step">
              <span className="step-n">03</span>
              <div>
                <b>Sign in to bind the machine</b>
                <p>
                  A browser opens so you can confirm the install.{" "}
                  <Link href="/login">Sign in</Link> to connect your account and
                  open your vault.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="start-sec">
          <h2>More</h2>
          <p className="start-note">
            <a href={DOCS_URL}>Read the docs</a> &nbsp;·&nbsp;{" "}
            <a href={NPM_URL}>View on npm</a>
          </p>
        </section>
      </main>
    </>
  );
}
