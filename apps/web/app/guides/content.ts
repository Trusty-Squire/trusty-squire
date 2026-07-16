import type { FaqItem } from "../lib/structured-data";

export interface GuideStep {
  title: string;
  description: string;
}

export interface GuideSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
}

export interface GuideLink {
  href: string;
  title: string;
  description: string;
}

export interface SourceRef {
  label: string;
  url: string;
}

export interface GuideContent {
  slug: GuideSlug;
  shortTitle: string;
  eyebrow: string;
  title: string;
  description: string;
  schemaType: "Article" | "HowTo";
  answer: string[];
  answerChecks: string[];
  steps: GuideStep[];
  sections: GuideSection[];
  productFit: string[];
  limits: string[];
  faqs: FaqItem[];
  related: GuideLink[];
  sourceRefs: SourceRef[];
}

export const GUIDE_SLUGS = [
  "keep-api-keys-out-of-ai-agent-context",
  "coding-agent-leaked-api-key-github",
  "mcp-credential-vault",
  "automate-signup-past-bot-detection",
  "coding-agent-create-account",
  "secure-api-key-storage-for-ai-agents",
] as const;

export type GuideSlug = (typeof GUIDE_SLUGS)[number];

export const GUIDES: Record<GuideSlug, GuideContent> = {
  "keep-api-keys-out-of-ai-agent-context": {
    slug: "keep-api-keys-out-of-ai-agent-context",
    shortTitle: "Keep keys out of agent context",
    eyebrow: "credential boundaries",
    title: "How to keep API keys out of AI agent context",
    description:
      "Use references, scoped execution, and last-moment injection so an agent can complete authenticated work without receiving the reusable provider key in its prompt or tool results.",
    schemaType: "HowTo",
    answer: [
      "Do not paste a reusable API key into a prompt. Store it in a system outside the model context, give the agent a stable reference to that record, and let a trusted execution layer attach the secret only to the approved provider request or process.",
      "This is a boundary, not a magic property of a vault. If the agent can print the process environment, read the destination file, inspect a browser page that displays the key, or query a tool that returns plaintext, the value can still enter context. Design the whole path, not only the storage box.",
    ],
    answerChecks: [
      "The model sees a credential name or opaque handle, not the value.",
      "The execution layer restricts where and how the credential can be used.",
      "Logs, screenshots, traces, and error messages are treated as possible disclosure paths.",
      "Access can be revoked without searching every prompt, file, and machine for copies.",
    ],
    steps: [
      {
        title: "Remove plaintext from the task input",
        description:
          "Replace copied keys in prompts, issue descriptions, shell history, and project notes with a neutral credential name such as neon-production.",
      },
      {
        title: "Store the value behind a separate trust boundary",
        description:
          "Use a vault, password manager, cloud secret manager, or broker whose access policy is independent from the agent conversation.",
      },
      {
        title: "Give the agent an operation, not a read primitive",
        description:
          "Prefer tools such as call this host with this saved credential over tools that return the credential value for the agent to assemble a request itself.",
      },
      {
        title: "Constrain the use",
        description:
          "Limit hosts, methods, scopes, rate, environment, and lifetime wherever the secret system supports those controls.",
      },
      {
        title: "Verify the negative paths",
        description:
          "Ask whether a failed request, debug capture, subprocess, or generated config can reveal the value. Test those paths before trusting the design.",
      },
    ],
    sections: [
      {
        heading: "Model context is only one disclosure surface",
        paragraphs: [
          "Keeping a key out of the initial prompt is necessary but incomplete. Tool output becomes context too. So can terminal output, a file the agent is allowed to read, a browser screenshot, an exception containing request headers, or a command that prints environment variables.",
          "The useful question is whether the agent can recover the reusable value by any allowed path. A system that hides the key in one UI but returns it through an MCP read tool has changed the route, not the exposure.",
        ],
      },
      {
        heading: "Runtime injection has different strengths",
        paragraphs: [
          "Environment injection is practical for applications, but a coding agent with shell access may be able to print that environment. File mounts remove plaintext from the repository, yet the running process and any reader with file permission can still access the value.",
          "A request broker can create a narrower boundary. The caller supplies the destination and operation, the broker attaches the secret server-side, and the caller receives the provider response. That pattern is strongest when the destination and permitted operation are enforced rather than merely suggested.",
        ],
      },
      {
        heading: "Minimize the credential even when it stays hidden",
        paragraphs: [
          "A hidden organization-owner token is still an organization-owner token. Prefer provider keys with the smallest useful scope, separate development from production, and issue short-lived or revocable grants to deployed apps when possible.",
        ],
        bullets: [
          "Use a separate credential per application or environment.",
          "Restrict provider-side permissions before relying on local controls.",
          "Rotate after suspected exposure, even if you later delete the leaked text.",
          "Keep an audit trail of use that does not record the secret itself.",
        ],
      },
    ],
    productFit: [
      "Trusty Squire is useful when the agent needs to create the credential on a website and then use it without receiving the raw value. Its browser tools can capture a generated key into the vault, while credential tools refer to saved records and inject credentials into allowed provider requests server-side.",
      "For deployed software, Trusty Squire can issue a scoped app grant instead of placing the provider key in the application. The grant can be audited and revoked independently from the underlying provider credential.",
    ],
    limits: [
      "Anything visibly rendered in a browser can appear in screenshots or diagnostics, so those artifacts remain sensitive.",
      "The provider still receives its credential. The claim is about keeping the reusable value out of agent context and the consuming app, not making authentication secret-free.",
      "A human can reveal a saved value in the web vault, so account access and device security still matter.",
    ],
    faqs: [
      {
        question: "Is an environment variable outside AI context?",
        answer:
          "Not automatically. If the agent can execute a command that prints the environment, inspect the child process, or read a generated file, the value can enter context. Environment injection is useful, but it must be paired with tool and process boundaries.",
      },
      {
        question: "Can an MCP server safely return an API key?",
        answer:
          "It can transport one, but returning plaintext makes the key available to the MCP client and potentially the model context. A safer credential tool performs the approved operation or runtime injection without returning the reusable value.",
      },
      {
        question: "Does masking a key in logs solve the problem?",
        answer:
          "Masking reduces one disclosure route. It does not protect prompts, tool results, files, screenshots, shell history, or unrestricted read APIs. Treat masking as one control in a larger boundary.",
      },
      {
        question: "What should the agent receive instead of the key?",
        answer:
          "Give it an opaque credential identifier, a scoped grant, or a tool that can perform a specific authenticated operation. The identifier should not itself be accepted by the third-party provider as the reusable secret.",
      },
    ],
    related: [
      {
        href: "/guides/mcp-credential-vault",
        title: "Evaluate an MCP credential vault",
        description: "Separate storage from safe agent use and inspect the tool contract.",
      },
      {
        href: "/guides/secure-api-key-storage-for-ai-agents",
        title: "Choose an API key storage architecture",
        description: "Compare local, cloud, and brokered patterns for agent workflows.",
      },
      {
        href: "/use-cases/api-keys-without-env",
        title: "Use API keys without .env",
        description: "See how Trusty Squire handles generated credentials and app grants.",
      },
    ],
    sourceRefs: [
      {
        label: "1Password: Secure AI access",
        url: "https://www.1password.dev/get-started/secure-ai-access",
      },
      {
        label: "GitHub: Push protection and secret leakage prevention",
        url: "https://docs.github.com/en/code-security/concepts/secret-security/push-protection",
      },
    ],
  },

  "coding-agent-leaked-api-key-github": {
    slug: "coding-agent-leaked-api-key-github",
    shortTitle: "Coding agent leaked a key",
    eyebrow: "incident response",
    title: "A coding agent leaked an API key to GitHub. Do this first.",
    description:
      "Revoke or rotate the credential before cleaning Git history, then audit use, update every legitimate consumer, and close the path that allowed plaintext into the repository.",
    schemaType: "HowTo",
    answer: [
      "Revoke or rotate the exposed credential first. Deleting the line, closing the pull request, making the repository private, or rewriting Git history does not make the old value safe. Assume anyone with access to the commit, a fork, a clone, a cache, or a notification could have copied it.",
      "After the provider confirms the old credential no longer works, identify every legitimate workload that used it, replace those references, review provider and repository audit logs, and decide whether history rewriting is worth its coordination cost.",
    ],
    answerChecks: [
      "The provider reports the old credential as revoked, disabled, or replaced.",
      "Production, CI, local development, and integrations use the replacement credential.",
      "Usage since the first exposed commit has been reviewed for unexpected activity.",
      "The agent workflow no longer has a path that writes raw values into repository files.",
    ],
    steps: [
      {
        title: "Contain the credential",
        description:
          "Revoke, disable, or rotate it in the issuing provider. If the key controls rotation itself, escalate through that provider's incident process.",
      },
      {
        title: "Find the exposure window",
        description:
          "Record the first commit, branch, pull request, logs, forks, and time range in which the value was accessible.",
      },
      {
        title: "Audit use",
        description:
          "Review provider activity, billing, IP addresses, repository audit events, and affected application logs for actions outside the expected pattern.",
      },
      {
        title: "Replace legitimate consumers",
        description:
          "Update CI, deployments, developer environments, and integrations with a new, narrower credential. Confirm each consumer before removing temporary compatibility.",
      },
      {
        title: "Clean history and prevent recurrence",
        description:
          "Follow GitHub's coordinated history-removal guidance if necessary, then enable push protection and change the agent's credential path.",
      },
    ],
    sections: [
      {
        heading: "Why rotation comes before deletion",
        paragraphs: [
          "Git is designed to preserve content. A secret removed from the current branch can remain in earlier commits, local clones, forks, pull request references, or caches. History rewriting changes commit identifiers and requires coordination, but it still cannot erase copies outside your control.",
          "Provider-side revocation changes the security fact that matters: whether the exposed string still authorizes access. GitHub's own removal guidance therefore says to revoke or rotate a secret before considering history cleanup.",
        ],
      },
      {
        heading: "Treat the agent as one source, not the whole cause",
        paragraphs: [
          "The immediate event may be agent-generated code, but the system allowed a reusable credential to enter a writable or readable path. Look for raw keys in prompts, MCP results, shell output, copied dashboard values, generated configuration, test fixtures, and logs.",
          "Fix the narrowest root cause that blocks the class of incident. A lint rule helps with recognizable patterns. Push protection can stop supported secrets at push time. A vault or broker can keep the value out of the file-generation path entirely.",
        ],
      },
      {
        heading: "What to document",
        paragraphs: [
          "Write down when the key was created, first exposed, revoked, and replaced. Record the permissions it held and what systems were reachable. Preserve non-secret evidence needed for an investigation without copying the key into the incident document.",
        ],
        bullets: [
          "Provider credential identifier and scope, never the full value.",
          "Repositories, branches, pull requests, forks, and build logs involved.",
          "Expected consumers and the time each received the replacement.",
          "Suspicious use, billing changes, or access from unknown networks.",
        ],
      },
    ],
    productFit: [
      "Trusty Squire can reduce a repeat when the leaked credential originates in a website setup flow. The agent can ask Trusty Squire to capture the generated value directly into its vault instead of copying it through chat or a generated file.",
      "If a scoped Trusty Squire app grant leaks, that grant can be revoked without immediately rotating the underlying provider key. A leaked provider key still requires provider-side revocation or rotation.",
    ],
    limits: [
      "Trusty Squire cannot invalidate a third-party provider key unless that provider operation is available and authorized.",
      "Repository cleanup remains a GitHub and Git coordination task.",
      "Secret scanning does not recognize every credential format and should not be the only preventive control.",
    ],
    faqs: [
      {
        question: "Is deleting the GitHub commit enough after an API key leak?",
        answer:
          "No. Copies may remain in Git history, clones, forks, pull request references, caches, or notifications. Revoke or rotate the credential at the provider first so the exposed value no longer grants access.",
      },
      {
        question: "Should I make the repository private before rotating the key?",
        answer:
          "You can restrict further viewing immediately, but do not delay revocation or rotation. Anyone who already saw or copied the key can keep using it until the provider rejects it.",
      },
      {
        question: "Do I always need to rewrite Git history?",
        answer:
          "Not always. Once the secret is revoked, history rewriting may add coordination cost without reducing active credential risk. Use GitHub's guidance to weigh forks, cached views, compliance needs, and the disruption of changed commit hashes.",
      },
      {
        question: "How do I stop a coding agent from leaking the next key?",
        answer:
          "Keep raw values out of prompts and file-writing tools, use a vault or broker with non-reading operations, enable GitHub push protection, and test whether logs, screenshots, and shell commands can still disclose the value.",
      },
    ],
    related: [
      {
        href: "/guides/keep-api-keys-out-of-ai-agent-context",
        title: "Keep the replacement key out of context",
        description: "Build a boundary that gives the agent an operation instead of plaintext.",
      },
      {
        href: "/guides/secure-api-key-storage-for-ai-agents",
        title: "Store keys for agent workflows",
        description: "Choose a storage and delivery pattern after containment.",
      },
      {
        href: "/use-cases/api-keys-without-env",
        title: "Use a revocable app grant",
        description: "Keep the provider credential out of the consuming application.",
      },
    ],
    sourceRefs: [
      {
        label: "GitHub: Removing sensitive data from a repository",
        url: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository",
      },
      {
        label: "GitHub: Push protection",
        url: "https://docs.github.com/en/code-security/concepts/secret-security/push-protection",
      },
      {
        label: "GitHub: Secret scanning detection scope",
        url: "https://docs.github.com/en/code-security/reference/secret-security/secret-scanning-scope",
      },
    ],
  },

  "mcp-credential-vault": {
    slug: "mcp-credential-vault",
    shortTitle: "MCP credential vault",
    eyebrow: "MCP architecture",
    title: "What an MCP credential vault should do",
    description:
      "A useful MCP credential vault must define what the model can discover, whether tools return plaintext, how secrets reach their destination, and which policy is enforced outside the prompt.",
    schemaType: "Article",
    answer: [
      "An MCP credential vault is not safe merely because it stores encrypted values. Its tool contract matters more to the agent boundary: can the client read a secret, or can it only request a specific use? The strongest design keeps reusable values out of MCP responses and performs the approved operation in a trusted execution layer.",
      "Evaluate storage, retrieval, use, policy, and observability separately. Products use the term MCP for very different jobs, including documentation search, vault administration, secret retrieval, runtime injection, and website operation.",
    ],
    answerChecks: [
      "Tool descriptions make plaintext-returning operations obvious.",
      "Permissions are enforced by the vault or provider, not only by prompt instructions.",
      "The system can bind use to a host, operation, scope, identity, or lifetime.",
      "Audit records describe access without copying secret values.",
    ],
    steps: [
      {
        title: "List every MCP credential tool",
        description:
          "Classify each tool as metadata-only, plaintext read, write, runtime injection, request execution, or credential provisioning.",
      },
      {
        title: "Trace the secret path",
        description:
          "Follow the value from creation or import to storage, MCP response, process, browser, provider request, logs, and backups.",
      },
      {
        title: "Inspect the authorization layer",
        description:
          "Verify token permissions, user approval, vault policy, host restrictions, and whether the model can widen scope through another tool.",
      },
      {
        title: "Test denial and failure",
        description:
          "Try an unapproved host, unsupported method, expired grant, failed provider call, and verbose debug path. Confirm failures do not include plaintext.",
      },
      {
        title: "Match the product to the missing job",
        description:
          "Choose storage administration, runtime secret delivery, MCP governance, or website provisioning based on what your workflow actually lacks.",
      },
    ],
    sections: [
      {
        heading: "MCP describes the connection, not the safety model",
        paragraphs: [
          "Model Context Protocol standardizes how a client discovers and calls tools. It does not make every tool non-exposing. A read_secret tool can intentionally return a value; a documentation MCP may expose no operational secret at all; a broker tool may accept a credential handle and make a provider request without returning the value.",
          "Read the actual tool schema and product warning. Do not infer secret handling from the presence of MCP in the product name.",
        ],
      },
      {
        heading: "Storage and provisioning are different jobs",
        paragraphs: [
          "Most secret managers begin after a credential already exists. They organize, rotate, synchronize, or inject it. A provisioning workflow begins earlier: open the provider website, create or sign into the account, configure a project, generate the key, and capture it.",
          "A team may need both. A mature infrastructure vault can remain the source of truth while a browser operator handles a missing website step, or a provisioning tool can be enough for a small agent-driven project. Compare the handoff, not only the feature lists.",
        ],
      },
      {
        heading: "A practical evaluation matrix",
        paragraphs: [
          "Write the required outcome in operational terms, then score each candidate against the full path. Avoid a single secure or insecure label.",
        ],
        bullets: [
          "Creation: can it generate or capture the credential, or only import one?",
          "Custody: which services, processes, and humans can recover plaintext?",
          "Use: does it reveal, inject, proxy, autofill, or execute an authenticated call?",
          "Control: what is enforced by policy, token scope, network boundary, or approval?",
          "Recovery: how are rotation, revocation, audit, and incident response handled?",
        ],
      },
    ],
    productFit: [
      "Trusty Squire combines website operation with a write-oriented credential path. It can work through signup or authenticated configuration, capture a displayed API key into its vault, and later let an agent use the saved credential without returning the raw value through credential tools.",
      "That scope differs from products whose MCP servers administer an existing vault, inject environment variables, or govern access to other MCP servers. The best choice depends on whether your missing step is website provisioning, secret storage, infrastructure identity, or MCP governance.",
    ],
    limits: [
      "Browser-visible values can enter screenshots and diagnostics, so capture artifacts need sensitive handling.",
      "Trusty Squire does not replace every enterprise secret engine, dynamic database credential system, or organization-wide password manager.",
      "Website flows change and can require human decisions, payment, phone verification, or a challenge the system should not bypass.",
    ],
    faqs: [
      {
        question: "Does MCP encrypt secrets?",
        answer:
          "MCP defines a protocol for clients and servers. Encryption, secret storage, tool output, and authorization are properties of the specific implementation and transport. Inspect the product's tool contract and deployment model.",
      },
      {
        question: "Is a read_secret MCP tool unsafe?",
        answer:
          "It is intentionally exposing for clients that need plaintext, and it may be acceptable in a tightly controlled workflow. It is not the right primitive when the requirement is to keep reusable values outside the MCP client or model context.",
      },
      {
        question: "Can one MCP server both store and use credentials?",
        answer:
          "Yes, but the operations should remain distinct. A write operation can save a secret, while a constrained use operation can call an approved destination without exposing the stored value.",
      },
      {
        question: "Do I still need provider-side least privilege?",
        answer:
          "Yes. A vault boundary reduces exposure, but an overpowered credential can still cause broad damage if the vault, agent grant, or approved destination is compromised.",
      },
    ],
    related: [
      {
        href: "/compare/best-mcp-credential-management",
        title: "Compare credential MCP approaches",
        description: "See which products retrieve, inject, govern, or provision credentials.",
      },
      {
        href: "/guides/keep-api-keys-out-of-ai-agent-context",
        title: "Keep values out of context",
        description: "Trace the negative paths beyond encrypted storage.",
      },
      {
        href: "/use-cases/website-signup",
        title: "See website provisioning",
        description: "Follow the flow from public signup page to saved credential.",
      },
    ],
    sourceRefs: [
      {
        label: "HashiCorp Vault MCP server overview",
        url: "https://developer.hashicorp.com/vault/docs/mcp-server/overview",
      },
      {
        label: "Doppler MCP server",
        url: "https://docs.doppler.com/docs/mcp",
      },
      {
        label: "Infisical documentation MCP server",
        url: "https://infisical.com/docs/ai/model-context-protocol",
      },
    ],
  },

  "automate-signup-past-bot-detection": {
    slug: "automate-signup-past-bot-detection",
    shortTitle: "Signup past bot detection",
    eyebrow: "website automation",
    title: "Automating signup past bot detection without pretending it is guaranteed",
    description:
      "Use a real, observable browser flow, behave like a normal account owner, and hand control back when a site requires a human challenge. Do not treat anti-abuse controls as an obstacle to defeat.",
    schemaType: "Article",
    answer: [
      "There is no responsible universal bypass for signup bot detection. The practical approach is to run the real website in a normal browser session, take one visible action at a time, reuse an identity session only with the user's consent, and stop for hard CAPTCHAs, including interactive Turnstile challenges, plus phone checks, payment, or terms decisions that require a person.",
      "Automation should reduce false positives and manual navigation, not impersonate a human or evade a site's controls. A service can still reject the network, browser, email domain, account pattern, or request frequency. Treat that as a boundary, not a prompt-engineering failure.",
    ],
    answerChecks: [
      "The automation uses the public signup flow and does not target hidden or private endpoints.",
      "A person can see what page is open and take over when required.",
      "Retries are limited and do not hammer the service after a denial.",
      "The flow records an honest blocked or needs-human result instead of inventing success.",
    ],
    steps: [
      {
        title: "Start with the supported path",
        description:
          "Open the provider's public signup page and choose the same authentication method the account owner would choose manually.",
      },
      {
        title: "Use a stable browser identity",
        description:
          "Keep the user's explicitly connected Google or GitHub session in the browser rather than copying passwords into the agent task.",
      },
      {
        title: "Observe before every action",
        description:
          "Read the current page, choose one step, and verify the resulting state. Avoid brittle scripts that assume yesterday's DOM or skip consent screens.",
      },
      {
        title: "Hand off hard gates",
        description:
          "Pause for CAPTCHA, phone verification, payment, legal acceptance, account selection, or any risk decision that should belong to the user.",
      },
      {
        title: "Stop cleanly when denied",
        description:
          "Report the provider, page, and gate. Do not loop indefinitely, create duplicate accounts, or claim completion without a usable authenticated result.",
      },
    ],
    sections: [
      {
        heading: "Why a real browser helps but does not guarantee access",
        paragraphs: [
          "Many developer signups depend on redirects, cookies, client-side state, email links, and OAuth account selection. A full browser preserves those ordinary mechanics better than a raw HTTP script and lets the user inspect the live flow.",
          "Anti-abuse systems evaluate more than JavaScript execution. Network reputation, signup velocity, identity history, device state, email quality, and provider-specific rules can still block the account. No browser choice can promise acceptance.",
        ],
      },
      {
        heading: "CAPTCHA is a handoff signal",
        paragraphs: [
          "A challenge can indicate that the site wants evidence of a human or additional confidence in the request. The safe automation response is to pause and let the account owner complete or abandon it. Outsourcing challenge solving or disguising automation may violate the site's rules and can create low-quality accounts that are disabled later.",
        ],
      },
      {
        heading: "Design the result taxonomy before the retry loop",
        paragraphs: [
          "A signup runner needs more outcomes than success and failure. Distinguish a temporary page error from a human-required gate, an unsupported auth method, a duplicate account, provider rejection, and a completed account with unfinished project setup.",
        ],
        bullets: [
          "Success: the requested account or project is usable.",
          "Needs human: a person must complete a bounded action.",
          "Blocked: the provider rejected or disallowed the flow.",
          "Retryable: a temporary technical error has a safe retry budget.",
          "Partial: the account exists but the requested configuration or credential does not.",
        ],
      },
    ],
    productFit: [
      "Trusty Squire opens the real signup page in a persistent browser, lets the coding agent observe and act one step at a time, and can reuse a Google or GitHub session that the user connects in that browser. The goal is to complete ordinary website work, not to defeat anti-abuse systems.",
      "When a flow produces an API key, Trusty Squire can capture it into the vault. When the site asks for a human-only action or an important decision, the run should stop and explain the boundary.",
    ],
    limits: [
      "Trusty Squire does not guarantee that a provider will accept an automated signup.",
      "Trusty Squire stops at hard CAPTCHAs, including interactive Turnstile challenges. Phone checks, payment, and legal or risk decisions also require a user handoff.",
      "Website changes can break a replayed flow and require fresh observation.",
    ],
    faqs: [
      {
        question: "Can an AI agent bypass CAPTCHA during signup?",
        answer:
          "It should not promise or attempt a universal bypass. A responsible flow pauses for a human challenge or reports that the provider blocked the signup.",
      },
      {
        question: "Does using a real browser avoid bot detection?",
        answer:
          "It supports normal redirects, cookies, OAuth, and client-side flows, which can reduce automation breakage. The provider can still evaluate network, identity, velocity, and other signals and reject the signup.",
      },
      {
        question: "Should the automation keep retrying a rejected signup?",
        answer:
          "No. Use a small retry budget only for temporary technical failures. Repeated attempts after a provider denial can create duplicates, trigger stronger controls, or violate service rules.",
      },
      {
        question: "What should happen when payment or terms appear?",
        answer:
          "Pause and ask the user. Pricing selection, payment authorization, contract acceptance, and other consequential choices should not be guessed from the original task.",
      },
    ],
    related: [
      {
        href: "/guides/coding-agent-create-account",
        title: "Unblock an agent that cannot create an account",
        description: "Diagnose identity, browser, verification, and outcome gaps.",
      },
      {
        href: "/use-cases/website-signup",
        title: "See the website signup flow",
        description: "Understand where the browser, verification, and vault fit.",
      },
      {
        href: "/guides/mcp-credential-vault",
        title: "Store the generated credential",
        description: "Evaluate the tool boundary after signup succeeds.",
      },
    ],
    sourceRefs: [],
  },

  "coding-agent-create-account": {
    slug: "coding-agent-create-account",
    shortTitle: "Agent cannot create an account",
    eyebrow: "signup troubleshooting",
    title: "Why your coding agent cannot create an account, and how to unblock it",
    description:
      "Most account-creation failures come from a missing browser identity, verification path, human decision, or credential handoff, not from the model being unable to click a button.",
    schemaType: "HowTo",
    answer: [
      "Give the agent a real browser it can observe, a user-approved identity session, a way to complete email verification, and a precise definition of the finished outcome. Then separate retryable page errors from gates that require you.",
      "Do not hand the agent your primary password or assume that account created means the job is done. Developer setup often continues through project creation, callback URLs, API key generation, and secure storage.",
    ],
    answerChecks: [
      "The agent can open and inspect the provider's current signup page.",
      "Google, GitHub, or email verification is available through an approved path.",
      "The requested account, project, region, and credential outcome are explicit.",
      "The workflow knows when to pause for phone, payment, CAPTCHA, or account choice.",
    ],
    steps: [
      {
        title: "Name the final artifact",
        description:
          "Ask for the account plus the project, integration, or API credential your code needs. This prevents a shallow stop at the welcome page.",
      },
      {
        title: "Connect identity in a real browser",
        description:
          "Sign into Google or GitHub yourself in the browser profile the agent will use. Do not paste the identity password into chat.",
      },
      {
        title: "Provide a verification route",
        description:
          "Use an inbox workflow for expected signup links or codes, with explicit consent and a human fallback for ambiguous messages.",
      },
      {
        title: "Classify the gate",
        description:
          "Distinguish a changed page, expired link, duplicate account, provider rejection, human challenge, and missing product decision before retrying.",
      },
      {
        title: "Capture the usable result",
        description:
          "Finish project configuration and store any generated credential outside the agent conversation or repository.",
      },
    ],
    sections: [
      {
        heading: "The browser is part of the identity boundary",
        paragraphs: [
          "A coding agent can reason about a form but still lack the authenticated session needed to submit it. OAuth redirects, account selectors, device checks, and cookie state belong to a browser profile. A separate unauthenticated automation context may look like a new device every run.",
          "Connect identity where you can see the real provider page. The agent can then operate the resulting session without learning your Google or GitHub password.",
        ],
      },
      {
        heading: "Verification needs a narrow contract",
        paragraphs: [
          "Email verification is not one generic task. A message can contain several links, codes, marketing buttons, and account notices. The workflow should expect a sender and purpose, extract only the relevant code or link, and stop when the message is ambiguous.",
          "Phone verification is a different boundary. If a site requires a personal number or device action, hand it to the account owner rather than inventing an identity workaround.",
        ],
      },
      {
        heading: "Define success past the signup screen",
        paragraphs: [
          "For a developer, the useful result may be a configured provider project, a verified domain, an OAuth client, or an API key. Write that endpoint into the request so the agent knows which post-signup steps are still part of the job.",
        ],
        bullets: [
          "Account exists under the intended identity.",
          "The correct organization, project, and environment are selected.",
          "Required callback URLs, domains, or webhooks are configured.",
          "The generated credential is stored and named for later use.",
        ],
      },
    ],
    productFit: [
      "Trusty Squire supplies the browser and credential pieces that ordinary coding agents lack. It can open the real signup site, use a Google or GitHub session the user connects, handle available email verification, and continue through authenticated setup.",
      "The coding agent remains responsible for the development goal and each next-step decision. Trusty Squire performs the scoped website action and can save a generated credential directly rather than returning it through credential tools.",
    ],
    limits: [
      "A site can require payment, phone verification, CAPTCHA, or a choice that belongs to the user.",
      "Not every changed website flow has a replayable skill, so the agent may need to observe and drive it fresh.",
      "Successful account creation does not prove that the requested project or integration is configured correctly.",
    ],
    faqs: [
      {
        question: "Why can my coding agent fill a form but not finish signup?",
        answer:
          "The missing step is often browser identity, email or phone verification, a CAPTCHA, account selection, or post-signup configuration. Form filling alone does not satisfy those contracts.",
      },
      {
        question: "Should I give the agent my Google password?",
        answer:
          "No. Sign in on the real Google page inside the browser profile the workflow uses. The browser can retain the resulting session without putting your password in the prompt.",
      },
      {
        question: "Can an agent automatically click every verification link?",
        answer:
          "It should only follow an expected link for the requested signup and sender. Ambiguous messages, security alerts, password resets, and unrelated links need a human decision.",
      },
      {
        question: "What is a good signup prompt?",
        answer:
          "Name the service and the usable outcome, for example: create the account, create a project named Acme staging, generate its API key, and store the key under a specific credential name.",
      },
    ],
    related: [
      {
        href: "/guides/automate-signup-past-bot-detection",
        title: "Handle bot detection honestly",
        description: "Use a real browser and clear human handoffs without bypass promises.",
      },
      {
        href: "/use-cases/website-signup",
        title: "Let your agent sign up for a website",
        description: "See concrete asks and the complete Trusty Squire flow.",
      },
      {
        href: "/guides/keep-api-keys-out-of-ai-agent-context",
        title: "Protect the generated API key",
        description: "Keep the final credential out of prompts and tool output.",
      },
    ],
    sourceRefs: [],
  },

  "secure-api-key-storage-for-ai-agents": {
    slug: "secure-api-key-storage-for-ai-agents",
    shortTitle: "Secure key storage for agents",
    eyebrow: "architecture guide",
    title: "Secure API key storage for AI agents: a practical architecture",
    description:
      "Choose storage and delivery together. The right design depends on whether the agent must read a value, run a process, call an API, sign into a website, or create the credential from scratch.",
    schemaType: "HowTo",
    answer: [
      "Store reusable API keys outside prompts, repositories, and agent-readable project files. Give each workflow the narrowest possible way to use them: a runtime-injected process for application execution, a constrained provider request for API work, or approved browser autofill for an existing login.",
      "No single product is best for every path. Password managers, cloud secret managers, infrastructure vaults, developer secret platforms, MCP gateways, and provisioning tools solve overlapping but different jobs. Start with the operation and threat boundary.",
    ],
    answerChecks: [
      "A separate identity or token controls access to the secret store.",
      "The agent receives only the access needed for one project, environment, or task.",
      "Plaintext is not copied into generated code, chat, issue text, or persistent .env files.",
      "Rotation, revocation, audit, and application updates have an owner and tested path.",
    ],
    steps: [
      {
        title: "Inventory agent operations",
        description:
          "Separate website sign-in, provider signup, one-off API calls, local processes, CI, and deployed workloads. They need different delivery mechanisms.",
      },
      {
        title: "Choose the system of record",
        description:
          "Select a password manager, cloud secret manager, enterprise vault, or developer secret platform that matches team ownership and infrastructure.",
      },
      {
        title: "Choose a non-copying delivery path",
        description:
          "Use runtime injection, a file mount, browser autofill, or a brokered request instead of returning reusable values to the model.",
      },
      {
        title: "Apply provider-side least privilege",
        description:
          "Create separate credentials with narrow roles, hosts, projects, and environments. Do not rely on local concealment to contain an administrator key.",
      },
      {
        title: "Prove revocation and recovery",
        description:
          "Rotate a test credential, revoke an agent or app grant, and confirm that logs show who used which reference without storing the value.",
      },
    ],
    sections: [
      {
        heading: "Match delivery to the consuming surface",
        paragraphs: [
          "A local application often expects environment variables or a configuration file. A cloud workload may use its platform identity to retrieve a secret. A one-off API task can be safer through a request broker. A browser login benefits from approved autofill or an existing browser session.",
          "Forcing every surface through plaintext retrieval gives the agent and its tools more custody than they need. Prefer the narrowest mechanism the destination supports.",
        ],
      },
      {
        heading: "Understand the bootstrap credential",
        paragraphs: [
          "A secret manager still needs to know who is asking. Local CLIs may use a keychain-backed login, service token, or desktop approval. Cloud workloads can use IAM or workload identity. Self-hosted systems may use machine identities, JWTs, certificates, or initial client secrets.",
          "Protecting provider keys while leaving an organization-wide vault token in a checked-in MCP configuration simply moves the high-value secret. Scope the bootstrap identity and prefer short-lived federation where the platform supports it.",
        ],
      },
      {
        heading: "A useful category map",
        paragraphs: [
          "Use categories to make a shortlist, then verify current product documentation. Features are moving quickly, especially around MCP and agent access.",
        ],
        bullets: [
          "Password manager: human and team credentials, autofill, desktop approval, developer integrations.",
          "Cloud secret manager: cloud-native IAM, application retrieval, replication, and rotation.",
          "Infrastructure vault: dynamic credentials, PKI, policy, leases, and self-managed or enterprise deployment.",
          "Developer secret platform: projects, environments, CI delivery, synchronization, and team workflows.",
          "Provisioning and broker layer: website account creation, credential capture, and constrained use by an agent.",
        ],
      },
    ],
    productFit: [
      "Trusty Squire fits when storage begins too late because the account or key does not exist yet. A coding agent can use its browser tools to sign up, configure the provider, and capture the generated credential into the vault.",
      "For later use, credential tools can refer to the saved record and inject it server-side for provider requests. A deployed app can receive a scoped Trusty Squire grant instead of the provider key. Teams with an established enterprise vault may still keep that system as their broader source of truth.",
    ],
    limits: [
      "Trusty Squire is not a drop-in replacement for every PKI engine, cloud-native rotation workflow, or enterprise password manager feature.",
      "Its provider key must still be scoped and rotated according to the third-party service's controls.",
      "Browser and diagnostic artifacts can contain values that were visibly displayed during setup.",
    ],
    faqs: [
      {
        question: "What is the safest place to store API keys for an AI agent?",
        answer:
          "Use a dedicated secret system outside model context, then expose only the narrow operation the agent needs. The product choice depends on deployment, identity, rotation, browser, and infrastructure requirements.",
      },
      {
        question: "Are .env files safe for coding agents?",
        answer:
          "A local .env file can be practical, but it is persistent plaintext and an agent with file or shell access may read it. Mounted or runtime-injected environments reduce disk exposure, yet the running process can still access the values.",
      },
      {
        question: "Should an MCP server return secret values?",
        answer:
          "Only when the client truly needs plaintext and the risk is accepted. If the goal is an authenticated call or process, prefer a tool that injects or uses the credential without returning it through MCP.",
      },
      {
        question: "Can I use more than one secret system?",
        answer:
          "Yes. A team can use an enterprise or cloud vault as its system of record, a browser tool for website provisioning, and workload identity for production. Define which system owns each credential and avoid uncontrolled copies between them.",
      },
    ],
    related: [
      {
        href: "/compare/best-api-key-storage-ai-agents",
        title: "Compare API key storage options",
        description: "Choose by delivery method, identity, provisioning, and operating model.",
      },
      {
        href: "/guides/mcp-credential-vault",
        title: "Inspect an MCP vault tool contract",
        description: "Check whether the client reads, injects, governs, or provisions secrets.",
      },
      {
        href: "/guides/coding-agent-leaked-api-key-github",
        title: "Respond to a leaked key",
        description: "Revoke first, then audit, replace, clean, and prevent recurrence.",
      },
    ],
    sourceRefs: [
      {
        label: "1Password: Secure AI access",
        url: "https://www.1password.dev/get-started/secure-ai-access",
      },
      {
        label: "HashiCorp: Vault Agent and Proxy capabilities",
        url: "https://developer.hashicorp.com/vault/docs/agent-and-proxy",
      },
      {
        label: "Infisical: Fetching secrets",
        url: "https://infisical.com/docs/documentation/platform/secrets-mgmt/concepts/secrets-delivery",
      },
      {
        label: "Doppler: Secrets access guide",
        url: "https://docs.doppler.com/docs/accessing-secrets",
      },
    ],
  },
};

export const GUIDE_ROUTES = GUIDE_SLUGS.map((slug) => ({
  slug,
  title: GUIDES[slug].title,
  description: GUIDES[slug].description,
}));

export function getGuide(slug: string): GuideContent | undefined {
  return GUIDE_SLUGS.includes(slug as GuideSlug) ? GUIDES[slug as GuideSlug] : undefined;
}
