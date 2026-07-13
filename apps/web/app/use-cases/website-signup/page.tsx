import { DiscoveryDetail } from "../../components/DiscoveryPages";
import { publicMetadata } from "../../lib/public-metadata";

const description =
  "Let Claude Code, Codex, Cursor, or another coding agent sign up for websites, work through verification, and save generated API keys to your vault.";

export const metadata = publicMetadata(
  "Let your coding agent sign you up for websites",
  description,
  "/use-cases/website-signup",
);

export default function WebsiteSignupPage() {
  return (
    <DiscoveryDetail
      eyebrow="Use case / website signup"
      title="Let your coding agent sign you up for websites"
      deck="Trusty Squire opens the real signup page, works through the flow one step at a time, and saves generated credentials directly to your vault."
      examples={[
        {
          prompt: "Sign me up for Resend and save the API key.",
          result:
            "Create the account, complete the available verification steps, and store the generated key.",
        },
        {
          prompt: "Create a PostHog account for this new app.",
          result: "Move from the public signup page into the authenticated project setup.",
        },
        {
          prompt: "Set up Resend, Sentry, PostHog, and Postgres for this app.",
          result: "Work through several service signups as one project outcome.",
        },
      ]}
      steps={[
        {
          title: "Your agent names the website and outcome",
          description:
            "You ask from the coding agent you already use. The request can include the account, project, or credential you need at the end.",
        },
        {
          title: "Trusty Squire opens the real signup flow",
          description:
            "A scoped browser session loads the provider website. Your agent observes the current page and chooses one action at a time.",
        },
        {
          title: "Verification is handled when it can be",
          description:
            "The flow can work with available email verification steps and a Google or GitHub session you explicitly connect.",
        },
        {
          title: "The resulting credential goes to the vault",
          description:
            "Generated keys can be captured and stored without returning the raw value to the agent or writing it into your repository.",
        },
      ]}
      related={[
        {
          href: "/use-cases/sign-in-and-configure",
          title: "Already have the account?",
          description: "Sign in and let your agent finish the configuration work.",
        },
        {
          href: "/use-cases/api-keys-without-env",
          title: "Keep the API key out of .env",
          description: "Use stored credentials without handing the provider key to your app.",
        },
        {
          href: "/integrations",
          title: "Choose your coding agent",
          description: "Connect Trusty Squire to Claude Code, Codex, Cursor, and more.",
        },
      ]}
    >
      <h3>Use service names as requests, not support promises</h3>
      <p>
        Resend, PostHog, Sentry, and Postgres are concrete examples of the work developers ask for.
        Website flows change, and some services add gates that require you. Trusty Squire should
        report that boundary clearly rather than pretending a blocked signup completed.
      </p>

      <h3>Your identity stays under your control</h3>
      <p>
        Trusty Squire does not ask your agent to type your Google or GitHub password. You connect
        those accounts in a real browser. The browser can then keep that session for a signup method
        you choose.
      </p>

      <h3>Success means the setup is usable</h3>
      <p>
        The useful endpoint is not merely an account record. It is the project, integration, or API
        credential your code needs. If a site creates a secret, Trusty Squire can store it directly
        so the signup does not end with a manual copy-and-paste chore.
      </p>
    </DiscoveryDetail>
  );
}
