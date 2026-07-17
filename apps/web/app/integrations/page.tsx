import Link from "next/link";
import { DiscoveryHub } from "../components/DiscoveryPages";
import { publicMetadata } from "../lib/public-metadata";

const description =
  "Connect Trusty Squire to Claude Code, Codex, Cursor, OpenCode, Goose, Cline, Continue, or Hermes, then ask your coding agent to sign up and sign in to websites.";

export const metadata = publicMetadata(
  "Use Trusty Squire with your coding agent",
  description,
  "/integrations",
);

const ITEMS = [
  {
    href: "/integrations/claude-code",
    title: "Claude Code",
    description:
      "Install the squire MCP server in Claude Code and pre-allow its safe, high-frequency credential tools.",
  },
  {
    href: "/integrations/codex",
    title: "Codex CLI",
    description:
      "Add Trusty Squire to Codex without replacing your model, approval, sandbox, or existing MCP settings.",
  },
  {
    href: "/integrations/cursor",
    title: "Cursor",
    description:
      "Write the squire server into Cursor's MCP configuration and start asking for website outcomes.",
  },
  {
    href: "/integrations/opencode",
    title: "OpenCode",
    description:
      "Add Trusty Squire to OpenCode as a local MCP server without replacing your model, permissions, or other tools.",
  },
];

export default function IntegrationsPage() {
  return (
    <DiscoveryHub
      eyebrow="Coding agents"
      title="Use Trusty Squire with the coding agent you already use"
      deck="Connect once, restart your agent, then ask it to handle a signup, sign-in, configuration, or credential job in ordinary language."
      items={ITEMS}
    >
      <h2>One MCP server, eight targets</h2>
      <div>
        <p>
          The installer also supports OpenCode, Goose, Cline, Continue, and Hermes. Run{" "}
          <code>npx @trusty-squire/mcp connect</code> to let it detect installed agents, or pass a
          target explicitly.
        </p>
        <p>
          Each installer path merges a server named <code>squire</code> into the agent’s existing
          configuration. It does not intentionally replace your other MCP servers. Start with the{" "}
          <Link href="/start">installation guide</Link> or choose an agent above for its exact
          command and config path.
        </p>
      </div>
    </DiscoveryHub>
  );
}
