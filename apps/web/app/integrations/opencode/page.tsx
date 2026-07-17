import { DiscoveryDetail } from "../../components/DiscoveryPages";
import { JsonLd } from "../../components/JsonLd";
import { publicMetadata } from "../../lib/public-metadata";
import { faqPageJsonLd, type FaqItem } from "../../lib/structured-data";

const description =
  "Connect the Trusty Squire MCP server to OpenCode so it can automate supported website signups and store generated API keys outside agent context and .env.";

const FAQS: readonly FaqItem[] = [
  {
    question: "Does Trusty Squire work with OpenCode?",
    answer:
      "Yes. Trusty Squire runs as a local stdio MCP server, and the connect command adds it to OpenCode's global MCP configuration.",
  },
  {
    question: "Where does Trusty Squire configure OpenCode?",
    answer:
      "It updates the effective OpenCode global JSON or JSONC config, respecting OPENCODE_CONFIG and XDG_CONFIG_HOME. Existing settings, comments, and other MCP servers are preserved.",
  },
  {
    question: "Can OpenCode use an API key without putting it in .env?",
    answer:
      "Yes. Trusty Squire's credential tools use vault references and server-side injection instead of returning the stored provider key to OpenCode. A separately issued app grant token can enter context and must still be handled as a backend secret.",
  },
  {
    question: "Can OpenCode automate every website signup?",
    answer:
      "No. Trusty Squire stops when a site requires a phone, hard CAPTCHA, payment, or a decision that belongs to a person instead of guessing or claiming success.",
  },
];

export const metadata = publicMetadata(
  "OpenCode MCP server for website signup automation",
  description,
  "/integrations/opencode",
);

export default function OpenCodeIntegrationPage() {
  return (
    <>
      <JsonLd data={faqPageJsonLd(FAQS)} />
      <DiscoveryDetail
        breadcrumbs={[
          { name: "Home", path: "/" },
          { name: "Agent integrations", path: "/integrations" },
          { name: "OpenCode", path: "/integrations/opencode" },
        ]}
        eyebrow="Integration / OpenCode"
        title="Let OpenCode sign up for websites and keep API keys out of context"
        deck="Connect Trusty Squire as a local OpenCode MCP server. OpenCode plans the development job while Trusty Squire operates the real website and stores generated credentials behind a write-only boundary."
        installCommand="npx @trusty-squire/mcp connect --target=opencode"
        examples={[
          {
            prompt: "Use Trusty Squire to sign up for Resend and wire the API key into my app.",
            result:
              "OpenCode keeps the application goal in view while Trusty Squire completes the supported website flow and saves the generated key.",
          },
          {
            prompt: "Set up Clerk without putting its secret key in this chat or .env.",
            result:
              "The provider credential is captured into the encrypted vault instead of being returned as model-visible plaintext.",
          },
          {
            prompt: "Sign in to Sentry and configure the webhook this project needs.",
            result:
              "OpenCode can plan authenticated setup work while Trusty Squire handles the real browser session.",
          },
        ]}
        steps={[
          {
            title: "Run the OpenCode target",
            description:
              "The connect command signs this machine in and adds a local squire server to OpenCode's effective global JSON or JSONC configuration.",
          },
          {
            title: "Restart OpenCode",
            description:
              "Start a fresh OpenCode session so it connects to the server and loads the Trusty Squire MCP tools.",
          },
          {
            title: "Ask for the website outcome",
            description:
              "Name the service and the setup your application needs. OpenCode plans the work and calls Trusty Squire for browser and credential operations.",
          },
        ]}
        related={[
          {
            href: "/use-cases/website-signup",
            title: "Automate a website signup",
            description: "See how an agent moves from a signup page to a stored credential.",
          },
          {
            href: "/guides/keep-api-keys-out-of-ai-agent-context",
            title: "Keep keys out of agent context",
            description: "Understand the trust boundary around model-visible secrets.",
          },
          {
            href: "/integrations/codex",
            title: "Using Codex instead?",
            description: "Connect the same MCP server to Codex CLI.",
          },
        ]}
      >
        <h3>Your OpenCode settings and comments stay intact</h3>
        <p>
          OpenCode normally reads <code>~/.config/opencode/opencode.json</code> or{" "}
          <code>opencode.jsonc</code>. The installer respects custom <code>OPENCODE_CONFIG</code>{" "}
          and <code>XDG_CONFIG_HOME</code> locations, then makes a targeted JSONC-aware edit. It
          preserves comments, models, providers, permissions, plugins, and unrelated MCP servers.
        </p>

        <h3>Control when the MCP tools are available</h3>
        <p>
          OpenCode exposes enabled MCP tools to the model. Set the squire server's{" "}
          <code>enabled</code> field to <code>false</code> when you do not need it, or use an
          OpenCode permission such as <code>&quot;squire_*&quot;: &quot;ask&quot;</code> when you
          want approval before its tool calls. The installer does not overwrite your permission
          policy.
        </p>

        <h3>The provider key remains behind the vault boundary</h3>
        <p>
          Trusty Squire's credential tools return references and authenticated results, not stored
          plaintext. The provider key does not need to enter OpenCode's transcript, generated
          source, or local <code>.env</code>. Browser diagnostics can still contain whatever a
          website visibly renders, so avoid re-observing a page after it displays a secret.
        </p>

        {FAQS.map((faq) => (
          <section key={faq.question}>
            <h3>{faq.question}</h3>
            <p>{faq.answer}</p>
          </section>
        ))}
      </DiscoveryDetail>
    </>
  );
}
