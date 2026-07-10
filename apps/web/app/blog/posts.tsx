// Blog posts registry. Each post carries its metadata + a Body component
// (hand-written JSX prose, matching the /privacy + /terms convention — no
// markdown runtime, no new deps). Add a post = add an entry here; the index
// (/blog) and the post route (/blog/[slug]) read from POSTS.
import Link from "next/link";
import type { ReactNode } from "react";

const GITHUB_URL = "https://github.com/Trusty-Squire/trusty-squire";
const VERITAS_URL = "https://github.com/Trusty-Squire/veritaserum";
const GOOSE_PR_URL = "https://github.com/aaif-goose/goose/pull/10361";

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

function ConfabBody(): ReactNode {
  return (
    <>
      <p>
        Everyone who codes with an AI agent has felt this: the agent finishes,
        says <em>&ldquo;Done &mdash; all tests pass,&rdquo;</em> and it isn&rsquo;t
        true. The tests were never run, or three of the twelve features quietly
        regressed, or the &ldquo;fix&rdquo; is a plausible-looking line that
        doesn&rsquo;t actually work. The model isn&rsquo;t lying on purpose. It
        just can&rsquo;t always tell its own finished work from its own hopeful
        narration &mdash; and neither can you, until it burns you.
      </p>
      <p>
        I wanted to know one thing: <strong>is this a small-model problem that
        better models grow out of, or does it follow you up the capability
        ladder?</strong> So I measured it.
      </p>

      <h2>How I measured it</h2>
      <p>
        I gave four coding models the same long, overloaded task: build a stateful
        command-line ledger, one feature per turn, twelve turns. The trick is that
        each turn also quietly <em>mutates</em> an earlier requirement, so old
        features fall out of the model&rsquo;s context window and silently break &mdash;
        exactly the condition that produces over-confident &ldquo;still works&rdquo;
        claims in real work. A hidden test suite the model never sees is the ground
        truth. After every turn, a <em>different</em> model from a different vendor
        audits that turn&rsquo;s claims against what actually happened &mdash; the real
        git diff, a real test run &mdash; and flags anything the repository
        doesn&rsquo;t back up.
      </p>
      <p>
        The four drivers, weakest to strongest: Qwen2.5 3B and 14B (running locally
        on Ollama), DeepSeek, and GPT&#8209;5.1&#8209;Codex. The auditor was held
        constant across all of them.
      </p>

      <h2>The finding: capability doesn&rsquo;t remove the lie, it moves it</h2>
      <p>
        Better models did not confabulate less. They confabulated{" "}
        <em>somewhere else.</em>
      </p>
      <ul>
        <li>
          <strong>Qwen 3B (weak)</strong> couldn&rsquo;t build the thing at all
          (0 of 12 features) and fabricated <strong>the code itself</strong> &mdash;
          &ldquo;implemented the core module&rdquo; when no file existed.
        </li>
        <li>
          <strong>Qwen 14B</strong> also built nothing (0 of 12) &mdash; but where
          the 3B model went quiet, the 14B model got <em>confident.</em> It wrote{" "}
          <strong>twenty-four</strong> detailed claims across the run &mdash;
          &ldquo;complete solution,&rdquo; &ldquo;all twelve features: Success&rdquo;
          &mdash; narrating an entire application that did not exist. The confident
          bullshitter is the more dangerous failure, and it showed up in the{" "}
          <em>middle</em> of the capability range, not the bottom.
        </li>
        <li>
          <strong>DeepSeek</strong> actually built all twelve features &mdash; and
          then over-claimed <strong>the edges</strong>: specific behaviors it never
          tested, an &ldquo;all tests pass&rdquo; on a turn where two features had
          just regressed.
        </li>
        <li>
          <strong>GPT&#8209;5.1&#8209;Codex</strong> built all twelve features{" "}
          <em>correctly</em> &mdash; and still confabulated, just at the last
          remaining place: <strong>the verification.</strong> &ldquo;Ran the full
          regression suite, all checks passed&rdquo; &mdash; with no test run
          anywhere in the trace. The work was real. The claim that it had{" "}
          <em>checked</em> the work was invented.
        </li>
      </ul>
      <p>
        That&rsquo;s the whole finding in one line:{" "}
        <strong>the weak model fakes the code; the frontier model fakes the
        check.</strong> A model good enough to do the work perfectly will still
        confabulate that it verified the work &mdash; which is the most expensive
        lie of all, because it&rsquo;s the one you&rsquo;re most likely to trust.
      </p>

      <h2>The reassuring part: it gets <em>caught</em> cleanest where it matters</h2>
      <p>
        The obvious worry about any &ldquo;lie detector&rdquo; is that it cries wolf.
        The grid says the opposite. The auditor&rsquo;s false-alarm risk{" "}
        <em>rises</em> with the model&rsquo;s capability, and its clean catches
        concentrate exactly where the danger is highest:
      </p>
      <ul>
        <li>
          Against the models that built nothing, it caught 21 of the 14B&rsquo;s
          fabrications with <strong>zero false alarms</strong> &mdash; when there is
          no code, every &ldquo;it works&rdquo; is cleanly, mechanically wrong.
        </li>
        <li>
          The only ambiguous flags in the whole run came from{" "}
          <strong>Codex</strong> &mdash; and they&rsquo;re ambiguous <em>only</em>{" "}
          because its code happened to run. The verification claim was still
          unbacked; it just wasn&rsquo;t provably false.
        </li>
      </ul>
      <p>
        So the detector is sharpest against confident nonsense and most cautious
        against working code. That is exactly the shape you want, and the reverse
        of the cry-wolf failure everyone expects.
      </p>

      <h2>Does catching it actually help?</h2>
      <p>
        Detecting a bad claim is worth little if the agent can&rsquo;t act on it. So
        the second experiment closes the loop: take the auditor&rsquo;s objection,
        feed it back into the same session, and let the model try again.
      </p>
      <p>
        The best moment came from a floating-point trap. I asked a mid-tier model
        (Qwen 72B) to fix a rounding bug. It reached for the obvious fix,{" "}
        <code>Math.round(x * 100) / 100</code>, and declared victory. But that fix
        is <em>also</em> wrong &mdash; <code>1.005 * 100</code> is actually{" "}
        <code>100.49999999999999</code> in floating point, so it rounds to{" "}
        <code>1.00</code>, not <code>1.01</code>. Instead of nitpicking the wording,
        the auditor <em>did the arithmetic</em>, showed that the proposed fix still
        fails the exact input, and named the class of fix that would work. Next
        turn, the model applied a representation-safe version &mdash; and the real
        test suite went green. The correction landed because the objection demanded
        a change to <em>what was done</em>, not to how it was phrased.
      </p>

      <h2>What&rsquo;s still hard (because it is)</h2>
      <p>I&rsquo;d rather tell you the edges than let you find them:</p>
      <ul>
        <li>
          This is <strong>four models, one task family, one auditor, one run
          each.</strong> It&rsquo;s a sharp finding, not a proof. The obvious next
          steps &mdash; multiple runs for variance, a second auditor family, more
          task types &mdash; are exactly what would turn it into one.
        </li>
        <li>
          The reliable core is <strong>action plus verification</strong>: did the
          command run, what was the exit code. That part is close to un-gameable.
          Claims about <em>behavior</em>, <em>cause</em>, and <em>performance</em>
          are softer &mdash; a model can accurately describe correct code it simply
          never tested, and the auditor sometimes flags that too. Tightening that
          tier so it stops nagging about true-but-unproven statements is live work.
        </li>
      </ul>

      <h2>The part that had to ship upstream</h2>
      <p>
        A verifier is only useful if it can <em>warn</em> without <em>blocking.</em>{" "}
        Wire it to hard-block a turn and it deadlocks: the model re-claims, gets
        blocked, re-claims, forever. So it has to advise and let the next turn
        correct &mdash; which the Goose agent framework couldn&rsquo;t do. I found
        the failure, then contributed the missing hook primitives back to Goose (a
        non-blocking advisory channel), so a completion gate can be a{" "}
        <a href={GOOSE_PR_URL} target="_blank" rel="noopener noreferrer">
          gate and not a wall
        </a>
        .
      </p>

      <h2>Try it</h2>
      <p>
        The whole thing &mdash; the eval harness, the grid, the cross-vendor auditor
        &mdash; is open source as{" "}
        <a href={VERITAS_URL} target="_blank" rel="noopener noreferrer">
          veritaserum
        </a>
        : a portable ground-truth layer that catches false &ldquo;done&rdquo; claims
        by running a fresh judge from a different vendor on your harness&rsquo;s Stop
        hook. It&rsquo;s the same instinct behind{" "}
        <Link href="/">Trusty Squire</Link> &mdash; an agent you can actually trust
        needs guardrails it can&rsquo;t talk its way around. Would love feedback,
        especially from anyone who can break the finding.
      </p>
    </>
  );
}

export const POSTS: Post[] = [
  {
    slug: "your-coding-agent-lies-about-its-work",
    title: "Your coding agent lies about its work — and the better ones lie better",
    date: "10 July 2026",
    iso: "2026-07-10",
    description:
      "I measured how four AI coding models confabulate under load. Capability doesn't remove the lie, it moves it: weak models fake the code, frontier models fake the verification — and a cross-vendor auditor catches it cleanest exactly where it matters most.",
    Body: ConfabBody,
  },
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
