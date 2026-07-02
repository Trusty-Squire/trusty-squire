// Blog posts registry. Each post carries its metadata + a Body component
// (hand-written JSX prose, matching the /privacy + /terms convention — no
// markdown runtime, no new deps). Add a post = add an entry here; the index
// (/blog) and the post route (/blog/[slug]) read from POSTS.
import Link from "next/link";
import type { ReactNode } from "react";

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

const GITHUB_URL = "https://github.com/Trusty-Squire/trusty-squire";
const PATCHRIGHT_URL = "https://github.com/Kaliiiiiiiiii-Vinyzu/patchright";

function LastMileBody(): ReactNode {
  return (
    <>
      <p>
        AI has made most of my solo development two to three times faster. I
        spend my time on product decisions now, not boilerplate — the agent
        writes the integration, the migration, the test. But there&rsquo;s one
        part of the loop it kept handing back to me, and it broke my flow every
        single time.
      </p>
      <p>
        You know the moment. You ask for email, or push notifications, or a
        database. The agent writes the integration in thirty seconds and then
        stops:
      </p>
      <blockquote>
        Add your <code>RESEND_API_KEY</code> to <code>.env</code>.
      </blockquote>
      <p>
        So I alt-tab out of the editor, find the dashboard, sign up, click
        through onboarding, verify an email, create an API key, copy it, paste
        it into a <code>.env</code> — and now there&rsquo;s a live secret
        sitting in plaintext that I have to remember not to commit, and that the
        agent forgets about and asks me for again next session. Every service.
        Every project. It&rsquo;s the last manual bottleneck in AI-assisted
        coding, and for a while it was the only wall the agent couldn&rsquo;t
        get through for me.
      </p>
      <p>
        I tried the obvious tools first — OpenAI&rsquo;s Operator, browser-use,
        a couple of others. They can drive a browser, but they&rsquo;re built as
        autonomous general-purpose bots, and that&rsquo;s not the shape of the
        problem. I don&rsquo;t want to <em>watch</em> an agent sign up for
        Resend. And in practice they&rsquo;d stall on real signup flows anyway.
        The insight I eventually landed on: the coding agent I already have
        (Claude Code, Codex, whatever) is a perfectly good <em>planner</em>.
        What it&rsquo;s missing is a <em>driver</em> — a scoped browser and a
        safe place to put what it finds.
      </p>
      <p>
        So I built that driver. It turned into two genuinely hard engineering
        problems, and the second one is the one I actually care about.
      </p>

      <h2>Problem 1: getting through the door</h2>
      <p>
        Modern SaaS does not want a bot filling in its signup form. Cloudflare
        Turnstile, Stytch, Clerk, DataDome — signup pages are now some of the
        most aggressively bot-gated surfaces on the web. This became a
        multi-week rabbit hole, and the most useful thing I can share is how{" "}
        <em>wrong</em> I was, repeatedly.
      </p>
      <p>Every time a signup got blocked, I had a confident theory:</p>
      <ul>
        <li>
          <strong>&ldquo;It&rsquo;s the IP reputation.&rdquo;</strong> Datacenter
          IP, obviously flagged. Falsified: a fresh residential IP failed
          identically.
        </li>
        <li>
          <strong>&ldquo;It&rsquo;s the fingerprint / no GPU.&rdquo;</strong>{" "}
          Headless Chromium has no real GPU, tells everywhere. Falsified: a real
          laptop with a real GPU and a real display failed identically.
        </li>
        <li>
          <strong>&ldquo;It&rsquo;s the CDP-level automation tells.&rdquo;</strong>{" "}
          <code>navigator.webdriver</code>, <code>Runtime.enable</code>,
          mainWorld isolation. This one was <em>real</em> but not sufficient — I
          moved to{" "}
          <a href={PATCHRIGHT_URL} target="_blank" rel="noopener noreferrer">
            patchright
          </a>
          , a Playwright fork that closes the CDP tells the stealth plugins
          can&rsquo;t, and it made things better and still didn&rsquo;t clear
          Turnstile.
        </li>
      </ul>
      <p>
        I kept re-deriving &ldquo;it&rsquo;s the environment&rdquo; and kept
        getting proven wrong by experiment. The discipline that eventually saved
        me was writing every falsified hypothesis down in a <code>STATE.md</code>{" "}
        — form a hypothesis, name the experiment that would falsify it, run it,
        record the result. It reads like a graveyard, and it stopped me from
        cargo-culting the same three wrong answers over and over.
      </p>
      <p>
        The actual cause of the Turnstile wall, when I finally ran a controlled
        matrix, was almost stupid:{" "}
        <strong>
          Playwright&rsquo;s <code>launchPersistentContext</code>.
        </strong>{" "}
        Not the IP, not the GPU, not the fingerprint. The way Playwright launches
        and attaches to a persistent browser profile is itself a detectable
        signal. The fix was to self-launch a normal Chrome process and attach
        over CDP (<code>connectOverCDP</code>) instead of letting Playwright
        launch it. Same IP, same machine, same fingerprint — token issued.
      </p>
      <p>
        The rest of the anti-bot layer is less surprising but earns its keep:
        behavior simulation for invisible/scored challenges (bezier-curve mouse
        paths, variable typing speed with thinking pauses, post-load dwell),
        click-and-wait for visible checkbox challenges, and — because headless
        Chromium gets gated on sight — running headed against an on-demand
        virtual display (Xvfb) so there&rsquo;s a real surface to render against,
        which the user never sees.
      </p>
      <p>
        None of this is a &ldquo;wall.&rdquo; Every block I called a wall turned
        out to be a specific, fixable tell. That mindset —{" "}
        <em>a block is a diagnosis problem, not terrain</em> — is most of the
        job.
      </p>

      <h2>Problem 2: keeping the key once you have it</h2>
      <p>
        This is the part I actually built the thing for. Getting the key is a
        means; the interesting question is where it goes.
      </p>
      <p>
        The default answer — a <code>.env</code> file — is genuinely bad, and
        everyone reading this has felt it. <code>.env</code> files get committed
        to GitHub. They get lost. They get pasted into three services and rotated
        in none of them. And in the AI-coding era there&rsquo;s a new worst case:
        the API key ends up in the <em>agent&rsquo;s context window</em>, which is
        the single least contained place a secret can be.
      </p>
      <p>
        So the design principle is:{" "}
        <strong>
          the raw secret is never handed back to the agent, and never lands in
          your repo.
        </strong>{" "}
        Concretely —
      </p>
      <ul>
        <li>
          The vault is <strong>write-only</strong>. When the driver extracts a
          key off the dashboard, it goes straight into an encrypted store. The
          agent can&rsquo;t read it back out. There is deliberately no &ldquo;get
          me the plaintext&rdquo; API — if you want the value for a{" "}
          <code>.env</code>, you read it from the web vault yourself.
        </li>
        <li>
          When your code needs the key, it doesn&rsquo;t get the value — it makes
          the call <em>through</em> a proxy. You write <code>{"${SECRET}"}</code>{" "}
          in the request; the proxy injects the real key server-side at the
          egress boundary and returns only the upstream response. The secret
          crosses the wire to the provider, never to you.
        </li>
        <li>
          For a deployed app (or a CLI agent loop) you mint an{" "}
          <strong>egress grant</strong>: a scoped, rate-limited,
          instantly-revocable token. The app calls the provider holding{" "}
          <em>that</em>, not the real key. So the vault stops being a folder of
          plaintext and becomes a control plane — rotate a key once and every
          grant picks it up; something leaks and you revoke the grant, next call
          fails closed, no re-rotation scramble.
        </li>
      </ul>
      <p>
        The piece I&rsquo;m most quietly proud of is multi-console setup — things
        like wiring up Google OAuth, where you create a client in the GCP console
        and then paste its secret into a <em>different</em> console. The driver
        captures the secret in console A, seals it <em>in-session</em> (a handle,
        not the value), and types it into console B — and the secret never
        materializes in the agent&rsquo;s context or the chat transcript at any
        point. That sealed-in-session transfer is what makes the &ldquo;the model
        never sees it&rdquo; claim actually hold under a real multi-step flow,
        instead of being true only for the trivial single-page case.
      </p>

      <h2>The part that compounds</h2>
      <p>
        One more thing that turned out to matter more than I expected: the first
        successful signup for a given service gets distilled into a replayable
        recipe and published to a shared registry. The next time anyone
        provisions that service, it replays the recipe in about thirty seconds
        instead of the agent re-figuring the flow out from scratch (which is more
        like six minutes of browser-driving). It gets faster the more it&rsquo;s
        used, which is a nice property for something whose whole job is removing a
        chore.
      </p>

      <h2>What&rsquo;s still hard (because it is)</h2>
      <p>I&rsquo;d rather tell you the edges than have you find them:</p>
      <ul>
        <li>
          It works best with <strong>OAuth signups</strong> (Google/GitHub),
          which is most of the modern SaaS I reach for, but not all of it.
        </li>
        <li>
          Some services still win — the heaviest captcha stacks, phone-number
          verification gates, the most aggressive anti-bot dashboards. When
          manual signup is genuinely the realistic call, I try to say so instead
          of pretending.
        </li>
        <li>
          <strong>Single-use magic links</strong> are a race — the link can
          expire between arriving and being clicked, and that&rsquo;s partly the
          provider&rsquo;s semantics, not something I can fully paper over.
        </li>
        <li>Datacenter-IP session invalidation is an ongoing operational reality.</li>
      </ul>
      <p>It&rsquo;s beta, and free during the beta.</p>

      <h2>The shape of it</h2>
      <p>
        The anti-bot debugging was the most instructive thing I&rsquo;ve done in
        a while, and the write-only-vault + injecting-proxy + sealed-in-session
        model feels like the right shape for secrets in an agent world.
      </p>
      <p>
        Trusty Squire is that driver — an open-source MCP server your coding
        agent drives. It signs up for the services your project needs and locks
        every key in a vault the agent can never read back. It plugs into Claude
        Code, Cursor, and Codex; you can <Link href="/start">get started here</Link>,
        or read the code — and the <code>STATE.md</code> graveyard of falsified
        hypotheses —{" "}
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
          on GitHub
        </a>
        .
      </p>
    </>
  );
}

export const POSTS: Post[] = [
  {
    slug: "the-last-mile-is-a-signup-form",
    title: "The last mile of AI-assisted coding is a signup form",
    date: "2 July 2026",
    iso: "2026-07-02",
    description:
      "Why AI coding agents still stall at signup forms — a multi-week anti-bot rabbit hole, and the write-only vault that holds the keys they bring back.",
    Body: LastMileBody,
  },
];

export function getPost(slug: string): Post | undefined {
  return POSTS.find((p) => p.slug === slug);
}
