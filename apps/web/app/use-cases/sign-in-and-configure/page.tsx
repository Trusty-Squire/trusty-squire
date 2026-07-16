import Link from "next/link";
import { DiscoveryDetail } from "../../components/DiscoveryPages";
import { publicMetadata } from "../../lib/public-metadata";

const description =
  "Let your coding agent sign in to a website and configure webhooks, OAuth, projects, and other settings behind the login with Trusty Squire.";

export const metadata = publicMetadata(
  "Let your coding agent sign in and finish setup",
  description,
  "/use-cases/sign-in-and-configure",
);

export default function SignInAndConfigurePage() {
  return (
    <DiscoveryDetail
      breadcrumbs={[
        { name: "Home", path: "/" },
        { name: "Use cases", path: "/use-cases" },
        { name: "Sign in and configure", path: "/use-cases/sign-in-and-configure" },
      ]}
      eyebrow="Use case / sign in and configure"
      title="Let your coding agent sign in and finish setup"
      deck="Use a browser session you choose, then let Trusty Squire handle the settings, console, and integration work that lives behind the login."
      examples={[
        {
          prompt: "Sign in to Sentry and configure the webhook.",
          result:
            "Open the existing account, find the project settings, and finish the webhook setup.",
        },
        {
          prompt: "Add Google OAuth to my app without showing me the client secret.",
          result:
            "Move between the provider and application consoles while keeping the secret out of chat.",
        },
        {
          prompt: "Connect the services this app already uses.",
          result:
            "Complete related authenticated setup steps as one outcome instead of a dashboard scavenger hunt.",
        },
      ]}
      steps={[
        {
          title: "You choose the signed-in session",
          description:
            "Connect Google or GitHub in the Trusty Squire browser, or work with the provider session already present in that browser profile.",
        },
        {
          title: "Your agent reads the current page",
          description:
            "It sees the available controls and page state, then asks Trusty Squire to take one scoped action at a time.",
        },
        {
          title: "The browser completes the setup",
          description:
            "Trusty Squire clicks, types, and navigates through project settings while your coding agent keeps the requested outcome in view.",
        },
        {
          title: "Human decisions stay human",
          description:
            "If the site asks for payment, consent, a risky choice, or a gate that should not be guessed, the run stops and tells you what is needed.",
        },
      ]}
      related={[
        {
          href: "/use-cases/website-signup",
          title: "Start with a new account",
          description: "Let your coding agent work through the website signup first.",
        },
        {
          href: "/use-cases/api-keys-without-env",
          title: "Handle the resulting secret",
          description: "Store and use generated credentials without putting them in source code.",
        },
        {
          href: "/blog/the-last-mile-is-a-signup-form",
          title: "Why this work matters",
          description: "Read the story behind removing the last manual chore in agentic coding.",
        },
      ]}
    >
      <h3>Work behind auth is the point</h3>
      <p>
        General browser automation is easy to demo on a public page. Developer setup usually starts
        after a login: create a project, open a settings panel, register a callback URL, generate a
        key, or paste one value into a second console. Trusty Squire is built for that authenticated
        part of the job.
      </p>

      <h3>Cross-console secrets can stay sealed</h3>
      <p>
        Some integrations create a secret in one console and require it in another. Trusty Squire
        can capture that value into a sealed in-session slot and type it at the destination without
        placing the plaintext in the agent conversation. Read more about the credential boundary in
        the <Link href="/use-cases/api-keys-without-env">API key guide</Link>.
      </p>

      <h3>A real browser, not your password in a prompt</h3>
      <p>
        You perform the identity connection in a browser. The agent drives the resulting website
        session, but it does not need your Google or GitHub password to do so. Reauthentication and
        account switching remain explicit user actions.
      </p>
    </DiscoveryDetail>
  );
}
