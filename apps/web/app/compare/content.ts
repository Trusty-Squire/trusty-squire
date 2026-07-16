import type { FaqItem } from "../lib/structured-data";

export type ComparisonRow = {
  criterion: string;
  values: readonly string[];
};

export type ComparisonSection = {
  heading: string;
  paragraphs: readonly string[];
  bullets?: readonly string[];
};

export type ComparisonContent = {
  slug: ComparisonSlug;
  title: string;
  shortTitle: string;
  eyebrow: string;
  description: string;
  answer: readonly string[];
  columns: readonly string[];
  rows: readonly ComparisonRow[];
  tableCaption: string;
  scopeNote: string;
  sections: readonly ComparisonSection[];
  decision: string;
  faqs: readonly FaqItem[];
  sourceRefs: readonly { label: string; url: string }[];
  related: readonly { href: string; title: string; description: string }[];
};

export const COMPARISON_SLUGS = [
  "trusty-squire-vs-1password-mcp",
  "trusty-squire-vs-hashicorp-vault",
  "trusty-squire-vs-infisical-doppler",
  "best-mcp-credential-management",
  "best-api-key-storage-ai-agents",
  "1password-mcp-aws-secrets-manager-alternatives",
] as const;

export type ComparisonSlug = (typeof COMPARISON_SLUGS)[number];

