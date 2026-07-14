import { DiscoveryDetail } from "../../components/DiscoveryPages";
import { publicMetadata } from "../../lib/public-metadata";

const description =
  "Connect Trusty Squire to Claude Code, then ask Claude to sign up for websites, configure services, and use saved credentials without returning raw values.";

export const metadata = publicMetadata(
  "Sign up and sign in to websites from Claude Code",
  description,
  "/integrations/claude-code",
);

export default function ClaudeCodeIntegrationPage() {
  return (
    <DiscoveryDetail
      eyebrow="Integration / Claude Code"
      title="Sign up and sign in to websites from Claude Code"
      deck="Connect Trusty Squire to Claude Code, then describe the website outcome you want. The installer merges the squire server into Claude's existing MCP configuration."
      installCommand="npx @trusty-squire/mcp@latest connect --target=claude-code"
      examples={[
        {
          prompt: "Sign me up for Resend and save the API key.",
          result:
            "Claude plans the task while Trusty Squire drives the website and stores the generated credential.",
        },
        {
          prompt: "Add Google OAuth without showing me the client secret.",
          result:
            "Move through the provider and application consoles without copying the secret into the conversation.",
        },
        {
          prompt: "That app token leaked. Revoke its access now.",
          result: "Let Claude select the scoped grant while Trusty Squire performs the revocation.",
        },
      ]}
      steps={[
        {
          title: "Run the Claude Code target",
          description:
            "The connect command opens the Trusty Squire sign-in flow and writes an MCP server named squire to ~/.claude.json.",
        },
        {
          title: "Restart Claude Code",
          description:
            "A fresh session loads the new MCP server and its website-operation and credential tools.",
        },
        {
          title: "Ask for the finished outcome",
          description:
            "Name the website and what your project needs. Claude can plan the job and drive Trusty Squire one browser step at a time.",
        },
      ]}
      related={[
        {
          href: "/use-cases/website-signup",
          title: "Website signup",
          description: "See the full signup and verification job.",
        },
        {
          href: "/integrations/codex",
          title: "Using Codex instead?",
          description: "Install the same MCP server in Codex CLI.",
        },
        {
          href: "/integrations/cursor",
          title: "Using Cursor instead?",
          description: "Connect Trusty Squire to Cursor's MCP configuration.",
        },
      ]}
    >
      <h3>Files the installer updates</h3>
      <p>
        Claude Code reads MCP servers from <code>~/.claude.json</code>. The installer merges a{" "}
        <code>squire</code> entry into that file and preserves the other server entries it can read.
        It also adds safe, frequently used credential tools to <code>~/.claude/settings.json</code>.
        Destructive or exposing paths stay on Claude Code’s normal confirmation behavior.
      </p>

      <h3>Reconnect without rebuilding the config</h3>
      <p>
        Running the same connect command again refreshes the Trusty Squire entry. If the browser
        identity is stale or you need to switch accounts, rerun it with <code>--force-relogin</code>
        . Restart Claude Code after a config change so the server is loaded again.
      </p>

      <h3>Claude plans; the squire operates</h3>
      <p>
        Claude keeps the development goal in context. Trusty Squire supplies the scoped browser and
        credential boundary needed to finish work on the real website. You can observe progress and
        step in when a site needs a decision that should be yours.
      </p>
    </DiscoveryDetail>
  );
}
