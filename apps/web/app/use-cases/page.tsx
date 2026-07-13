import Link from "next/link";
import { DiscoveryHub } from "../components/DiscoveryPages";
import { publicMetadata } from "../lib/public-metadata";

const description =
  "See how Trusty Squire lets coding agents sign up for websites, work behind logins, and use API keys without putting them in chat, code, or .env files.";

export const metadata = publicMetadata("What Trusty Squire can do", description, "/use-cases");

const ITEMS = [
  {
    href: "/use-cases/website-signup",
    title: "Sign up for websites",
    description:
      "Let your coding agent work through a real signup flow, handle verification, and save the generated credential.",
  },
  {
    href: "/use-cases/sign-in-and-configure",
    title: "Sign in and finish setup",
    description:
      "Use an existing browser session, then complete settings and console work behind the login.",
  },
  {
    href: "/use-cases/api-keys-without-env",
    title: "Use API keys without .env",
    description:
      "Keep provider keys out of chat and source code while your agent and deployed app use them safely.",
  },
];

export default function UseCasesPage() {
  return (
    <DiscoveryHub
      eyebrow="Use cases"
      title="Give your coding agent the website work"
      deck="Trusty Squire handles the signup, sign-in, configuration, and credential steps that normally pull you out of your editor."
      items={ITEMS}
    >
      <h2>One ask, a visible job</h2>
      <div>
        <p>
          Ask for the outcome in ordinary language. Trusty Squire opens the real website and your
          coding agent chooses each next step. If the job creates an API key or client secret, the
          credential can be stored without being returned through the credential tools.
        </p>
        <p>
          These pages describe job types, not a promise that every website will cooperate. A site
          can still require a phone, a hard captcha, payment, or a decision that belongs to you. In
          those cases, the run stops instead of guessing.{" "}
          <Link href="/start">Install Trusty Squire</Link> when you are ready to try one of the
          asks.
        </p>
      </div>
    </DiscoveryHub>
  );
}