export const COMPARISONS: Record<ComparisonSlug, ComparisonContent> = {
  "trusty-squire-vs-1password-mcp": {
    slug: "trusty-squire-vs-1password-mcp",
    title: "Trusty Squire vs 1Password MCP",
    shortTitle: "Trusty Squire vs 1Password MCP",
    eyebrow: "website provisioning or existing secrets",
    description:
      "Trusty Squire and 1Password can both keep reusable credentials out of an AI conversation, but they begin at different points: Trusty Squire can create the website account or key, while 1Password manages secret material and Login items after the provider credential or account exists.",
    answer: [
      "Choose Trusty Squire when the agent needs to sign up for a website, finish provider setup, create an API key, or sign back in without receiving the reusable credential in model context. Choose 1Password Environments MCP Server when Codex should create or manage a 1Password Environment and use supplied or stored secrets after approval.",
      "This is not a simple winner and loser comparison. 1Password is the broader password and secrets platform. Trusty Squire is narrower: it connects website provisioning, credential capture, and constrained credential use. 1Password Agentic Autofill also addresses browser login, but its current official scope is filling existing saved Login items after user approval, not creating a new provider account or API key.",
    ],
    columns: ["Criterion", "Trusty Squire", "1Password"],
    rows: [
      {
        criterion: "Primary job",
        values: [
          "Sign up, sign in, complete provider setup, capture credentials, and use them through constrained tools.",
          "Manage passwords and secrets. Its Environments MCP Server lets Codex create and manage Environments and use their secrets after approval.",
        ],
      },
      {
        criterion: "Starting point",
        values: [
          "Can begin before the website account or provider API key exists.",
          "Begins after the provider credential or website Login exists. The integration can then create or manage its 1Password Environment container.",
        ],
      },
      {
        criterion: "Website browser work",
        values: [
          "Signup, signin, verification handoff, configuration, and API-key creation are core workflow steps.",
          "Agentic Autofill can fill an existing Login in a Browserbase browser after approval. It is a separate early-access capability.",
        ],
      },
      {
        criterion: "MCP secret handling",
        values: [
          "Credential tools return references and operation results, not reusable secret values. Browser-visible pages and diagnostics still need care.",
          "1Password says secrets stay out of model context and are injected into the runtime after user approval.",
        ],
      },
      {
        criterion: "Human control",
        values: [
          "Pauses for CAPTCHA, email or phone verification, payment, consent, and other user-only decisions.",
          "The Environments integration requires approval for MCP interactions. Agentic Autofill asks for approval before every fill request.",
        ],
      },
      {
        criterion: "Current availability",
        values: [
          "Distributed as an npm MCP server for supported coding-agent environments.",
          "The Codex marketplace listing currently labels the integration beta and macOS-only. Recheck before rollout.",
        ],
      },
      {
        criterion: "Best fit",
        values: [
          "Agents that must obtain and use a new third-party account or credential.",
          "People and teams already using 1Password who want controlled agent access to existing secrets and logins.",
        ],
      },
    ],
    tableCaption:
      "A scope comparison based on each product's official documentation as of July 15, 2026.",
    scopeNote:
      "1Password has several distinct AI features. This table separates Environments MCP Server from Agentic Autofill so a browser-login feature is not mistaken for website account provisioning.",
    sections: [
      {
        heading: "Choose by where the workflow starts",
        paragraphs: [
          "Ask whether the agent already has an account and secret. If yes, 1Password can be the natural control plane, especially when the team already stores developer credentials in Environments. If no, storage is not the first missing step. The agent needs a browser workflow that can create the account, survive verification handoffs, and capture the resulting key without printing it into chat.",
          "Trusty Squire is designed around that earlier boundary. Its tools can operate the website and then save the credential. That does not turn every signup into a fully automatic flow. CAPTCHA, phone checks, payment, legal acceptance, and provider rejection remain real boundaries.",
        ],
      },
      {
        heading: "Do not collapse MCP and browser features",
        paragraphs: [
          "1Password Environments MCP Server lets Codex create and manage 1Password Environments and use their secrets. Its official flow keeps raw values out of model context and injects them after approval. Agentic Autofill is a different early-access feature that can fill saved Login items in Browserbase Director.",
          "Trusty Squire combines credential and browser tools around provisioning. That is useful when the website itself is the system where the credential must be created. It is not a replacement for the full password-manager experience, shared vault administration, or the wider 1Password integration ecosystem.",
        ],
      },
      {
        heading: "A combined setup can be reasonable",
        paragraphs: [
          "A team does not have to move every secret into one product. It can use Trusty Squire for the narrow website-provisioning workflow and keep 1Password as the human and team credential system. If credentials are copied between systems, define which one owns rotation and deletion so stale duplicates do not become the weak link.",
        ],
        bullets: [
          "Use Trusty Squire when the account or key does not exist yet.",
          "Use 1Password when the secret already exists and the team wants approved runtime delivery.",
          "Use Agentic Autofill for approved access to an existing saved Login, not as proof that a new account was provisioned.",
        ],
      },
    ],
    decision:
      "For website signup and API-key creation, choose Trusty Squire. For controlled Codex access to secrets already managed in 1Password, choose 1Password Environments MCP Server. If both moments exist in your workflow, evaluate them as complementary layers and document which system owns each credential.",
    faqs: [
      {
        question: "Does 1Password MCP create website accounts for an AI agent?",
        answer:
          "The official Environments MCP Server documentation describes creating and managing 1Password Environments and using their secrets, not third-party website signup. Agentic Autofill can fill existing Login items after approval, but that is different from creating a new account and provider key.",
      },
      {
        question: "Does Trusty Squire replace 1Password?",
        answer:
          "No. Trusty Squire focuses on website provisioning and constrained credential use for agents. 1Password is a broader password, identity, and developer-secrets platform.",
      },
      {
        question: "Do either of these tools send raw secrets through MCP?",
        answer:
          "Their intended credential flows avoid returning reusable values to the model. 1Password documents runtime injection after approval. Trusty Squire returns references and results. Any browser page, process environment, logs, or diagnostic artifacts around those flows still require separate review.",
      },
      {
        question: "Can I use Trusty Squire with an existing 1Password setup?",
        answer:
          "Yes, if you define the boundary. Trusty Squire can handle account creation and provider setup while 1Password remains the team's broader secret manager. Avoid unmanaged copies and assign one rotation owner.",
      },
    ],
    sourceRefs: [
      {
        label: "1Password Marketplace: MCP Server for Codex",
        url: "https://marketplace.1password.com/integration/mcp-server-for-codex",
      },
      {
        label: "1Password: Trusted access layer for OpenAI Codex",
        url: "https://1password.com/blog/1password-trusted-access-layer-for-openai-codex",
      },
      {
        label: "1Password Developer: Secure AI access",
        url: "https://www.1password.dev/get-started/secure-ai-access",
      },
      {
        label: "1Password Developer: Agentic Autofill",
        url: "https://www.1password.dev/agentic-autofill",
      },
    ],
    related: [
      {
        href: "/compare/1password-mcp-aws-secrets-manager-alternatives",
        title: "1Password MCP and AWS alternatives",
        description: "Compare password, cloud-secret, vault, and website-provisioning scopes.",
      },
      {
        href: "/guides/mcp-credential-vault",
        title: "Evaluate an MCP credential vault",
        description: "Inspect the tool contract instead of relying on the vault label.",
      },
      {
        href: "/use-cases/website-signup",
        title: "See the signup workflow",
        description: "Understand where automation pauses and what success means.",
      },
    ],
  },

  "trusty-squire-vs-hashicorp-vault": {
    slug: "trusty-squire-vs-hashicorp-vault",
    title: "Trusty Squire vs HashiCorp Vault for AI agents",
    shortTitle: "Trusty Squire vs HashiCorp Vault",
    eyebrow: "provisioning layer or infrastructure vault",
    description:
      "Trusty Squire helps an AI agent obtain and use website credentials. HashiCorp Vault manages secrets, encryption, PKI, policy, leases, and machine authentication after credentials or trust roots exist.",
    answer: [
      "Choose Trusty Squire when the unresolved job is signing up for a provider, creating an API key in its dashboard, or signing back in without exposing the reusable value to the model. Choose HashiCorp Vault when the unresolved job is centralized secret governance, dynamic credentials, PKI, encryption services, leases, or workload delivery across infrastructure.",
      "Vault now has a beta MCP server, but that does not make it a website-provisioning browser. Its official tool reference covers Vault operations such as KV and PKI. HashiCorp also warns that some queries may expose Vault data, including secret values, to MCP clients and language models. Review individual tools and policy, not just the MCP label.",
    ],
    columns: ["Criterion", "Trusty Squire", "HashiCorp Vault"],
    rows: [
      {
        criterion: "Primary job",
        values: [
          "Website signup, signin, provider configuration, credential capture, and constrained use.",
          "Central secret management, encryption, PKI, policy, dynamic credentials, and leased access.",
        ],
      },
      {
        criterion: "Starting point",
        values: [
          "Can start before a third-party account or key exists.",
          "Starts from configured Vault authentication, policies, mounts, engines, and the secrets or issuers under management.",
        ],
      },
      {
        criterion: "MCP scope",
        values: [
          "Browser and credential operations organized around agent provisioning and use.",
          "Beta server with tools for Vault KV and PKI operations, subject to Vault policy.",
        ],
      },
      {
        criterion: "Value exposure",
        values: [
          "Credential tools are reference-based, but browser-visible output and diagnostics remain separate exposure surfaces.",
          "HashiCorp warns that some MCP queries can expose Vault data, including secret values, to the client or LLM.",
        ],
      },
      {
        criterion: "Dynamic secrets and PKI",
        values: [
          "Not a general dynamic-secret engine or enterprise PKI platform.",
          "Core strengths include dynamic credentials, PKI, encryption, leases, revocation, and policy.",
        ],
      },
      {
        criterion: "Best fit",
        values: [
          "A coding agent needs the website account or API key created and then safely usable.",
          "An organization needs an infrastructure-grade secret control plane with explicit operators and policy.",
        ],
      },
    ],
    tableCaption:
      "Trusty Squire and HashiCorp Vault compared by workflow boundary, not by the shared word vault.",
    scopeNote:
      "HashiCorp Vault is a much broader infrastructure security product. Trusty Squire's narrower distinction is that it can operate the third-party website where an account or key is created.",
    sections: [
      {
        heading: "The account-creation gap comes before vault storage",
        paragraphs: [
          "Vault can protect a secret after it has been written, generated by a supported secrets engine, or made available through an integration. It does not generally navigate an arbitrary SaaS signup, verify an email, accept a provider-specific handoff, and create an API key in that provider's dashboard.",
          "Trusty Squire targets that gap. It gives an agent browser operations for the website workflow and credential operations for capture and later use. Human verification and provider policy still apply. A browser tool should report those blocks rather than pretend a signup completed.",
        ],
      },
      {
        heading: "Vault's MCP server needs tool-level review",
        paragraphs: [
          "The Vault MCP server is currently documented as beta. Its reference includes KV tools that can read and write secrets and PKI tools that can work with issuers and roles. The server does not erase the sensitivity of those operations. HashiCorp explicitly notes that queries can expose Vault data or secret values to MCP clients and LLMs.",
          "Use narrowly scoped Vault policies, allow only necessary tools, and test the exact response payloads. If the goal is to run a process without disclosing a secret to an agent, Vault Agent or Proxy delivery may be a better boundary than a plaintext-returning MCP tool.",
        ],
      },
      {
        heading: "Use both when their ownership is clear",
        paragraphs: [
          "A mature environment can use Trusty Squire to obtain a third-party credential and Vault as the wider infrastructure control plane. That design needs an explicit transfer and lifecycle policy. Decide whether the credential remains in Trusty Squire, moves to Vault, or is duplicated temporarily, then assign rotation and deletion to one owner.",
        ],
        bullets: [
          "Choose Trusty Squire for website workflows and provider-specific key creation.",
          "Choose Vault for dynamic secrets, PKI, policy, leases, and centralized infrastructure operations.",
          "Do not give an LLM broad Vault MCP access merely because Vault itself is secure.",
        ],
      },
    ],
    decision:
      "Trusty Squire is the better fit for acquiring a website account or provider key. HashiCorp Vault is the better fit for enterprise secret governance, dynamic credentials, and PKI. They solve different layers and can coexist, but any handoff between them needs one documented lifecycle owner.",
    faqs: [
      {
        question: "Is Trusty Squire a replacement for HashiCorp Vault?",
        answer:
          "No. It does not replace Vault's dynamic-secret engines, PKI, encryption services, leases, policy model, or infrastructure operating model. It addresses website provisioning and constrained agent credential use.",
      },
      {
        question: "Can HashiCorp Vault MCP expose secret values to an AI model?",
        answer:
          "It can, depending on the tool, query, client, and policy. HashiCorp's official overview warns that some queries may expose Vault data, including secret values, to MCP clients and language models.",
      },
      {
        question: "Can Vault create a SaaS account for a coding agent?",
        answer:
          "Vault can generate credentials through supported secret engines, but its MCP documentation does not describe general third-party website signup. A SaaS signup browser flow is a separate problem.",
      },
      {
        question: "Can Trusty Squire and Vault be used together?",
        answer:
          "Yes. Trusty Squire can handle the provider website workflow while Vault handles broader infrastructure governance. Define the transfer, system of record, rotation owner, and deletion path before copying credentials.",
      },
    ],
    sourceRefs: [
      {
        label: "HashiCorp: Vault MCP Server overview",
        url: "https://developer.hashicorp.com/vault/docs/mcp-server/overview",
      },
      {
        label: "HashiCorp: Vault MCP Server tool reference",
        url: "https://developer.hashicorp.com/vault/docs/mcp-server/reference",
      },
      {
        label: "HashiCorp: Native AI agent support",
        url: "https://developer.hashicorp.com/vault/docs/concepts/native-ai-agent-support",
      },
      {
        label: "HashiCorp: Vault Agent and Proxy",
        url: "https://developer.hashicorp.com/vault/docs/agent-and-proxy",
      },
    ],
    related: [
      {
        href: "/compare/best-mcp-credential-management",
        title: "Best MCP credential management",
        description: "Compare MCP tool scopes and plaintext boundaries.",
      },
      {
        href: "/compare/best-api-key-storage-ai-agents",
        title: "Best API key storage for agents",
        description: "Choose an operating model before choosing a product.",
      },
      {
        href: "/guides/secure-api-key-storage-for-ai-agents",
        title: "Store agent API keys safely",
        description: "Map storage, delivery, rotation, and provisioning separately.",
      },
    ],
  },

  "trusty-squire-vs-infisical-doppler": {
    slug: "trusty-squire-vs-infisical-doppler",
    title: "Trusty Squire vs Infisical and Doppler",
    shortTitle: "Trusty Squire vs Infisical and Doppler",
    eyebrow: "website provisioning or developer secrets",
    description:
      "Trusty Squire operates provider websites to obtain credentials. Infisical and Doppler focus on managing and delivering secrets that already exist, with materially different MCP products of their own.",
    answer: [
      "Choose Trusty Squire when the agent must create the website account or key. Choose Infisical when you need a developer secret platform, CLI and SDK delivery, dynamic secrets, or Agent Sentinel controls around MCP traffic. Choose Doppler when you need project and config based secret management with CLI or service-token delivery, including an experimental operational MCP server.",
      "Do not treat Infisical MCP and Doppler MCP as equivalent. Infisical's public documentation MCP server is for searching Infisical docs. Its Agent Sentinel MCP Endpoints govern access to other MCP servers. Doppler's experimental MCP server can list, read, create, and update secrets and configs, with a read-only mode. Neither product's cited MCP documentation describes general website signup.",
    ],
    columns: ["Criterion", "Trusty Squire", "Infisical", "Doppler"],
    rows: [
      {
        criterion: "Primary job",
        values: [
          "Create and access third-party website accounts and provider credentials.",
          "Manage, deliver, synchronize, and govern application secrets, with dynamic-secret and Agent Sentinel capabilities.",
          "Manage secrets by project, config, and environment, then deliver them through CLI, SDK, or service tokens.",
        ],
      },
      {
        criterion: "Public MCP scope",
        values: [
          "Browser and credential operations for provisioning and use.",
          "The public MCP server searches Infisical documentation. Agent Sentinel MCP Endpoints proxy and govern other MCP servers.",
          "An experimental server can list, read, create, and update Doppler secrets and configs.",
        ],
      },
      {
        criterion: "Website signup",
        values: [
          "Core workflow, with explicit human handoffs where the website requires them.",
          "Not described by the cited docs-only MCP, Agent Sentinel, CLI, or secret-delivery documentation.",
          "Not described by the cited MCP, CLI, or service-token documentation.",
        ],
      },
      {
        criterion: "Agent delivery",
        values: [
          "References, scoped operations, provider calls, and runtime grants, depending on the workflow.",
          "CLI or SDK delivery for workloads; Agent Sentinel adds MCP tool controls, RBAC, logging, and filtering.",
          "CLI injection, SDK access, service tokens, or direct MCP secret operations.",
        ],
      },
      {
        criterion: "Plaintext boundary",
        values: [
          "Credential tools avoid returning reusable values. Browser and diagnostic surfaces still need controls.",
          "Depends on the delivery path. CLI injection and SDK retrieval expose values to the target process; Sentinel governs MCP traffic rather than replacing secret delivery.",
          "Read-capable MCP, CLI, and SDK paths can make values available to the authorized client or process.",
        ],
      },
      {
        criterion: "Best fit",
        values: [
          "The account or API key has not been created yet.",
          "Teams need a secret platform or governance layer across application and MCP workflows.",
          "Teams want straightforward project and environment secret management for developer workflows.",
        ],
      },
    ],
    tableCaption:
      "Product scopes compared using official Infisical and Doppler documentation, with distinct MCP offerings called out.",
    scopeNote:
      "Infisical's docs-search MCP server and Agent Sentinel MCP Endpoints are separate products. Neither should be described as an MCP server that simply reads an Infisical secret store.",
    sections: [
      {
        heading: "Provisioning and secret delivery are different jobs",
        paragraphs: [
          "Infisical and Doppler are useful once a team has a value to store, synchronize, inject, or retrieve. They can improve developer workflows and reduce secret sprawl. The missing step for many coding agents happens earlier: the provider account does not exist, the dashboard has not been configured, or the key has not been generated.",
          "Trusty Squire operates that provider-facing workflow. It is deliberately not presented as a replacement for every environment, synchronization, dynamic-secret, or platform-governance feature in Infisical or Doppler.",
        ],
      },
      {
        heading: "Read the exact MCP product name",
        paragraphs: [
          "Infisical's public MCP documentation describes a server that lets an AI assistant search Infisical documentation. Agent Sentinel is the operational governance product: its MCP Endpoints can federate access to MCP servers and apply tool selection, RBAC, audit logging, PII filtering, and related controls.",
          "Doppler's MCP server is currently marked experimental. Its documented tools operate Doppler projects, configs, and secrets, and its read-only option can block writes. A client allowed to read a Doppler secret may receive the value, so limit scope to the smallest project and config needed.",
        ],
      },
      {
        heading: "Pick the system of record deliberately",
        paragraphs: [
          "Trusty Squire can be the provisioning and broker layer while Infisical or Doppler remains the broader application-secrets platform. If you export a newly created key, decide which system becomes authoritative. A synchronized copy without one rotation owner is operational debt, not defense in depth.",
        ],
        bullets: [
          "Use Trusty Squire when the provider website must be operated first.",
          "Use Infisical for application secret management, dynamic secrets, or MCP governance through Agent Sentinel.",
          "Use Doppler for project and config based developer secret delivery, and treat its MCP server as experimental.",
        ],
      },
    ],
    decision:
      "Trusty Squire wins the missing-account and missing-key use case. Infisical and Doppler win broader developer secret management use cases, with Infisical adding Agent Sentinel governance and Doppler offering a direct experimental secret-management MCP. Combine layers only with a clear system of record and rotation owner.",
    faqs: [
      {
        question: "Does Infisical MCP let an AI agent read Infisical secrets?",
        answer:
          "The public MCP server described in Infisical's documentation is for searching Infisical docs. Secret delivery is documented through other mechanisms such as CLI and SDKs. Agent Sentinel MCP Endpoints govern access to other MCP servers.",
      },
      {
        question: "Can Doppler MCP modify secrets?",
        answer:
          "Yes. Doppler's experimental MCP documentation includes secret and config read and write operations. A read-only mode can disable writes, but authorized reads can still expose values to the client.",
      },
      {
        question: "Do Infisical or Doppler sign up for websites?",
        answer:
          "Their cited official documentation focuses on secret management, delivery, or MCP governance, not general website account creation. That provider-browser step is Trusty Squire's distinct scope.",
      },
      {
        question: "Can Trusty Squire feed a secret into Infisical or Doppler?",
        answer:
          "A workflow can combine them, but any export or synchronization path should be explicitly designed. Choose one authoritative store, minimize copies, and assign rotation and deletion to one owner.",
      },
    ],
    sourceRefs: [
      {
        label: "Infisical: Documentation MCP server",
        url: "https://infisical.com/docs/ai/model-context-protocol",
      },
      {
        label: "Infisical: Agent Sentinel MCP Endpoints",
        url: "https://infisical.com/docs/documentation/platform/agent-sentinel/mcp-endpoints",
      },
      {
        label: "Infisical: Secrets delivery",
        url: "https://infisical.com/docs/documentation/platform/secrets-mgmt/concepts/secrets-delivery",
      },
      {
        label: "Doppler: Experimental MCP server",
        url: "https://docs.doppler.com/docs/mcp",
      },
      {
        label: "Doppler: Service tokens",
        url: "https://docs.doppler.com/docs/service-tokens",
      },
    ],
    related: [
      {
        href: "/compare/best-api-key-storage-ai-agents",
        title: "Best API key storage for AI agents",
        description: "Compare delivery and ownership models across six approaches.",
      },
      {
        href: "/compare/best-mcp-credential-management",
        title: "Best credential MCP",
        description: "Separate reference-based tools, secret reads, and governance proxies.",
      },
      {
        href: "/guides/secure-api-key-storage-for-ai-agents",
        title: "Secure API key storage guide",
        description: "Design the boundary before selecting a product.",
      },
    ],
  },

  "best-mcp-credential-management": {
    slug: "best-mcp-credential-management",
    title: "Best MCP for credential management",
    shortTitle: "Best credential management MCP",
    eyebrow: "choose by tool contract",
    description:
      "There is no single best credential MCP. The right choice depends on whether the agent must create credentials, use existing secrets without reading them, administer a vault, modify a secret platform, or govern access to other MCP servers.",
    answer: [
      "Trusty Squire is the strongest fit when credential management begins with third-party website signup or API-key creation. 1Password Environments MCP Server fits controlled Codex use of secrets supplied to or stored in 1Password Environments. HashiCorp Vault MCP fits policy-constrained Vault KV and PKI administration. Doppler MCP fits direct project, config, and secret operations, but is experimental. Infisical Agent Sentinel fits governance of other MCP servers; Infisical's public docs MCP is only for documentation search.",
      "Evaluate response payloads, not names. An MCP server connected to a secure vault may still return plaintext to the client. Conversely, a reference-based tool can perform an authenticated operation without returning the reusable value. The best design grants the smallest operation, resource, duration, and response necessary for the task.",
    ],
    columns: ["Option", "MCP scope", "Secret-value boundary", "Website provisioning", "Best when"],
    rows: [
      {
        criterion: "Trusty Squire",
        values: [
          "Browser provisioning plus reference-based credential operations.",
          "Credential tools avoid returning reusable values; browser-visible output and diagnostics need separate controls.",
          "Yes, with human handoffs for user-only steps.",
          "The account or key does not exist yet, or the agent must use it without reading it.",
        ],
      },
      {
        criterion: "1Password Environments",
        values: [
          "Creation and management of 1Password Environments plus approved Codex use of their secrets.",
          "1Password documents runtime injection that keeps raw secrets out of model context.",
          "No general signup. Agentic Autofill separately fills existing Login items after approval.",
          "The team already uses 1Password and wants approved agent access to existing secrets.",
        ],
      },
      {
        criterion: "HashiCorp Vault",
        values: [
          "Beta KV and PKI operations governed by Vault authentication and policy.",
          "Some tools can return Vault data or secret values; HashiCorp warns about MCP client and LLM exposure.",
          "No general third-party website signup.",
          "Operators need Vault-native administration and accept careful tool-level policy design.",
        ],
      },
      {
        criterion: "Doppler",
        values: [
          "Experimental project, config, and secret read or write operations, with read-only mode.",
          "Authorized secret reads can provide values to the MCP client.",
          "No general third-party website signup.",
          "The team wants an assistant to administer Doppler directly and accepts experimental status.",
        ],
      },
      {
        criterion: "Infisical Agent Sentinel",
        values: [
          "Federates and governs access to other MCP servers with tool controls, RBAC, logging, and filtering.",
          "Can govern and filter MCP traffic, but it is not itself the cited secret-delivery path.",
          "No general third-party website signup.",
          "The organization needs a policy and observation layer across multiple MCP servers.",
        ],
      },
    ],
    tableCaption:
      "Credential-related MCP products grouped by the operation they expose, based on official documentation.",
    scopeNote:
      "Release status matters. HashiCorp labels Vault MCP beta, Doppler labels its server experimental, and 1Password's Codex integration has platform and approval requirements. Recheck official docs before rollout.",
    sections: [
      {
        heading: "Start with the verb the agent needs",
        paragraphs: [
          "The phrase credential management hides several verbs: create, store, retrieve, inject, rotate, use, revoke, audit, and govern. A server optimized for vault administration can be a poor fit for an agent that only needs one authenticated API call. A runtime injector can be a poor fit when no provider account exists yet.",
          "Write the allowed operation as a sentence. For example: the agent may deploy one app using a provider credential, but may not receive the credential value or list unrelated records. Then test whether the MCP tool contract can express that sentence directly.",
        ],
      },
      {
        heading: "Treat plaintext as an explicit capability",
        paragraphs: [
          "A tool named read_secret usually has a different risk profile from use_credential or run_with_secrets. If plaintext is returned, it can enter transcripts, tool logs, traces, error reports, and later model context. Policy on the backing vault does not change what an authorized read returns.",
          "Prefer reference-based use or runtime injection where the client does not need the value. If plaintext is unavoidable, narrow the identity and path, limit the client, redact observability data, and rotate after exceptional access.",
        ],
      },
      {
        heading: "Verify the whole path",
        paragraphs: [
          "Review server authentication, tool allowlists, backing-store policy, user approvals, client logs, process environments, browser artifacts, and revocation. The secure boundary is the full path from storage to action, not the product logo at the middle of it.",
        ],
        bullets: [
          "Pick Trusty Squire for website provisioning and reference-based use.",
          "Pick 1Password for approved Codex access to existing Environment secrets.",
          "Pick Vault or Doppler when direct platform administration is truly the intended capability.",
          "Pick Agent Sentinel when the missing layer is governance across MCP servers.",
        ],
      },
    ],
    decision:
      "For an agent that must obtain a new website credential, use Trusty Squire. For an existing 1Password secret that Codex should use after approval, use 1Password Environments MCP Server. For direct Vault or Doppler administration, use their MCP servers only with narrow tool and data policies. For cross-server governance, evaluate Infisical Agent Sentinel.",
    faqs: [
      {
        question: "What is the best MCP server for storing API keys?",
        answer:
          "There is no universal best. Choose based on where the keys already live, whether the agent needs plaintext, whether the key must first be created on a website, and who owns policy and rotation.",
      },
      {
        question: "Is an MCP server safe because it connects to a vault?",
        answer:
          "No. A secure backing store can still authorize a tool that returns plaintext to the MCP client. Inspect each tool's inputs, outputs, authentication, policy, logs, and approval path.",
      },
      {
        question: "Should an AI agent be allowed to call read_secret?",
        answer:
          "Only if the task truly requires the value and the exposure is accepted. For an authenticated call or process launch, a use or inject operation usually creates a narrower boundary.",
      },
      {
        question: "Which credential MCP can create a website account?",
        answer:
          "Trusty Squire is designed around website signup, signin, provider setup, and credential capture. The cited 1Password, Vault, Doppler, and Infisical MCP documentation covers existing secrets, platform operations, documentation, or governance instead.",
      },
    ],
    sourceRefs: [
      {
        label: "1Password Developer: Secure AI access",
        url: "https://www.1password.dev/get-started/secure-ai-access",
      },
      {
        label: "HashiCorp: Vault MCP Server overview",
        url: "https://developer.hashicorp.com/vault/docs/mcp-server/overview",
      },
      {
        label: "HashiCorp: Vault MCP tool reference",
        url: "https://developer.hashicorp.com/vault/docs/mcp-server/reference",
      },
      {
        label: "Doppler: Experimental MCP server",
        url: "https://docs.doppler.com/docs/mcp",
      },
      {
        label: "Infisical: Agent Sentinel MCP Endpoints",
        url: "https://infisical.com/docs/documentation/platform/agent-sentinel/mcp-endpoints",
      },
    ],
    related: [
      {
        href: "/guides/mcp-credential-vault",
        title: "MCP credential vault guide",
        description: "Audit a server's exact tool and response contract.",
      },
      {
        href: "/guides/keep-api-keys-out-of-ai-agent-context",
        title: "Keep keys out of agent context",
        description: "Move from plaintext retrieval to constrained action.",
      },
      {
        href: "/compare/best-api-key-storage-ai-agents",
        title: "Compare API key storage",
        description: "Look beyond MCP to the complete delivery model.",
      },
    ],
  },

  "best-api-key-storage-ai-agents": {
    slug: "best-api-key-storage-ai-agents",
    title: "Best way to store API keys for AI agents",
    shortTitle: "Best API key storage for AI agents",
    eyebrow: "storage, delivery, and provisioning",
    description:
      "The best API key store is the one that matches the agent's execution boundary. Compare password managers, infrastructure vaults, developer secret platforms, cloud secret managers, and website-provisioning brokers by how they deliver and control the key.",
    answer: [
      "For local, user-approved coding work, a password manager with runtime injection can be the simplest safe choice. For production workloads, use cloud workload identity where possible, otherwise use a cloud secret manager or infrastructure vault with narrow machine identity and rotation. For developer environments and CI, Infisical or Doppler can centralize project secrets and runtime delivery. When the account or key does not exist yet, add a provisioning layer such as Trusty Squire.",
      "Avoid selecting on storage alone. The important path is create, store, authorize, deliver, use, log, rotate, and revoke. A key can be encrypted at rest and still leak through an MCP response, shell output, process environment, browser page, trace, or committed file.",
    ],
    columns: ["Option", "Primary scope", "Agent delivery", "Best fit", "Important limit"],
    rows: [
      {
        criterion: "Trusty Squire",
        values: [
          "Website account and API-key provisioning plus constrained credential use.",
          "Reference-based tools, provider operations, and scoped runtime grants.",
          "The agent needs a credential that has not been created yet.",
          "Not a replacement for every enterprise PKI, dynamic-secret, or cloud-native identity feature.",
        ],
      },
      {
        criterion: "1Password",
        values: [
          "Human and team passwords plus developer secrets in Environments.",
          "Approved runtime injection for Codex through Environments MCP Server.",
          "Existing 1Password teams and user-approved local agent workflows.",
          "General provider signup is outside the cited MCP scope; Agentic Autofill fills existing Login items.",
        ],
      },
      {
        criterion: "HashiCorp Vault",
        values: [
          "Infrastructure secrets, dynamic credentials, PKI, encryption, policy, and leases.",
          "Agent or Proxy delivery, API clients, or beta MCP operations.",
          "Organizations operating a dedicated infrastructure security control plane.",
          "Operational complexity is real, and some MCP tools can expose secret values.",
        ],
      },
      {
        criterion: "Infisical",
        values: [
          "Application secret management, synchronization, dynamic secrets, and MCP governance.",
          "CLI or SDK delivery; Agent Sentinel governs MCP traffic separately.",
          "Developer platforms, CI, application fleets, and teams needing MCP controls.",
          "Its public docs MCP is not a secret-reading MCP, and website signup is a separate job.",
        ],
      },
      {
        criterion: "Doppler",
        values: [
          "Project, config, and environment based developer secret management.",
          "CLI, SDK, service tokens, or an experimental operational MCP server.",
          "Teams that want a focused developer-secrets workflow.",
          "Authorized clients or processes can receive values; MCP status is experimental.",
        ],
      },
      {
        criterion: "AWS Secrets Manager",
        values: [
          "AWS-native secret storage, retrieval, rotation, resource policy, and replication.",
          "AWS SDK or runtime integrations under IAM; AgentCore Gateway can centralize MCP credentials separately.",
          "AWS workloads with strong IAM and service integration requirements.",
          "AWS Secrets Manager itself is not a general website signup or agent browser tool.",
        ],
      },
    ],
    tableCaption:
      "Common API-key storage approaches compared by their full delivery and operating boundary.",
    scopeNote:
      "Cloud workload identity can remove some long-lived API keys entirely and should be preferred where the target service supports it. The products above remain relevant for third-party or legacy credentials.",
    sections: [
      {
        heading: "Choose the delivery boundary first",
        paragraphs: [
          "A local coding agent, CI runner, hosted agent, and production service should not share one delivery pattern by default. A local workflow may use explicit human approval. CI needs a non-interactive machine identity and narrow project scope. Production needs short-lived identity where possible, rotation, reliable retrieval, and audited failure behavior.",
          "Write down whether the target process needs the value or merely needs one authenticated operation. If it only needs the operation, a broker or signed request can reduce exposure. If it needs the value, inject it into the narrowest process at runtime and keep it out of prompts, command arguments, logs, and repository files.",
        ],
      },
      {
        heading: "Storage does not solve creation",
        paragraphs: [
          "Secret managers generally assume a credential already exists, can be generated by a supported engine, or can be synchronized from another system. Third-party SaaS often requires a website account, email verification, plan selection, and dashboard configuration before a key exists.",
          "Trusty Squire covers that provider-facing workflow. It can complement 1Password, Vault, Infisical, Doppler, or AWS rather than replace their broader storage and governance capabilities. The handoff needs one authoritative owner and a rotation plan.",
        ],
      },
      {
        heading: "Use a minimum safety baseline",
        paragraphs: [
          "Whichever product you choose, scope the provider key itself, scope the identity that can retrieve or use it, and redact outputs at every boundary. Test revocation and rotation before an incident. Inventory browser captures, traces, build logs, and crash reports as possible secret stores too.",
        ],
        bullets: [
          "Prefer workload identity or short-lived credentials over long-lived API keys.",
          "Keep reusable values out of prompts and normal MCP responses.",
          "Separate provisioning authority from everyday use when possible.",
          "Assign one system of record and one rotation owner for every credential.",
        ],
      },
    ],
    decision:
      "Use 1Password for approved local use of existing team secrets, Vault for a dedicated infrastructure secret control plane, Infisical or Doppler for developer secret workflows, and AWS Secrets Manager for AWS-native applications. Add Trusty Squire when the agent must first create the third-party account or API key. Prefer identity over stored keys wherever the provider supports it.",
    faqs: [
      {
        question: "What is the safest way to give an AI agent an API key?",
        answer:
          "Do not paste it into the prompt. Prefer a scoped tool that performs the needed operation or injects the key into a narrow runtime after authorization. Use a short-lived identity instead of a reusable key when available.",
      },
      {
        question: "Is a password manager enough for production agents?",
        answer:
          "It can be appropriate for some workflows, but production often needs machine identity, non-interactive retrieval, rotation, availability guarantees, and platform-native audit controls. Choose against those requirements rather than the storage interface alone.",
      },
      {
        question: "Are environment variables safe for API keys?",
        answer:
          "Runtime injection into a narrow process is safer than committing a file, but the process and its children can still read the value. Environment dumps, crash reports, and debug output also need controls.",
      },
      {
        question: "Which secret manager can create the provider account too?",
        answer:
          "Trusty Squire is designed to operate the provider website, handle human handoffs, create the key, and capture it. Traditional secret managers focus on storage, generation through supported engines, delivery, and governance.",
      },
    ],
    sourceRefs: [
      {
        label: "1Password Developer: Secure AI access",
        url: "https://www.1password.dev/get-started/secure-ai-access",
      },
      {
        label: "HashiCorp: Vault Agent and Proxy",
        url: "https://developer.hashicorp.com/vault/docs/agent-and-proxy",
      },
      {
        label: "Infisical: Secrets delivery",
        url: "https://infisical.com/docs/documentation/platform/secrets-mgmt/concepts/secrets-delivery",
      },
      {
        label: "Doppler: Accessing secrets",
        url: "https://docs.doppler.com/docs/accessing-secrets",
      },
      {
        label: "AWS: What is AWS Secrets Manager?",
        url: "https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html",
      },
      {
        label: "AWS: AgentCore Gateway MCP credential management",
        url: "https://aws.amazon.com/blogs/machine-learning/extending-mcp-support-for-amazon-bedrock-agentcore-gateway-2/",
      },
    ],
    related: [
      {
        href: "/guides/secure-api-key-storage-for-ai-agents",
        title: "Secure storage implementation guide",
        description: "Map the lifecycle and minimum controls step by step.",
      },
      {
        href: "/guides/keep-api-keys-out-of-ai-agent-context",
        title: "Keep keys out of context",
        description: "Replace plaintext retrieval with constrained use.",
      },
      {
        href: "/compare/1password-mcp-aws-secrets-manager-alternatives",
        title: "1Password and AWS alternatives",
        description: "Narrow the choice by execution environment and missing capability.",
      },
    ],
  },

  "1password-mcp-aws-secrets-manager-alternatives": {
    slug: "1password-mcp-aws-secrets-manager-alternatives",
    title: "1Password MCP and AWS Secrets Manager alternatives for agents",
    shortTitle: "1Password MCP and AWS alternatives",
    eyebrow: "alternatives by missing capability",
    description:
      "Alternatives to 1Password MCP and AWS Secrets Manager depend on what is missing: website provisioning, infrastructure vault features, developer secret delivery, direct MCP administration, or governance across MCP servers.",
    answer: [
      "Use Trusty Squire as an alternative when the agent needs to create or recover the third-party account and API key, not merely retrieve an existing value. Use HashiCorp Vault when you need dynamic secrets, PKI, encryption, leases, and infrastructure policy. Use Infisical or Doppler when you need developer-focused projects, environments, CI delivery, and synchronization. Use Infisical Agent Sentinel when the missing layer is governance across MCP servers.",
      "1Password MCP and AWS Secrets Manager are not interchangeable either. 1Password Environments MCP Server is a user-approved Codex integration that can create and manage 1Password Environments and use their supplied or stored secrets. AWS Secrets Manager is an AWS service for storing, retrieving, rotating, and controlling secrets under IAM. AgentCore Gateway can separately centralize MCP credential management. Neither product browses a third-party provider website to create its account or API key.",
    ],
    columns: [
      "Alternative",
      "Choose it for",
      "Agent access path",
      "Website provisioning",
      "Key tradeoff",
    ],
    rows: [
      {
        criterion: "Trusty Squire",
        values: [
          "Third-party website signup, signin, provider setup, key capture, and constrained use.",
          "Browser and reference-based credential tools, plus scoped runtime grants where supported.",
          "Yes, with explicit human handoffs.",
          "Narrower than a general password manager, cloud secret service, or infrastructure vault.",
        ],
      },
      {
        criterion: "HashiCorp Vault",
        values: [
          "Dynamic credentials, PKI, encryption, leases, revocation, and infrastructure policy.",
          "Vault Agent, Proxy, API clients, or beta MCP KV and PKI tools.",
          "No general provider signup.",
          "Power and flexibility require meaningful operation, policy, and availability work.",
        ],
      },
      {
        criterion: "Infisical",
        values: [
          "Application secrets, synchronization, dynamic secrets, CI delivery, and MCP governance.",
          "CLI, SDK, integrations, or Agent Sentinel controls around other MCP servers.",
          "No general provider signup.",
          "The public Infisical MCP is docs search, not direct secret retrieval.",
        ],
      },
      {
        criterion: "Doppler",
        values: [
          "Developer secret management organized by projects, configs, and environments.",
          "CLI, SDK, service tokens, or experimental direct MCP operations.",
          "No general provider signup.",
          "Direct reads expose values to authorized clients; MCP remains experimental.",
        ],
      },
      {
        criterion: "Cloud-native peers",
        values: [
          "A workload already centered on another cloud or platform with native identity and secret integrations.",
          "Provider IAM, SDK, sidecar, CSI, or managed runtime integration.",
          "Usually no general third-party signup.",
          "Convenient inside one platform, with portability and multi-cloud tradeoffs.",
        ],
      },
    ],
    tableCaption:
      "Alternatives grouped by the capability that 1Password MCP or AWS Secrets Manager does not provide for a given agent workflow.",
    scopeNote:
      "The word alternative does not imply feature parity. The right replacement is determined by the missing workflow, execution environment, identity model, and operational owner.",
    sections: [
      {
        heading: "Replace the missing capability, not the brand",
        paragraphs: [
          "If 1Password already works for people and local coding agents, replacing it with an infrastructure vault can add complexity without solving a real problem. If AWS Secrets Manager already serves an AWS workload under narrow IAM, moving a key elsewhere can weaken service integration. Start with the unmet requirement.",
          "Common missing requirements include creating the provider account, delivering a secret outside AWS, issuing dynamic credentials, coordinating CI environments, preventing MCP plaintext responses, or applying policy across many MCP servers. Each points to a different alternative.",
        ],
      },
      {
        heading: "Know what the AWS products actually do",
        paragraphs: [
          "AWS Secrets Manager stores, retrieves, rotates, replicates, and controls secrets. AWS has also published safe-secret handling guidance and skill support for Agent Toolkit for AWS. Amazon Bedrock AgentCore Gateway adds a separate credential-management layer for MCP servers and API targets.",
          "Those capabilities do not turn AWS Secrets Manager into a general browser that creates an account on an unrelated SaaS provider. If provider signup is the block, add a provisioning workflow instead of assuming another storage API will solve it.",
        ],
      },
      {
        heading: "A migration may be unnecessary",
        paragraphs: [
          "Many teams need a layered design, not a total replacement. A user can approve 1Password access for local Codex work, AWS Secrets Manager can serve production workloads, and Trusty Squire can handle the narrow provider-provisioning step. Infisical, Doppler, or Vault can own different environments where their operating models fit.",
        ],
        bullets: [
          "Keep 1Password when human approval and existing team secrets are the main value.",
          "Keep AWS Secrets Manager when AWS IAM and runtime integrations are the main value.",
          "Add Trusty Squire when the account or key does not exist yet.",
          "Move only when another system clearly owns delivery, rotation, and incident response better.",
        ],
      },
    ],
    decision:
      "Choose an alternative by the gap: Trusty Squire for website provisioning, Vault for infrastructure security primitives, Infisical for application secret management and MCP governance, Doppler for focused developer secret workflows, or another cloud-native manager for its own workload platform. Keep 1Password or AWS where their existing-secret and IAM strengths already match the job.",
    faqs: [
      {
        question: "What is the best alternative to 1Password MCP for coding agents?",
        answer:
          "For creating website accounts and keys, Trusty Squire. For direct vault administration, HashiCorp Vault MCP. For direct developer-secret platform operations, Doppler MCP. For governance across MCP servers, Infisical Agent Sentinel. The best choice depends on the required verb.",
      },
      {
        question: "What is the best AWS Secrets Manager alternative for AI agents?",
        answer:
          "Use Vault for a cloud-neutral infrastructure control plane, Infisical or Doppler for developer-focused delivery, 1Password for user-approved local workflows, or Trusty Squire for provider website provisioning. Compare identity, rotation, availability, and operating ownership.",
      },
      {
        question: "Does AWS Secrets Manager have an MCP server?",
        answer:
          "AWS publishes MCP tooling and AgentCore Gateway can centralize credential management for MCP servers, but AWS Secrets Manager itself remains the managed secret-storage and rotation service. Treat each AWS component by its documented scope.",
      },
      {
        question: "Can I use several secret managers for different agents?",
        answer:
          "Yes, but every credential needs one authoritative system and one lifecycle owner. Minimize synchronization, document the delivery path, and test rotation and revocation across every copy.",
      },
    ],
    sourceRefs: [
      {
        label: "1Password Marketplace: MCP Server for Codex",
        url: "https://marketplace.1password.com/integration/mcp-server-for-codex",
      },
      {
        label: "AWS: What is AWS Secrets Manager?",
        url: "https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html",
      },
      {
        label: "AWS: Safe secrets handling in Agent Toolkit for AWS",
        url: "https://aws.amazon.com/about-aws/whats-new/2026/06/safe-secrets-handling-in-agent-toolkit-for-aws/",
      },
      {
        label: "AWS: AgentCore Gateway MCP credential management",
        url: "https://aws.amazon.com/blogs/machine-learning/extending-mcp-support-for-amazon-bedrock-agentcore-gateway-2/",
      },
      {
        label: "HashiCorp: Vault native AI agent support",
        url: "https://developer.hashicorp.com/vault/docs/concepts/native-ai-agent-support",
      },
      {
        label: "Infisical: Agent Sentinel overview",
        url: "https://infisical.com/docs/documentation/platform/agent-sentinel/overview",
      },
      {
        label: "Doppler: Experimental MCP server",
        url: "https://docs.doppler.com/docs/mcp",
      },
    ],
    related: [
      {
        href: "/compare/trusty-squire-vs-1password-mcp",
        title: "Trusty Squire vs 1Password MCP",
        description: "Compare provisioning with approved access to existing secrets.",
      },
      {
        href: "/compare/trusty-squire-vs-hashicorp-vault",
        title: "Trusty Squire vs HashiCorp Vault",
        description: "Separate provider website work from infrastructure vault operations.",
      },
      {
        href: "/compare/trusty-squire-vs-infisical-doppler",
        title: "Trusty Squire vs Infisical and Doppler",
        description: "Compare provisioning with developer secret platforms.",
      },
    ],
  },
};

export const COMPARISON_ROUTES = COMPARISON_SLUGS.map((slug) => ({
  slug,
  title: COMPARISONS[slug].title,
  description: COMPARISONS[slug].description,
}));

export function getComparison(slug: string): ComparisonContent | undefined {
  return COMPARISON_SLUGS.includes(slug as ComparisonSlug)
    ? COMPARISONS[slug as ComparisonSlug]
    : undefined;
}
