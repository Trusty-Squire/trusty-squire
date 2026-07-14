import { DiscoveryDetail } from "../../components/DiscoveryPages";
import { publicMetadata } from "../../lib/public-metadata";

const description =
  "Connect Trusty Squire to Codex CLI so Codex can sign up for websites, configure services, and use credentials without returning their raw values.";

export const metadata = publicMetadata(
  "Sign up and sign in to websites from Codex",
  description,
  "/integrations/codex",
);

export default function CodexIntegrationPage() {
  return (
    <DiscoveryDetail
      eyebrow="Integration / Codex CLI"
      title="Sign up and sign in to websites from Codex"
      deck="Connect Trusty Squire to Codex so it can finish browser setup work and use saved credentials without returning their raw values."
      installCommand="npx @trusty-squire/mcp@latest connect --target=codex"
      examples={[
        {
          prompt: "Sign in to Sentry and configure the webhook.",
          result:
            "Codex keeps the integration goal in view while Trusty Squire works behind the login.",
        },
        {
          prompt: "Set up Resend, Sentry, PostHog, and Postgres for this app.",
          result: "Coordinate several provider setups from the same coding session.",
        },
        {
          prompt: "Let my app call OpenAI without giving it the OpenAI key.",
          result: "Create scoped app access instead of placing the provider key in the project.",
        },
      ]}
      steps={[
        {
          title: "Run the Codex target",
          description:
            "The connect command signs this machine in and merges the squire server into ~/.codex/config.toml.",
        },
        {
          title: "Restart Codex",
          description:
            "Start a fresh Codex session so it discovers the newly configured MCP tools.",
        },
        {
          title: "Describe the website job",
          description:
            "Ask for the signup, authenticated setting, or credential outcome your code needs. Codex can then operate the website through Trusty Squire.",
        },
      ]}
      related={[
        {
          href: "/use-cases/sign-in-and-configure",
          title: "Sign in and configure",
          description: "See how authenticated setup work is handled.",
        },
        {
          href: "/integrations/claude-code",
          title: "Using Claude Code instead?",
          description: "Connect the squire MCP server to Claude Code.",
        },
        {
          href: "/integrations/cursor",
          title: "Using Cursor instead?",
          description: "Connect the squire MCP server to Cursor.",
        },
      ]}
    >
      <h3>Your Codex settings stay intact</h3>
      <p>
        Codex reads MCP configuration from <code>~/.codex/config.toml</code>. The installer parses
        that TOML, adds or refreshes the <code>[mcp_servers.squire]</code> entry, and writes the
        combined config back. Existing model, approval policy, sandbox, and other MCP settings are
        preserved by the merge.
      </p>

      <h3>Refresh or switch the browser identity</h3>
      <p>
        Rerun the connect command to refresh the MCP entry. Add <code>--force-relogin</code> when
        you need to replace a stale connected session or switch the Google or GitHub identity used
        by the Trusty Squire browser.
      </p>

      <h3>Keep the provider key out of the workspace</h3>
      <p>
        Codex can refer to a saved credential or ask Trusty Squire to make an authenticated call
        without receiving the plaintext. That keeps the raw provider key out of the transcript,
        generated code, and local <code>.env</code> file.
      </p>
    </DiscoveryDetail>
  );
}
