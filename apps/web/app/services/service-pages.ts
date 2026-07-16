import type { PublishedServiceDetails } from "./service-types";

/**
 * Editorial review gate for indexable service pages.
 *
 * The 82-service registry snapshot controls eligibility. This smaller map controls
 * publication: each entry has signup evidence from that registry record plus a
 * provider request checked against official API documentation on 2026-07-15.
 */
export const PUBLISHED_SERVICE_DETAILS = {
  braintrust: {
    signupMode: "federated",
    signupEvidence: ["Choose google sign-in.", "Continue through the account flow."],
    intro: [
      "Braintrust setup interrupts an evaluation or tracing task with a Google account flow and a separate organization API-key screen.",
      "The active registry flow crosses that account boundary and captures the credential, while the integration below uses Braintrust's documented project endpoint without putting the key in your agent's context.",
    ],
    prompt:
      "Use Trusty Squire to sign me up for Braintrust, save the API key, allow api.braintrust.dev for server-side requests, and wire it into this app without exposing the raw key.",
    credentialUse:
      "Braintrust documents this bearer credential for its API, including project, experiment, dataset, prompt, and trace operations permitted by the organization.",
    limits:
      "The registry record does not include an organization name, project ID, data-plane region, or API-key role. Confirm those separately; EU and self-hosted organizations use a different API host.",
    integration: {
      apiHost: "api.braintrust.dev",
      operation: "list Braintrust projects",
      docsLabel: "Braintrust API: list projects",
      docsUrl: "https://www.braintrust.dev/docs/api-reference/projects/list-projects",
      requestSnippet: `const response = await fetch(
  \`\${process.env.SQUIRE_EGRESS_BASE_URL}/v1/project?limit=10\`,
  {
    headers: {
      Authorization: \`Bearer \${process.env.SQUIRE_EGRESS_TOKEN}\`,
    },
  },
);

if (!response.ok) throw new Error(\`Braintrust returned \${response.status}\`);
const projects = await response.json();`,
    },
    relatedSampleSlugs: ["cerebras", "deepinfra", "zilliz", "clerk"],
  },
  cerebras: {
    signupMode: "federated",
    signupEvidence: ["Choose google sign-in.", "Continue through the account flow."],
    intro: [
      "A first Cerebras inference call requires leaving the coding task, completing the Google-backed cloud account flow, and locating the API credential.",
      "Trusty Squire handles that recorded browser sequence, then the backend can use Cerebras's OpenAI-compatible chat endpoint through a scoped vault grant.",
    ],
    prompt:
      "Use Trusty Squire to sign me up for Cerebras, save the API key, allow api.cerebras.ai for server-side requests, and wire it into this app without exposing the raw key.",
    credentialUse:
      "Cerebras documents this bearer credential for its inference API, including the OpenAI-compatible chat-completions endpoint and the models enabled for the account.",
    limits:
      "The registry does not encode model access, quota, billing, or a required API-version override. Choose an available model and review current account limits before production use.",
    integration: {
      apiHost: "api.cerebras.ai",
      operation: "send a Cerebras chat-completions request",
      docsLabel: "Cerebras Inference: authentication",
      docsUrl: "https://inference-docs.cerebras.ai/api-reference/authentication",
      requestSnippet: `const response = await fetch(
  \`\${process.env.SQUIRE_EGRESS_BASE_URL}/v1/chat/completions\`,
  {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${process.env.SQUIRE_EGRESS_TOKEN}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-oss-120b",
      messages: [{ role: "user", content: "Say hello in five words." }],
    }),
  },
);

if (!response.ok) throw new Error(\`Cerebras returned \${response.status}\`);
const completion = await response.json();`,
    },
    relatedSampleSlugs: ["deepinfra", "braintrust", "zilliz", "clerk"],
  },
  clerk: {
    signupMode: "email",
    signupEvidence: [
      "Enter the generated signup email alias.",
      "Receive and enter the email verification code through the sealed verification flow.",
    ],
    intro: [
      "Clerk provisioning mixes an email-verified dashboard signup with a backend secret that must never be bundled into browser code.",
      "The reviewed registry flow creates the account and captures the secret directly, while the example below calls Clerk's documented Backend API through a vault grant.",
    ],
    prompt:
      "Use Trusty Squire to sign me up for Clerk, save the secret key, allow api.clerk.com for server-side requests, and wire it into this app without exposing the raw key.",
    credentialUse:
      "Clerk documents the secret key as bearer authentication for its Backend API, including server-side user, session, organization, and invitation operations.",
    credentialPublicDescriptions: [
      "An environment-specific Clerk backend secret. Development instances use sk_test_; production instances use sk_live_. Creating or promoting a production instance is separate from this reviewed signup flow.",
    ],
    limits:
      "The captured key belongs to one Clerk instance. Frontend publishable keys, application configuration, user-model settings, and production-instance promotion are separate from this credential flow.",
    integration: {
      apiHost: "api.clerk.com",
      operation: "list users from the Clerk Backend API",
      docsLabel: "Clerk Backend API: list users",
      docsUrl: "https://clerk.com/docs/reference/backend/user/get-user-list",
      requestSnippet: `const response = await fetch(
  \`\${process.env.SQUIRE_EGRESS_BASE_URL}/v1/users?limit=10\`,
  {
    headers: {
      Authorization: \`Bearer \${process.env.SQUIRE_EGRESS_TOKEN}\`,
    },
  },
);

if (!response.ok) throw new Error(\`Clerk returned \${response.status}\`);
const users = await response.json();`,
    },
    relatedSampleSlugs: ["braintrust", "cerebras", "deepinfra", "zilliz"],
  },
  deepinfra: {
    signupMode: "federated",
    signupEvidence: ["Choose github sign-in.", "Continue through the recorded account flow."],
    intro: [
      "DeepInfra's OpenAI-compatible API is quick to call only after someone completes the GitHub account flow and creates a named token in its dashboard.",
      "The active registry sequence does that credential work, then a scoped Trusty Squire base URL can replace DeepInfra's API origin in an otherwise ordinary chat-completions request.",
    ],
    prompt:
      "Use Trusty Squire to sign me up for DeepInfra, save the API token, allow api.deepinfra.com for server-side requests, and wire it into this app without exposing the raw key.",
    credentialUse:
      "DeepInfra documents the bearer token for its native and OpenAI-compatible inference APIs, covering the models and modalities available to the account.",
    limits:
      "Model availability, context limits, pricing, and optional scoped-JWT policy are not part of the registry record. Select a current model and set application-level budgets separately.",
    integration: {
      apiHost: "api.deepinfra.com",
      operation: "send a DeepInfra chat-completions request",
      docsLabel: "DeepInfra: chat completions",
      docsUrl: "https://docs.deepinfra.com/chat/overview",
      requestSnippet: `const response = await fetch(
  \`\${process.env.SQUIRE_EGRESS_BASE_URL}/v1/openai/chat/completions\`,
  {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${process.env.SQUIRE_EGRESS_TOKEN}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-ai/DeepSeek-V3",
      messages: [{ role: "user", content: "Say hello in five words." }],
    }),
  },
);

if (!response.ok) throw new Error(\`DeepInfra returned \${response.status}\`);
const completion = await response.json();`,
    },
    relatedSampleSlugs: ["cerebras", "braintrust", "zilliz", "clerk"],
  },
  zilliz: {
    signupMode: "email",
    signupEvidence: [
      "Open Zilliz Cloud signup.",
      "Wait for and apply the email verification code.",
    ],
    intro: [
      "Zilliz Cloud signup requires verified email plus name and company onboarding before the API-key screen is available.",
      "Trusty Squire completes that recorded sequence and vaults the credential; cluster endpoints, project IDs, and collection configuration stay explicit application choices.",
    ],
    prompt:
      "Use Trusty Squire to sign me up for Zilliz Cloud, save the API key, allow api.cloud.zilliz.com for server-side requests, and wire it into this app without exposing the raw key.",
    credentialUse:
      "Zilliz documents this bearer key for its control-plane API, including cloud, project, cluster, and other operations permitted by the account and key.",
    limits:
      "Cluster URI, project ID, database, collection, cloud, region, plan, and role are separate. Add those from Zilliz Cloud after account creation rather than treating them as part of the secret.",
    integration: {
      apiHost: "api.cloud.zilliz.com",
      operation: "list the cloud providers available to Zilliz Cloud",
      docsLabel: "Zilliz Cloud REST API overview",
      docsUrl: "https://docs.zilliz.com/reference/restful",
      requestSnippet: `const response = await fetch(
  \`\${process.env.SQUIRE_EGRESS_BASE_URL}/v2/clouds\`,
  {
    headers: {
      Authorization: \`Bearer \${process.env.SQUIRE_EGRESS_TOKEN}\`,
      "Content-Type": "application/json",
    },
  },
);

if (!response.ok) throw new Error(\`Zilliz Cloud returned \${response.status}\`);
const clouds = await response.json();`,
    },
    relatedSampleSlugs: ["deepinfra", "cerebras", "braintrust", "clerk"],
  },
} as const satisfies Record<string, PublishedServiceDetails>;

export type PublishedServiceSlug = keyof typeof PUBLISHED_SERVICE_DETAILS;

export const PUBLISHED_SERVICE_SLUGS = Object.keys(
  PUBLISHED_SERVICE_DETAILS,
) as PublishedServiceSlug[];
