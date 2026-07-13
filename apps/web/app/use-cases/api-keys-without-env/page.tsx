import Link from "next/link";
import { DiscoveryDetail } from "../../components/DiscoveryPages";
import { publicMetadata } from "../../lib/public-metadata";

const description =
  "Store and use API keys without putting them in AI chat, source code, .env files, credential-tool output, or the deployed app that consumes them.";

export const metadata = publicMetadata(
  "Use API keys without putting them in chat, code, or .env",
  description,
  "/use-cases/api-keys-without-env",
);

export default function ApiKeysWithoutEnvPage() {
  return (
    <DiscoveryDetail
      eyebrow="Use case / credential safety"
      title="Use API keys without putting them in chat, code, or .env"
      deck="Trusty Squire stores generated credentials, injects them into provider requests server-side, and can give deployed apps scoped access you can revoke."
      examples={[
        {
          prompt: "Sign me up for Resend and save the API key.",
          result:
            "Capture the generated key into the vault instead of copying it through the conversation.",
        },
        {
          prompt: "Let my deployed app call OpenAI without giving it the OpenAI key.",
          result:
            "Issue scoped app access while the provider credential stays out of the consuming app.",
        },
        {
          prompt: "That app token leaked. Revoke its access now.",
          result: "Revoke the app grant without rotating the underlying provider key.",
        },
      ]}
      steps={[
        {
          title: "Capture the generated credential",
          description:
            "When a website shows an API key or client secret, Trusty Squire stores it directly or holds it in a sealed slot for the current setup flow.",
        },
        {
          title: "Keep raw values out of credential tools",
          description:
            "The agent can list and use saved credentials, but those tool results do not return the stored plaintext value.",
        },
        {
          title: "Inject the key only for the provider call",
          description:
            "Trusty Squire places the credential into the outbound request on the server side. The provider receives its key; the caller does not.",
        },
        {
          title: "Give apps revocable access",
          description:
            "A deployed app can hold a scoped Trusty Squire grant with limits and audit history instead of holding the provider credential itself.",
        },
      ]}
      related={[
        {
          href: "/use-cases/website-signup",
          title: "Generate the credential",
          description: "Let your agent complete the signup that creates the key.",
        },
        {
          href: "/use-cases/sign-in-and-configure",
          title: "Configure the integration",
          description: "Finish authenticated setup without pasting secrets into chat.",
        },
        {
          href: "/integrations",
          title: "Connect your coding agent",
          description: "Install Trusty Squire in Claude Code, Codex, Cursor, and more.",
        },
      ]}
    >
      <h3>The precise safety boundary</h3>
      <p>
        A provider credential does need to reach its provider. The accurate claim is that the raw
        value does not need to appear in chat, source code, an <code>.env</code> file,
        credential-tool output, or the consuming app. Trusty Squire injects it into the provider
        request on the server side.
      </p>

      <h3>Write-only by design</h3>
      <p>
        Saving a credential is separate from reading it. Agent tools can refer to a stored
        credential and use it for an allowed call without receiving the plaintext back. If you
        personally need the value, you can reveal it in the web vault.
      </p>

      <h3>Scoped access limits the blast radius</h3>
      <p>
        Give a deployed application a scoped, rate-limited grant rather than the provider key. You
        can audit or revoke that grant independently. The{" "}
        <Link href="/blog/the-last-mile-is-a-signup-form">last-mile article</Link> explains why this
        matters once an agent handles more of the build.
      </p>
    </DiscoveryDetail>
  );
}
