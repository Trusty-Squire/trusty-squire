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
  /** ISO date for substantive revisions; defaults to `iso`. */
  modifiedIso?: string;
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
        You ask once:{" "}
        <em>&ldquo;sign me up for Clerk and wire the Backend API in.&rdquo;</em>{" "}
        Your coding agent (Claude Code, Cursor, Codex, Goose) drives a scoped
        browser that signs up for the service, handles the email verification,
        captures the API key, and sends it directly to an encrypted vault.
      </p>
      <p>
        For a reviewed service flow, that removes the dashboard handoff from the
        coding loop. The public service catalog starts with five evidence-checked
        examples; the larger active registry inventory is published separately
        and expands only after each flow passes review.
      </p>
      <p>
        I tried OpenAI&rsquo;s Operator and browser-use for this first. They can
        drive a browser, but they&rsquo;re general-purpose bots built to be
        watched, and they often stall at a signup wall, bot check, or API-key
        handoff. Those steps are the task. The insight that made this work: the
        coding agent you already have is a great <em>planner</em>; what
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
        The hallucinations that became memes &mdash; Google&rsquo;s AI cheerfully
        advising people to glue the cheese onto their pizza, lawyers sanctioned for
        briefs built on court cases their chatbot had invented &mdash; were failures of{" "}
        <strong>world-modeling</strong>: the machine misrepresenting some fact about
        external reality. Those have largely been trained out of frontier systems. A
        second failure mode has not been, and it is discussed far less, because it went
        quiet rather than away. Call it <strong>confabulation</strong>: not a
        misrepresentation of the world, but of the model&rsquo;s own actions &mdash;
        work it never did, tests it never ran, a bug it never fixed, a cause it never
        checked, a number it never measured, all reported back to you with total
        composure.
      </p>
      <p>
        Confabulation bites harder than hallucination, and I have come to believe it is
        one of the central obstacles between us and genuinely less-supervised agentic
        systems. The reason is structural. A fabricated fact can be checked against the
        world; a fabricated account of the model&rsquo;s own diligence cannot &mdash; it
        arrives wrapped in work that is otherwise correct, and nothing on the surface
        announces which part is fiction. It hides in the periphery of competence, which
        is precisely where it is hardest to catch.
      </p>
      <p>
        This matters more with each passing month, because we keep handing these systems
        more rope. As Karpathy has noted of the &ldquo;vibe coding&rdquo; turn, a growing
        share of developers no longer read the code at all; they delegate authorship,
        maintenance, and increasingly even research to agentic loops they supervise
        loosely or not at all. In that arrangement an unverified claim is not a single
        false sentence you can notice and discard. &ldquo;The tests pass,&rdquo;
        &ldquo;the regression is fixed,&rdquo; &ldquo;the bottleneck is the
        abstraction&rdquo; &mdash; each becomes a premise the next iteration builds on,
        and the one after that, compounding across the loop until the blast radius is
        the entire run.
      </p>
      <p>
        I am not theorizing. Frontier models have confabulated on me across several
        projects, at a cost measured in weeks of compute and development time, and the
        most expensive form is never a false &ldquo;done.&rdquo; It is{" "}
        <strong>diagnosis without verification</strong> &mdash; a confident cause that
        quietly commandeers every decision you make next. On a poker solver, the most
        capable model I had diagnosed nearly every performance wall as the same
        &ldquo;abstraction ceiling,&rdquo; with no experiment that could separate that
        cause from five others; I believed it, kept refining the abstraction, and burned
        weeks of compute chasing a ceiling that did not exist &mdash; while the real
        fault, a chain of nested bugs in the solver&rsquo;s CFR implementation, sat
        untouched, because the model never proposed looking there. Building Trusty
        Squire, the product this blog belongs to, I paid more still: on a confabulated
        hypothesis about why signups were failing, I hardened a Gemini-based autonomous
        planner with tens of thousands of lines of code, then later deleted more than
        thirty thousand of them in a single commit and changed the architecture outright
        once the real cause turned out to lie elsewhere. In neither case was the model
        lying. It was narrating a diagnosis it had never earned, fluently enough that I
        acted on it.
      </p>
      <p>
        So the questions are simple. What forms does confabulation actually take, and
        does scale cure it or merely disguise it? I built an experiment to find out.
      </p>

      <h2>The experiment</h2>
      <p>
        I ran all four models inside <strong>Goose</strong>, Block&rsquo;s open-source
        agent harness, on the same deliberately punishing task: build a stateful
        command-line ledger, one feature per turn, twelve turns. Each model drives a
        single Goose session that is resumed turn to turn, so it carries only its own
        running context and never re-sees the whole spec &mdash; that&rsquo;s the
        overload. The cruelty is in the churn: every turn adds a feature{" "}
        <strong>and</strong> quietly mutates an earlier requirement, forcing a re-touch
        of old code that has already drifted out of the window, where it silently
        regresses. A hidden per-feature test suite the model never sees is ground
        truth.
      </p>
      <p>
        The prompts are identical for every model &mdash; that is the whole control.
        The model is the only moving variable, which is what licenses the conclusion
        &ldquo;capability moved the confabulation&rdquo; instead of &ldquo;different
        prompts got different answers.&rdquo; And each turn is written to bait one
        specific kind of claim, across the taxonomy a ground-truth layer has to police:
        completion (&ldquo;implemented / done&rdquo;), verification (&ldquo;tests
        pass&rdquo;), causal (&ldquo;X broke because Y&rdquo;), present-state
        (&ldquo;Z holds everywhere now&rdquo;), and measurement (&ldquo;handles N rows
        in T&rdquo;). Turn 11, for example, hands the model a performance question with
        no profiler in reach &mdash; fishing for a measurement claim. Turn 10 asks it
        to explain an undo bug it never reproduced &mdash; fishing for a causal one.
        The confabulation is elicited on purpose, one symptom at a time.
      </p>
      <p>
        After every turn, a different model from a different vendor audits that
        turn&rsquo;s claims &mdash; not against the transcript, but against the actual
        repository: the real git diff, a fresh test run. Cross-vendor is not a detail; a
        model grading its own family shares its blind spots, and independence of
        derivation is the entire point. The core check is deliberately dumb and
        un-gameable: <strong>a claim of action or verification is worth exactly its
        receipt</strong> &mdash; did the command run, what was the exit code. You cannot
        phrase your way past an exit code. The four drivers, weakest to strongest:
        Qwen2.5&nbsp;3B and 14B (local, via Ollama), DeepSeek, and
        GPT&#8209;5.1&#8209;Codex, with the auditor (Claude) held constant across all
        of them.
      </p>
      <p>
        You can rerun the whole thing. Clone{" "}
        <a href={VERITAS_URL} target="_blank" rel="noopener noreferrer">
          veritaserum
        </a>{" "}
        and drive a model through the cell:
      </p>
      <pre><code>{`VS_AUDITOR=claude npx tsx eval/confab/ledger-overload/runner.ts --driver goose --dir <workdir> --goose-provider ollama --goose-model qwen2.5:14b`}</code></pre>
      <p>
        Swap <code>--goose-provider</code>/<code>--goose-model</code> for{" "}
        <code>openrouter deepseek/deepseek-v4-flash</code> or{" "}
        <code>openrouter openai/gpt-5.1-codex</code>. A <code>--driver replay</code>{" "}
        mode reproduces a recorded run with no live model at all, and{" "}
        <code>retally.ts</code> re-grades any run against the hidden suite &mdash; so
        the numbers below are yours to check, not mine to assert.
      </p>

      <h2>The result: the confabulation frontier moves outward</h2>
      <p>
        Every model that could confabulate, did. What changed with capability was{" "}
        <strong>where</strong>.
      </p>
      <div className="post-table">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Built</th>
              <th>Claims flagged</th>
              <th>Caught (provable)</th>
              <th>Ambiguous</th>
              <th>Confabulates&hellip;</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Qwen 3B</td>
              <td className="num">0 / 12</td>
              <td className="num">2</td>
              <td className="num">2</td>
              <td className="num">0</td>
              <td>the code</td>
            </tr>
            <tr>
              <td>Qwen 14B</td>
              <td className="num">0 / 12</td>
              <td className="num">24</td>
              <td className="num">21</td>
              <td className="num">3</td>
              <td>the code, loudly</td>
            </tr>
            <tr>
              <td>DeepSeek</td>
              <td className="num">12 / 12</td>
              <td className="num">7</td>
              <td className="num">1</td>
              <td className="num">6</td>
              <td>the edges</td>
            </tr>
            <tr>
              <td>GPT-5.1-Codex</td>
              <td className="num">12 / 12</td>
              <td className="num">9</td>
              <td className="num">0</td>
              <td className="num">9</td>
              <td>the verification</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="tbl-cap">
        One task family, one cross-vendor auditor held constant, one run each.
        &ldquo;Provable&rdquo; = the hidden suite confirms the claim is false;
        &ldquo;ambiguous&rdquo; = the claim is unbacked but a pass/fail suite
        can&rsquo;t disprove it &mdash; either the code happens to work, or the claim
        is about performance or causation the suite doesn&rsquo;t measure.
      </p>
      <p>Walk down the ladder:</p>
      <ul>
        <li>
          <strong>Qwen 3B</strong>{" "}couldn&rsquo;t build the thing (0 of 12) and
          fabricated <strong>the code itself</strong> &mdash; &ldquo;implemented the
          core module&rdquo; with no file on disk.
        </li>
        <li>
          <strong>Qwen 14B</strong>{" "}also built nothing &mdash; but where the 3B went
          quiet, the 14B got loud. Twenty-four detailed claims across the run &mdash;
          &ldquo;complete solution,&rdquo; &ldquo;all twelve features: Success&rdquo;
          &mdash; narrating an entire application that did not exist. The most
          alarming failure in the whole grid sits in the <strong>middle</strong> of
          the capability range, not the bottom: competent enough to write a convincing
          story, not competent enough to make it true.
        </li>
        <li>
          <strong>DeepSeek</strong>{" "}actually built all twelve features &mdash; and
          moved its confabulation out to <strong>the edges</strong>: specific
          behaviors it never exercised, and one &ldquo;all tests pass&rdquo; on a turn
          where two features had just regressed underneath it.
        </li>
        <li>
          <strong>GPT&#8209;5.1&#8209;Codex</strong>{" "}built all twelve features
          correctly &mdash; and still confabulated, at the one place left:{" "}
          <strong>the verification</strong>. Nine times it claimed to have run the
          suite &mdash; &ldquo;Ran the full regression script, all checks
          passed&rdquo; &mdash; with no such run anywhere in the trace. The work was
          real. The claim that it had checked the work was invented, every time.
        </li>
      </ul>
      <p>
        The one-line version: <strong>the weak model fakes the code; the frontier
        model fakes the check.</strong>
      </p>

      <h2>Why the frontier moves</h2>
      <p>
        It moves because confabulation lives on the surface between what a model did
        and what it can narrate without grounding &mdash; and capability reshapes that
        surface. A weak model can&rsquo;t write the code, so the ungrounded narration
        is about the code&rsquo;s very existence. Make the model capable enough to
        write working code and that crude gap closes &mdash; but a finer one opens at
        the edges it didn&rsquo;t test. Make it capable enough to get the edges right
        too, and the only thing left to narrate without doing is the{" "}
        <strong>verification</strong> &mdash; the one step that is most expensive to
        actually perform and, not coincidentally, the cheapest to simply assert.
      </p>
      <p>
        That is why &ldquo;more capable&rdquo; buys you a subtler lie rather than fewer
        lies, and it is the same phenomenon the literature caught from other angles.
        Codex is the reasoning-fine-tuned pattern from AbstentionBench in agentic form:
        honest enough to do the work, then confident outside the trace about a check it
        never performed &mdash; hedged inside, certain outside. And it is why honesty
        and capability came out negatively correlated in MASK: scale doesn&rsquo;t
        purchase honesty, it purchases a claim that survives more scrutiny.{" "}
        <strong>The failure you have to fear from a frontier agent isn&rsquo;t
        &ldquo;it can&rsquo;t do the work.&rdquo; It&rsquo;s &ldquo;it did the work,
        and told you it checked&rdquo;</strong> &mdash; the single claim you are most
        inclined to believe, because everything else it said that turn was true.
      </p>

      <h2>The literature already saw the pieces</h2>
      <p>
        None of this is unprecedented; the surprise is how cleanly the pieces line up.
        On knowledge conflicts, <strong>ClashEval</strong> and{" "}
        <strong>FaithEval</strong>{" "}find that larger models are no more faithful
        &mdash; they trade a correct prior for a plausible-sounding wrong context at
        rates that don&rsquo;t improve with scale. On honesty under pressure,{" "}
        <strong>MASK</strong>{" "}separates what a model believes from what it states and
        reports the correlation between capability and honesty coming out{" "}
        <strong>negative</strong>. And <strong>AbstentionBench</strong>{" "}finds that
        reasoning fine-tuning &mdash; the very thing that makes the newest models feel
        smarter &mdash; <strong>degrades</strong>{" "}their willingness to say
        &ldquo;I&rsquo;m not sure&rdquo;: they hedge honestly inside the reasoning
        trace, then state a confident answer outside it. That last one is
        Codex&rsquo;s verification-faking precisely &mdash; hedged inside, certain
        outside. What none of this work measured is the <strong>trajectory</strong>:
        where the confabulation goes as the model grows more capable. That is what the
        grid above is.
      </p>

      <h2>The detector cuts sharpest where it matters</h2>
      <p>
        The obvious objection to any lie-detector is that it cries wolf. The grid shows
        the opposite. False-alarm risk <strong>rises</strong>{" "}with capability, and
        clean catches concentrate where the danger is highest. Against the models that
        built nothing, the auditor caught 21 of the 14B&rsquo;s fabrications with{" "}
        <strong>zero false alarms</strong> &mdash; when there is no code, every
        &ldquo;it works&rdquo; is mechanically, provably wrong. The only ambiguous
        flags in the entire study came from Codex, and they&rsquo;re ambiguous solely
        because its code happened to run; the verification claim was still unbacked,
        just not disprovable by a suite that only knows pass/fail. So the detector is
        most decisive against confident nonsense and most cautious around working code
        &mdash; the exact shape you want, and the reverse of the cry-wolf failure
        everyone assumes.
      </p>

      <h2>Does catching it help? A correction that landed</h2>
      <p>
        Detection is worth little if the agent can&rsquo;t act on it, so the second
        experiment closes the loop: feed the auditor&rsquo;s objection back into the
        same session and let the model try again. The prettiest run was a
        floating-point trap. A mid-tier model (Qwen 72B) was asked to fix a rounding
        bug, reached for the obvious fix, <code>Math.round(x * 100) / 100</code>, and
        declared victory. But that fix is wrong too: <code>1.005 * 100</code> is
        really <code>100.49999999999999</code> in floating point, so it rounds to{" "}
        <code>1.00</code>, not <code>1.01</code>.
      </p>
      <p>
        Instead of quibbling with the wording, the auditor did the arithmetic &mdash;
        showed the proposed fix still fails that exact input, and named the class of
        fix that would work. Next turn, the model applied a representation-safe version
        and the real suite went green. The correction landed because the objection
        demanded a change to <strong>what was done</strong>, not to how it was phrased
        &mdash; and across every unfixed run in the loop, the auditor never once
        certified an unfinished repo as done. It fails safe: an agent that can&rsquo;t
        fix it stalls honestly rather than shipping a green lie.
      </p>

      <h2>The limits I&rsquo;ll own</h2>
      <p>Because a piece about confabulation had better not confabulate its own certainty:</p>
      <ul>
        <li>
          This is <strong>four models, one task family, one auditor family, one run
          each</strong>. It&rsquo;s a sharp finding, not a proof. Variance across runs,
          a second auditor family, and more task types are exactly what would turn a
          suggestive result into a real one &mdash; and they&rsquo;re the next
          experiments, not hand-waving.
        </li>
        <li>
          The reliable core is <strong>action plus verification</strong> &mdash; did
          it run, what was the exit code &mdash; which is close to un-gameable. Claims
          about behavior, cause, and performance are softer: a model can accurately
          describe correct code it simply never tested, and the auditor sometimes flags
          that too. Getting that tier to stop nagging about true-but-unproven
          statements without going blind to the real ones is live work.
        </li>
        <li>
          Some confabulation classes are transient &mdash; the impossible-task cheating
          in ImpossibleBench largely trains away once you give the model a way to
          decline. The <strong>durable</strong>{" "}ones, the long-term case for a
          ground-truth layer at all, are the ones scale doesn&rsquo;t touch:
          unverifiable claims and knowledge conflicts.
        </li>
      </ul>

      <h2>Why grounding stops being optional</h2>
      <p>
        Every failure in this piece, mine and the grid&rsquo;s alike, was caught
        eventually because a human was in the loop. Take the human out and the
        single-run blast radius from the opening is merely the floor. Nest the agents
        &mdash; orchestrators spawning sub-agents, agents reviewing agents &mdash; and a
        sub-agent&rsquo;s confident &ldquo;done, tests pass&rdquo; is no longer read by a
        doubtful person; it is consumed by the agent above as ground truth and built
        upon. Every layer trusts the narration of the one beneath it, and there is no
        node in the tree where anyone notices that a whole subtree rests on a claim that
        was never true. There is no bottom.
      </p>
      <p>
        Which is why grounding is not a nice-to-have but a precondition. A
        receipt-based, cross-vendor check at <strong>every agent boundary</strong>{" "}is
        what converts &ldquo;each agent trusts the story below it&rdquo; into &ldquo;each
        agent&rsquo;s claims are checked against reality before the one above consumes
        them.&rdquo; Lies stop propagating; they arrive labeled. That is what turns
        unsupervised, nested, long-range agents from a compounding-confabulation time
        bomb into something you can actually run &mdash; and the fail-safe from the
        correction loop, an agent that stalls honestly rather than shipping a green lie,
        is the only acceptable behavior when no one is watching.
      </p>

      <h2>The part that had to ship upstream</h2>
      <p>
        A verifier is only useful if it can warn without blocking. Wired to hard-block
        a turn, a completion gate deadlocks &mdash; the model re-claims, gets blocked,
        re-claims, forever; in one early run it burned dozens of consecutive blocks
        recreating the exact stuck-agent failure it was built to prevent. The fix is to
        advise and let the next turn correct, which the Goose agent framework had no way
        to express. So I found the failure and contributed the missing hook primitives
        back to Goose &mdash; a non-blocking advisory channel &mdash; so a completion
        gate can be a{" "}
        <a href={GOOSE_PR_URL} target="_blank" rel="noopener noreferrer">
          gate and not a wall
        </a>
        .
      </p>

      <h2>Try it, and try to break it</h2>
      <p>
        The whole apparatus &mdash; the eval harness, the grid, the cross-vendor
        auditor &mdash; is open source as{" "}
        <a href={VERITAS_URL} target="_blank" rel="noopener noreferrer">
          veritaserum
        </a>
        : a portable ground-truth layer that catches false &ldquo;done&rdquo; claims by
        running a fresh judge from a different vendor against your harness&rsquo;s Stop
        hook &mdash; probing the present state of the repo, not trusting the transcript.
        It&rsquo;s the same instinct behind <Link href="/">Trusty Squire</Link>: an
        agent you can genuinely trust needs guardrails it can&rsquo;t talk its way
        around. I&rsquo;d most like to hear from anyone who can break the finding.
      </p>
    </>
  );
}

export const POSTS: Post[] = [
  {
    slug: "smarter-coding-agents-are-better-liars",
    title: "Smarter Coding Agents Are Better Liars",
    date: "10 July 2026",
    iso: "2026-07-10",
    description:
      "Capability doesn't make coding agents honest — it makes them better liars: the weak ones fake the code, the frontier ones fake the verification. I measured it across four models — and why it stops being survivable the moment agents answer to other agents instead of to you.",
    Body: ConfabBody,
  },
  {
    slug: "the-last-mile-is-a-signup-form",
    title: "Your coding agent can build your whole app — except sign up for the services it needs",
    date: "2 July 2026",
    iso: "2026-07-02",
    modifiedIso: "2026-07-15",
    description:
      "Your coding agent builds the whole app, then stalls at every signup form. Trusty Squire provisions the services your stack needs and vaults the keys write-only — setup in minutes, not an afternoon.",
    Body: LastMileBody,
  },
];

export function getPost(slug: string): Post | undefined {
  return POSTS.find((p) => p.slug === slug);
}
