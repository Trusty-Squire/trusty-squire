// Blog posts registry. Each post carries its metadata + a Body component
// (hand-written JSX prose, matching the /privacy + /terms convention — no
// markdown runtime, no new deps). Add a post = add an entry here; the index
// (/blog) and the post route (/blog/[slug]) read from POSTS.
import Link from "next/link";
import type { ReactNode } from "react";

const GITHUB_URL = "https://github.com/Trusty-Squire/trusty-squire";

export interface Post {
  slug: string;
  title: string;
  /** Human display date, e.g. "2 July 2026". */
  date: string;
  /** ISO date for <time dateTime> + sorting. */
  iso: string;
  /** Meta description + the excerpt shown on the index. */
  description: string;
  Body: () => ReactNode;
}

function LastMileBody(): ReactNode {
  return (
    <>
      <p>
        AI writes most of my code now. The agent builds the integration, the
        migration, the test — I stay on product decisions. But every new
        dependency still breaks the flow the exact same way: the agent writes the
        integration in thirty seconds, then stops and says:
      </p>
      <blockquote>
        Add your <code>RESEND_API_KEY</code> to <code>.env</code>.
      </blockquote>
      <p>
        So I alt-tab out of the editor, find the dashboard, sign up, click
        through onboarding, verify an email, create a key, paste it into{" "}
        <code>.env</code> — and now there&rsquo;s a live secret sitting in
        plaintext that I have to remember not to commit, that the agent forgets
        about and asks me for again next session. Every service. Every project.
      </p>
      <p>
        It&rsquo;s the last manual chore in AI-assisted coding, and it&rsquo;s the
        one thing the agent couldn&rsquo;t do for me. So I built the thing that
        does it.
      </p>

      <h2>What it does</h2>
      <p>
        You ask once — <em>&ldquo;sign me up for Resend and wire it in,&rdquo;</em>{" "}
        or <em>&ldquo;stand up my whole stack.&rdquo;</em> Your coding agent
        (Claude Code, Cursor, Codex, Goose) drives a scoped browser that signs up
        for the service, handles the email verification, grabs the API key, and
        drops it into an encrypted vault.
      </p>
      <p>
        Provision a whole backend — email, database, analytics, error tracking,
        deploy — in one ask, without opening a single dashboard. If your stack
        leans on a pile of third-party services, this collapses the
        setup-and-configuration slog from an afternoon into a couple of minutes.
      </p>
      <p>
        I tried OpenAI&rsquo;s Operator and browser-use for this first. They can
        drive a browser, but they&rsquo;re general-purpose bots built to be
        watched, and they punt the moment there&rsquo;s a login, a captcha, or an
        API key to handle — which is the entire task. The insight that made this
        work: the coding agent you already have is a great <em>planner</em>; what
        it&rsquo;s missing is a <em>driver</em> — a scoped browser and a safe
        place to put what it finds.
      </p>

      <h2>Where the key goes (the part I actually care about)</h2>
      <p>
        Getting the key is the easy half. The interesting question is where it
        lands — because the default answer, a <code>.env</code> file, is genuinely
        bad and everyone reading this has felt it. <code>.env</code> files get
        committed to GitHub. They get lost. They get pasted into three services
        and rotated in none of them. And in the AI-coding era there&rsquo;s a new
        worst case: the key ends up in the <em>agent&rsquo;s context window</em>,
        the single least contained place a secret can be.
      </p>
      <p>
        So the design principle is:{" "}
        <strong>
          the raw secret is never handed back to the agent, and never lands in
          your repo.
        </strong>
      </p>
      <ul>
        <li>
          The vault is <strong>write-only.</strong> The key goes straight in; the
          agent can&rsquo;t read it back out. There&rsquo;s deliberately no
          &ldquo;give me the plaintext&rdquo; API — if you want the value for a{" "}
          <code>.env</code>, you read it from the web vault yourself.
        </li>
        <li>
          When your code needs the key, it doesn&rsquo;t get the value — it calls{" "}
          <em>through</em> a proxy. You write <code>{"${SECRET}"}</code> in the
          request; the proxy injects the real key server-side and returns only the
          response. The secret goes to the provider, never to you.
        </li>
        <li>
          For a deployed app you mint an <strong>egress grant</strong>: a scoped,
          rate-limited, instantly-revocable token. The app holds <em>that</em>,
          not the real key. So the vault becomes a control plane — rotate once and
          every grant picks it up; something leaks, you revoke the grant and the
          next call fails closed. No re-rotation scramble.
        </li>
      </ul>
      <p>
        The piece I&rsquo;m quietly proud of is multi-console setup — wiring up
        Google OAuth, say, where you create a client in the GCP console and paste
        its secret into a <em>different</em> console. The driver captures the
        secret in console A, seals it in-session (a handle, not the value), and
        types it into console B — and the plaintext never materializes in the
        agent&rsquo;s context or the chat transcript at any point.
      </p>

      <h2>Getting past the signup gates</h2>
      <p>
        Modern signup forms are aggressively bot-gated now (Cloudflare Turnstile,
        Clerk, DataDome) — which is exactly where the general-purpose browser
        agents stall. Getting reliably through those gates, headless and
        unattended, was most of the actual engineering. It&rsquo;s handled behind
        the scenes; if you enjoy anti-bot debugging war-stories, the repo&rsquo;s{" "}
        <code>STATE.md</code> is a graveyard of every hypothesis I falsified
        getting there.
      </p>

      <h2>It gets faster the more it&rsquo;s used</h2>
      <p>
        The first successful signup for a given service gets distilled into a
        replayable recipe and shared. The next time anyone provisions that
        service, it replays in about thirty seconds instead of the agent
        re-figuring the flow from scratch. A chore-removal tool that gets faster
        with use is a nice property to have.
      </p>

      <h2>What&rsquo;s still hard (because it is)</h2>
      <p>I&rsquo;d rather tell you the edges than let you find them:</p>
      <ul>
        <li>
          It works best with <strong>OAuth signups</strong> (Google/GitHub) — most
          of the modern SaaS I reach for, but not all of it.
        </li>
        <li>
          Some services still win — the heaviest captcha stacks, phone-verification
          gates, the most aggressive anti-bot dashboards. When manual signup is
          genuinely the realistic call, I try to say so.
        </li>
        <li>
          <strong>Single-use magic links</strong> are a race, and datacenter-IP
          session invalidation is an ongoing operational reality.
        </li>
      </ul>
      <p>It&rsquo;s beta, and free during the beta.</p>

      <h2>Try it</h2>
      <p>
        Trusty Squire is an open-source MCP server your coding agent drives. It
        plugs into Claude Code, Cursor, and Codex; you can{" "}
        <Link href="/start">get started here</Link>, or read the code{" "}
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
          on GitHub
        </a>
        . Would love feedback — especially on the secret model.
      </p>
    </>
  );
}

export const POSTS: Post[] = [
  {
    slug: "the-last-mile-is-a-signup-form",
    title: "Your coding agent can build your whole app — except sign up for the services it needs",
    date: "2 July 2026",
    iso: "2026-07-02",
    description:
      "Your coding agent builds the whole app, then stalls at every signup form. Trusty Squire provisions the services your stack needs and vaults the keys write-only — setup in minutes, not an afternoon.",
    Body: LastMileBody,
  },
];

export function getPost(slug: string): Post | undefined {
  return POSTS.find((p) => p.slug === slug);
}
