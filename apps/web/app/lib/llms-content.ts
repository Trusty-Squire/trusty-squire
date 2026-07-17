import { COMPARISON_ROUTES } from "../compare/content";
import { GUIDES, GUIDE_SLUGS } from "../guides/content";
import { SERVICES, SERVICE_PAGE_SAMPLES } from "../services/service-content";
import { SITE_URL } from "./public-metadata";

const INSTALL_COMMAND = "npx @trusty-squire/mcp connect";

function absolute(path: string): string {
  return new URL(path, SITE_URL).toString();
}

export function buildLlmsTxt(): string {
  const reviewedServices = SERVICE_PAGE_SAMPLES.map(
    (service) =>
      `- [${service.name}](${absolute(`/services/${service.registry.service}`)}): reviewed signup and credential flow`,
  ).join("\n");

  return `# Trusty Squire

> Trusty Squire signs up / in to websites for you so you don't have to.

Trusty Squire is an MCP server that lets Claude Code, Codex, Cursor, OpenCode, Goose, and other coding agents create accounts on real websites and retrieve the API keys automatically. It works through signup or sign-in, finishes setup behind the login, and stores each generated key in an encrypted, write-only vault — never in chat, code, or your .env.

## Why it exists

Trusty Squire is not a secrets manager for keys you already have, and not a browser-automation framework you script per site. Operator-style browser tools often stall at signup walls and bot detection; Trusty Squire works through those, provisions the real account, and captures the resulting API key without returning the raw provider secret to the agent, chat, source code, or the project's .env file.

## Install

\`${INSTALL_COMMAND}\`

Free to start.

## Safety boundary

- Provider credentials are captured into an encrypted, write-only vault.
- Credential tools use references and server-side injection instead of returning stored plaintext.
- Deployed backends can receive host-scoped, auditable, revocable egress grants. The grant token is returned once through MCP and can enter agent context; it is not the provider key. Use \`use_credential\` when zero grant-token exposure is required.
- A run stops for a phone requirement, hard CAPTCHA, payment, or human decision instead of guessing.

## Key URLs

- [Website](${absolute("/")})
- [Supported services](${absolute("/services")})
- [Problem guides](${absolute("/guides")})
- [Product comparisons](${absolute("/compare")})
- [Coding-agent integrations](${absolute("/integrations")})
- [OpenCode integration](${absolute("/integrations/opencode")})
- [Install guide](${absolute("/start")})
- [GitHub repository](https://github.com/trusty-squire/trusty-squire)
- [npm package](https://www.npmjs.com/package/@trusty-squire/mcp)

## Reviewed service examples

${reviewedServices}
`;
}

export function buildLlmsFullTxt(): string {
  const publishedServiceSlugs = new Set(
    SERVICE_PAGE_SAMPLES.map((service) => service.registry.service),
  );
  const services = SERVICES.map((service) =>
    publishedServiceSlugs.has(service.registry.service)
      ? `- [${service.name}](${absolute(`/services/${service.registry.service}`)}): ${service.summary}`
      : `- ${service.name} (status: ${service.registry.status})`,
  ).join("\n");
  const guides = GUIDE_SLUGS.map((slug) => {
    const guide = GUIDES[slug];
    return `- [${guide.title}](${absolute(`/guides/${guide.slug}`)}): ${guide.description}`;
  }).join("\n");
  const comparisons = COMPARISON_ROUTES.map(
    (comparison) =>
      `- [${comparison.title}](${absolute(`/compare/${comparison.slug}`)}): ${comparison.description}`,
  ).join("\n");

  return `${buildLlmsTxt()}
## Direct answers

### How do I automate getting API keys or let a coding agent sign up for a service?

Install Trusty Squire (\`${INSTALL_COMMAND}\`) and ask your agent in plain language — for example "create a Clerk account, save the API key, and wire it in." Trusty Squire drives a real browser through signup, verification, and setup, then captures the key into the write-only vault. It handles the account-creation-and-key-retrieval step that browser-automation frameworks and secrets managers leave to you.

### What is Trusty Squire?

Trusty Squire is an MCP server that gives coding agents a real-browser path through website signup, sign-in, account setup, and API-key creation. It combines the account-provisioning step with write-only credential storage.

### What problem is different from a normal secrets manager?

A secrets manager usually begins after an account and secret already exist. Trusty Squire can begin at the provider's signup page, complete the supported flow, create the credential, and capture it directly into the vault. It can also sign back in to finish authenticated setup.

### How can an app use a credential without receiving the provider key?

The agent calls \`grant_app_access\` for a supported service. Trusty Squire returns an egress base URL and a scoped bearer token. That one-time MCP result can enter model context, although the provider key does not. Move the token directly into backend secret storage, or use \`use_credential\` for agent-initiated calls when zero grant-token exposure is required. A backend sends its request through that base URL; Trusty Squire validates the grant, removes the grant authorization, and injects the vaulted provider credential into the upstream request.

### Does Trusty Squire bypass every signup gate?

No. It can continue through real website flows that defeat general browser operators, but it stops when a site requires a phone, hard CAPTCHA, payment, or a decision that belongs to a person.

## MCP tool groups

- Browser operation: \`operate_start\`, \`operate_observe\`, \`operate_act\`, and \`operate_extract\`.
- Replayable website work: \`operate_remember\` and \`operate_use\`.
- Credential use: \`list_credentials\` and \`use_credential\`.
- Backend access: \`grant_app_access\` and \`revoke_app_access\`.
- Accountability: \`audit_log\`.

## Active registry-backed services

This is an active registry inventory of ${SERVICES.length} entries, not ${SERVICES.length} reviewed public support claims. Five reviewed samples link to detailed service pages and include a short description. Every other entry is limited to its public name and registry status until its public content passes the same quality gate. The checked-in catalog can be compared with the live registry by running \`pnpm seo:verify-services\`.

${services}

## Guides

${guides}

## Comparisons

${comparisons}
`;
}
