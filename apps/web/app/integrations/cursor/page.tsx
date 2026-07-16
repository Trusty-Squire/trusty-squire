import { DiscoveryDetail } from "../../components/DiscoveryPages";
import { publicMetadata } from "../../lib/public-metadata";

const description =
  "Connect Trusty Squire to Cursor, then ask Cursor to sign up for websites, configure services, and use API credentials without copying them into your project.";

export const metadata = publicMetadata(
  "Sign up and sign in to websites from Cursor",
  description,
  "/integrations/cursor",
);

export default function CursorIntegrationPage() {
  return (
    <DiscoveryDetail
      breadcrumbs={[
        { name: "Home", path: "/" },
        { name: "Agent integrations", path: "/integrations" },
        { name: "Cursor", path: "/integrations/cursor" },
      ]}
      eyebrow="Integration / Cursor"
      title="Sign up and sign in to websites from Cursor"
      deck="Add Trusty Squire to Cursor, restart it, and ask for the signup, configuration, or credential outcome your app needs."
      installCommand="npx @trusty-squire/mcp connect --target=cursor"
      examples={[
        {
          prompt: "Sign me up for Clerk and save the API key.",
          result:
            "Keep working in Cursor while Trusty Squire completes the website flow and stores the key.",
        },
        {
          prompt: "Configure Braintrust and Cerebras for this app.",
          result: "Finish project setup in both dashboards from one development task.",
        },
        {
          prompt: "Give this deployed app revocable API access.",
          result:
            "Use a scoped Trusty Squire grant instead of copying the provider credential into the app.",
        },
      ]}
      steps={[
        {
          title: "Run the Cursor target",
          description:
            "The connect command signs the machine in and merges a squire server into ~/.cursor/mcp.json.",
        },
        {
          title: "Restart Cursor",
          description:
            "Close and reopen Cursor so its MCP client loads the server and exposes the Trusty Squire tools.",
        },
        {
          title: "Ask from the coding task",
          description:
            "Tell Cursor what website outcome the project needs. It can plan the steps and use Trusty Squire to act on the real site.",
        },
      ]}
      related={[
        {
          href: "/use-cases/api-keys-without-env",
          title: "Keep keys out of the project",
          description: "See how stored credentials and scoped grants work.",
        },
        {
          href: "/integrations/claude-code",
          title: "Using Claude Code instead?",
          description: "Connect the squire MCP server to Claude Code.",
        },
        {
          href: "/integrations/codex",
          title: "Using Codex instead?",
          description: "Connect the squire MCP server to Codex CLI.",
        },
      ]}
    >
      <h3>Cursor’s MCP file is merged, not replaced</h3>
      <p>
        Cursor reads this server from <code>~/.cursor/mcp.json</code>. The installer reads the
        existing <code>mcpServers</code> map, updates the <code>squire</code> entry, and writes the
        other entries back with it. You do not need to paste a JSON block into Cursor by hand.
      </p>

      <h3>Rerun connect when the session changes</h3>
      <p>
        The same command can refresh the Cursor configuration. If the browser login is stale or you
        want to use a different connected account, rerun it with <code>--force-relogin</code>, then
        restart Cursor once more.
      </p>

      <h3>Website work stays part of the coding task</h3>
      <p>
        Cursor can move from implementing an integration to requesting the provider setup it needs
        without sending you to hunt through dashboards. Trusty Squire supplies the browser session
        and the credential-safe path; Cursor remains the planner for the project outcome.
      </p>
    </DiscoveryDetail>
  );
}
