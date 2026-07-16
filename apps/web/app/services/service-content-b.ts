import { defineServices, type ActiveRegistrySkill, type ServicePageContent } from "./service-types";

type ServiceCopy = Omit<ServicePageContent, "registry">;

function serviceFaqs(input: {
  name: string;
  credential: string;
  unlocks: string;
  workflow: string;
  limits: string;
}): NonNullable<ServicePageContent["faqs"]> {
  return [
    {
      question: `What can I do with the generated ${input.name} credential?`,
      answer: input.unlocks,
    },
    {
      question: `What does the active ${input.name} workflow automate?`,
      answer: input.workflow,
    },
    {
      question: `What should I verify before using ${input.credential} in production?`,
      answer: input.limits,
    },
    {
      question: `Does Trusty Squire reveal the ${input.name} credential to my coding agent?`,
      answer: `No. Trusty Squire stores ${input.credential} in the vault and can inject it into server-side requests through a scoped egress grant. The app holds the revocable grant token, not the provider credential.`,
    },
  ];
}

function vaultSafety(name: string, credential: string): string {
  return `Treat ${credential} as backend-only. Ask Trusty Squire to mint a grant for ${name}, store its base URL and token as SQUIRE_EGRESS_BASE_URL and SQUIRE_EGRESS_TOKEN in server-side configuration, and send provider requests through that base URL. The host-scoped, revocable grant token is still a bearer secret, but the raw provider credential stays vaulted and is injected only at the boundary.`;
}

const CONTENT_B = {
  kinde: {
    name: "Kinde",
    category: "Identity and authentication",
    summary:
      "Create a Kinde business and capture an application credential for server-side identity administration.",
    metaDescription:
      "Ask Trusty Squire to set up Kinde, open the application settings, and vault the generated API credential without copying it into chat.",
    prompt: "Set up Kinde for this app and save the generated API credential in Trusty Squire.",
    publicSignupUrl: "https://app.kinde.com/",
    outcome:
      "A vaulted Kinde credential that can support backend identity and application-management work after you confirm its provider-side permissions.",
    useCases: [
      "Bootstrap authentication infrastructure for a new application.",
      "Automate server-side Kinde application administration.",
      "Keep identity-platform credentials out of source code and local .env files.",
    ],
    vaultSafety: vaultSafety("Kinde", "KINDE_API_KEY"),
    faqs: serviceFaqs({
      name: "Kinde",
      credential: "KINDE_API_KEY",
      unlocks:
        "It gives a backend the Kinde API credential captured from the application details flow. Confirm the token's actual scopes in Kinde before using it for administration.",
      workflow:
        "The registry sequence creates the business and tenant, skips optional onboarding, opens Settings → Applications, and captures the copyable value from an application detail page.",
      limits:
        "The active record validates only an opaque value between 8 and 64 characters; it does not declare scopes or a stable tenant identifier.",
    }),
    related: ["clerk", "supabase", "sentry"],
    dataQuality: [
      "Content eligibility: review. The registry signup URL contains a captured session parameter and later steps contain tenant-specific Kinde hosts, so the route may not be portable to a different session.",
    ],
  },
  lancedb: {
    name: "LanceDB Cloud",
    category: "Vector databases",
    summary:
      "Open LanceDB Cloud organization settings and vault an API key for vector-data workloads.",
    metaDescription:
      "Provision LanceDB Cloud API access with Trusty Squire and keep the generated key vaulted for server-side vector search and data operations.",
    prompt: "Set up LanceDB Cloud access and save its API key in Trusty Squire.",
    publicSignupUrl: "https://cloud.lancedb.com/dashboard",
    outcome:
      "A vaulted LanceDB Cloud API key for authenticated project and vector-data operations supported by the provider account.",
    useCases: [
      "Connect an application to a hosted LanceDB project.",
      "Back retrieval and semantic-search workloads with managed vector storage.",
      "Issue a revocable backend grant instead of distributing the LanceDB key.",
    ],
    vaultSafety: vaultSafety("LanceDB Cloud", "LANCEDB_API_KEY"),
    faqs: serviceFaqs({
      name: "LanceDB Cloud",
      credential: "LANCEDB_API_KEY",
      unlocks:
        "It authenticates the LanceDB Cloud operations available to the account and project associated with the generated key.",
      workflow:
        "The active skill opens the cloud dashboard, navigates through the organization and profile menus, and reaches both project and organization API-key settings before extraction.",
      limits:
        "The registry describes an opaque 8–64 character key but does not record a project, region, database URI, or key scope. Supply those separately from the LanceDB dashboard.",
    }),
    related: ["pinecone", "qdrant", "weaviate", "zilliz"],
  },
  langsmith: {
    name: "LangSmith",
    category: "AI observability and evaluation",
    summary:
      "Sign in to LangSmith and vault an API key for tracing, evaluation, and prompt-application operations.",
    metaDescription:
      "Let Trusty Squire sign in to LangSmith, open settings, and vault the API key used by server-side tracing and evaluation workflows.",
    prompt: "Sign in to LangSmith and save an API key for this project's tracing backend.",
    publicSignupUrl: "https://smith.langchain.com/",
    outcome:
      "A vaulted LangSmith API key that can authenticate supported tracing and evaluation requests from a backend or CI job.",
    useCases: [
      "Send LLM traces from a server application.",
      "Run evaluation jobs without sharing the LangSmith key with the coding agent.",
      "Give CI a revocable grant for LangSmith API calls.",
    ],
    vaultSafety: vaultSafety("LangSmith", "LANGSMITH_API_KEY"),
    faqs: serviceFaqs({
      name: "LangSmith",
      credential: "LANGSMITH_API_KEY",
      unlocks:
        "It can authenticate the LangSmith API operations enabled for the issuing account, commonly tracing and evaluation work.",
      workflow:
        "The registry flow uses Google OAuth, completes LangSmith's experience selection, opens Settings, and extracts an opaque API key.",
      limits:
        "The active record does not include a workspace or project identifier. Configure those separately, and confirm key permissions in LangSmith.",
    }),
    related: ["braintrust", "helicone", "vellum"],
    dataQuality: [
      "Content eligibility: review. The recorded signup URL is myaccount.google.com rather than a LangSmith-owned entry URL, even though the later navigation targets smith.langchain.com.",
    ],
  },
  mailtrap: {
    name: "Mailtrap",
    category: "Email testing and delivery",
    summary:
      "Open Mailtrap settings and vault an API token for email testing or sending workflows.",
    metaDescription:
      "Use Trusty Squire to open Mailtrap's token settings and store the generated API token directly in the vault for backend email work.",
    prompt: "Set up Mailtrap API access for this app and save the token in Trusty Squire.",
    publicSignupUrl: "https://mailtrap.io/home",
    outcome:
      "A vaulted Mailtrap API token for the email-testing or delivery operations authorized by the issuing account.",
    useCases: [
      "Connect automated tests to Mailtrap email sandboxes.",
      "Send transactional mail through a backend with a scoped grant.",
      "Rotate access without placing the Mailtrap token in repository secrets.",
    ],
    vaultSafety: vaultSafety("Mailtrap", "MAILTRAP_API_KEY"),
    faqs: serviceFaqs({
      name: "Mailtrap",
      credential: "MAILTRAP_API_KEY",
      unlocks:
        "It authenticates Mailtrap API calls allowed by the token, which may cover testing, sending, or account operations depending on provider-side configuration.",
      workflow:
        "The active sequence opens Mailtrap Home, handles the consent prompt, visits Settings and the API Tokens page, then extracts the visible token pattern.",
      limits:
        "The registry does not distinguish a sandbox token from a sending token or record inbox/domain IDs. Verify the token scope and add resource IDs separately.",
    }),
    related: ["brevo", "plunk", "svix"],
  },
  meorphis: {
    name: "Meorphis",
    category: "Developer APIs",
    summary:
      "Complete the MOR-hosted Meorphis signup flow and vault the API key exposed after email verification.",
    metaDescription:
      "Trusty Squire can complete the active Meorphis email signup flow and vault its generated API key, with registry identity caveats clearly marked.",
    prompt: "Sign me up for Meorphis and save the generated API key in Trusty Squire.",
    publicSignupUrl: "https://app.mor.org/signup",
    outcome:
      "A vaulted API key from the active app.mor.org flow; verify the product identity and supported API operations before integration.",
    useCases: [
      "Create an account through the registry's verified-email flow.",
      "Keep the resulting opaque API credential in a write-only vault.",
      "Evaluate the service API without publishing its key in project configuration.",
    ],
    vaultSafety: vaultSafety("Meorphis", "MEORPHIS_API_KEY"),
    faqs: serviceFaqs({
      name: "Meorphis",
      credential: "MEORPHIS_API_KEY",
      unlocks:
        "The registry proves extraction of an API key but does not describe the API's resource model, so confirm the available operations in the provider dashboard or API documentation.",
      workflow:
        "The skill fills email and password fields, waits for an email code, confirms the account, continues onboarding, and captures a copyable key.",
      limits:
        "The service slug says meorphis while the entry URL uses app.mor.org. Treat the catalog page as provisional until that identity mapping is confirmed.",
    }),
    related: ["apify", "tavily", "vectorize"],
    dataQuality: [
      "Content eligibility: review. The registry service slug and app.mor.org host do not establish a clear public brand mapping.",
      "The live workflow contained a literal generated password; this public snapshot replaces it with ${GENERATED_PASSWORD} and marks the affected steps redacted.",
    ],
  },
  mistral: {
    name: "Mistral AI",
    category: "AI model APIs",
    summary: "Accept Mistral Console terms and vault an API key for server-side model requests.",
    metaDescription:
      "Set up Mistral AI API access with Trusty Squire and keep the generated key vaulted for backend model inference.",
    prompt: "Set up Mistral AI API access and save the generated key in Trusty Squire.",
    publicSignupUrl: "https://console.mistral.ai/home",
    outcome:
      "A vaulted Mistral API key for the model endpoints and usage enabled on the issuing console account.",
    useCases: [
      "Call Mistral models from a backend service.",
      "Run model evaluations or batch jobs without exposing the provider key.",
      "Give a deployed worker revocable, audited Mistral access.",
    ],
    vaultSafety: vaultSafety("Mistral AI", "MISTRAL_API_KEY"),
    faqs: serviceFaqs({
      name: "Mistral AI",
      credential: "MISTRAL_API_KEY",
      unlocks:
        "It authenticates Mistral API requests allowed by the account, including supported model-inference operations.",
      workflow:
        "The active registry flow opens the Mistral console, accepts the console terms, selects API Keys, and extracts a UUID-shaped credential.",
      limits:
        "Model availability, billing, quotas, and regional restrictions are account-level settings and are not encoded in this active skill.",
    }),
    related: ["openrouter", "groq", "cerebras", "sambanova"],
  },
  mixedbread: {
    name: "Mixedbread",
    category: "Embeddings and semantic search",
    summary:
      "Use Google sign-in, finish Mixedbread onboarding, and vault an API key for embedding and search workloads.",
    metaDescription:
      "Trusty Squire can sign in to Mixedbread, create an API key, and store it in the vault for server-side semantic search workflows.",
    prompt: "Set up Mixedbread for semantic search and save its API key in Trusty Squire.",
    publicSignupUrl: "https://www.mixedbread.com/",
    outcome:
      "A vaulted Mixedbread credential for the API capabilities enabled by the account, without copying the key into chat.",
    useCases: [
      "Generate embeddings for retrieval pipelines.",
      "Build semantic-search and ranking features.",
      "Use a revocable grant from a backend indexing worker.",
    ],
    vaultSafety: vaultSafety("Mixedbread", "MIXEDBREAD_API_KEY"),
    faqs: serviceFaqs({
      name: "Mixedbread",
      credential: "MIXEDBREAD_API_KEY",
      unlocks:
        "It can authenticate the Mixedbread API features enabled for the account, such as embedding or semantic-search operations.",
      workflow:
        "The sequence uses Google login, enters the dashboard, skips optional setup, opens API Keys, creates a key, and captures the copyable value.",
      limits:
        "The registry captured the same visible secret through two named copy paths and does not declare model access or quotas. Treat it as one credential until verified.",
    }),
    related: ["voyage-ai", "nomic", "cohere", "pinecone"],
    dataQuality: [
      "Content eligibility: review. Two registry credential names were derived from visible values and appear to represent duplicate capture paths. Public names are normalized and the secret-like labels are omitted.",
    ],
  },
  modal: {
    name: "Modal",
    category: "Serverless compute",
    summary:
      "Open Modal account settings and vault an API token for serverless jobs and deployment tooling.",
    metaDescription:
      "Use Trusty Squire to reach Modal API Tokens and vault the generated credential for backend serverless compute workflows.",
    prompt: "Set up Modal API access for this project and save the token in Trusty Squire.",
    publicSignupUrl: "https://modal.com/",
    outcome:
      "A vaulted Modal API token for supported serverless application, job, or deployment operations.",
    useCases: [
      "Deploy compute-heavy Python jobs from CI.",
      "Trigger serverless workloads from a backend.",
      "Manage Modal resources without distributing the account token.",
    ],
    vaultSafety: vaultSafety("Modal", "MODAL_API_KEY"),
    faqs: serviceFaqs({
      name: "Modal",
      credential: "MODAL_API_KEY",
      unlocks:
        "It authenticates the Modal operations authorized for the generated token, including supported app and deployment tooling.",
      workflow:
        "The active sequence starts in an existing app, opens Settings, visits API Tokens and Secrets, and extracts the token from the settings flow.",
      limits:
        "The registry does not specify workspace scope, role, or CLI configuration fields. Confirm those in Modal before using the grant from CI.",
    }),
    related: ["runpod", "replicate", "e2b"],
    dataQuality: [
      "Content eligibility: review. The signup URL contains an account-specific application path rather than a general Modal registration route.",
    ],
  },
  neon: {
    name: "Neon",
    category: "Serverless Postgres",
    summary:
      "Open Neon account settings, create a named API key, and store it directly in the Trusty Squire vault.",
    metaDescription:
      "Create and vault a Neon API key with Trusty Squire for server-side project and serverless Postgres administration.",
    prompt: "Create a Neon API key for this project and save it in Trusty Squire.",
    publicSignupUrl: "https://console.neon.tech/",
    outcome:
      "A vaulted Neon management API key; database connection strings and project identifiers remain separate resources.",
    useCases: [
      "Automate Neon project and branch administration.",
      "Run database-environment setup from CI without exposing the management key.",
      "Revoke app access without rotating the underlying Neon credential.",
    ],
    vaultSafety: vaultSafety("Neon", "NEON_API_KEY"),
    faqs: serviceFaqs({
      name: "Neon",
      credential: "NEON_API_KEY",
      unlocks:
        "It authenticates Neon management API operations available to the issuing account; it is not itself a Postgres connection string.",
      workflow:
        "The skill opens the Neon console, goes directly to account API-key settings, creates a named key, and captures it through the copy control.",
      limits:
        "Store database URLs and database-role passwords separately. The active record reports one failed replay, so verify the current console flow before relying on unattended setup.",
    }),
    related: ["supabase", "planetscale", "railway"],
    dataQuality: [
      "The active detail endpoint reports one consecutive replay failure; eligibility should be rechecked if the registry demotes the skill.",
    ],
  },
  nomic: {
    name: "Nomic Atlas",
    category: "Embeddings and data exploration",
    summary:
      "Use Google sign-in, open Nomic Atlas settings, and vault an API key for embedding and dataset workflows.",
    metaDescription:
      "Trusty Squire can sign in to Nomic Atlas, locate API Keys, and vault the credential used for server-side embedding and data-map work.",
    prompt: "Set up Nomic Atlas API access and save the generated key in Trusty Squire.",
    publicSignupUrl: "https://atlas.nomic.ai/",
    outcome: "A vaulted Nomic API key for the account's supported Atlas and embedding operations.",
    useCases: [
      "Create embeddings for a retrieval corpus.",
      "Automate dataset uploads or Atlas project workflows.",
      "Give an indexing backend revocable Nomic access.",
    ],
    vaultSafety: vaultSafety("Nomic Atlas", "NOMIC_API_KEY"),
    faqs: serviceFaqs({
      name: "Nomic Atlas",
      credential: "NOMIC_API_KEY",
      unlocks:
        "It authenticates Nomic operations enabled for the account, including supported Atlas or embedding API calls.",
      workflow:
        "The registry flow begins with a Google integration route, uses Google OAuth, reaches the Atlas dashboard, opens Settings and API Keys, and extracts the key.",
      limits:
        "The skill does not record an Atlas project ID, dataset ID, model, or usage tier; configure those outside the credential flow.",
    }),
    related: ["mixedbread", "voyage-ai", "lancedb"],
    dataQuality: [
      "Content eligibility: review. The recorded signup URL is a Google Drive integration page, not a general Nomic account-registration URL.",
    ],
  },
  "novita-ai": {
    name: "Novita AI",
    category: "AI inference and media",
    summary:
      "Finish Novita AI console onboarding, create a named key, and vault it for backend inference workloads.",
    metaDescription:
      "Set up Novita AI console access with Trusty Squire and keep the generated API key in the vault for server-side inference.",
    prompt: "Set up Novita AI for this backend and save the generated API key in Trusty Squire.",
    publicSignupUrl: "https://novita.ai/console",
    outcome: "A vaulted Novita AI API key for the inference capabilities available on the account.",
    useCases: [
      "Call supported Novita AI inference endpoints from a server.",
      "Run media-generation jobs without shipping a provider key to workers.",
      "Issue and revoke a scoped Trusty Squire grant for a deployment.",
    ],
    vaultSafety: vaultSafety("Novita AI", "NOVITA_AI_API_KEY"),
    faqs: serviceFaqs({
      name: "Novita AI",
      credential: "NOVITA_AI_API_KEY",
      unlocks:
        "It authenticates the Novita AI API features and models enabled for the console account.",
      workflow:
        "The active flow enters the console after authentication, fills the required organization field, skips optional setup, creates a named key, confirms it, and captures the copyable value.",
      limits:
        "The registry does not encode model availability, credits, or rate limits. The entry URL also contains post-authentication query state that may not be reusable.",
    }),
    related: ["replicate", "falai", "runpod"],
    dataQuality: [
      "Content eligibility: review. The signup URL contains captured post-authentication query state rather than a durable entry route.",
    ],
  },
  openrouter: {
    name: "OpenRouter",
    category: "LLM gateways",
    summary:
      "Create an OpenRouter key and vault it for server-side access to the models enabled on the account.",
    metaDescription:
      "Ask Trusty Squire to create an OpenRouter API key and keep the sk-or-v1 credential in the vault for backend model requests.",
    prompt: "Create an OpenRouter API key for this app and save it in Trusty Squire.",
    publicSignupUrl: "https://openrouter.ai/",
    outcome:
      "A vaulted OpenRouter key with the registry-validated sk-or-v1 prefix for model requests made through the account.",
    useCases: [
      "Route backend LLM calls across providers available through OpenRouter.",
      "Evaluate models without distributing a shared gateway key.",
      "Give a deployed agent loop a rate-limited, revocable grant.",
    ],
    vaultSafety: vaultSafety("OpenRouter", "OPENROUTER_API_KEY"),
    faqs: serviceFaqs({
      name: "OpenRouter",
      credential: "OPENROUTER_API_KEY",
      unlocks:
        "It authenticates OpenRouter requests for models, providers, and billing access enabled on the issuing account.",
      workflow:
        "The active skill opens OpenRouter, visits both current API-key settings paths, chooses New Key, supplies a generated name, creates the key, and extracts its sk-or-v1 value.",
      limits:
        "Model availability, provider routing, credits, and per-key limits are not stored in the skill. Configure those in OpenRouter and keep the Trusty Squire grant backend-only.",
    }),
    related: ["mistral", "groq", "deepinfra", "perplexity"],
  },
  perplexity: {
    name: "Perplexity API",
    category: "AI search and answers",
    summary: "Capture a Perplexity API key for server-side search and answer-generation requests.",
    metaDescription:
      "Use Trusty Squire to open Perplexity Console settings and vault an API key for backend search and grounded-answer workflows.",
    prompt: "Set up Perplexity API access for this backend and save the key in Trusty Squire.",
    publicSignupUrl: "https://console.perplexity.ai/",
    outcome:
      "A vaulted Perplexity API key for the API capabilities and models enabled on the console account.",
    useCases: [
      "Add web-aware answer generation to a backend.",
      "Run server-side research workflows with revocable access.",
      "Keep the Perplexity key out of browser bundles and agent context.",
    ],
    vaultSafety: vaultSafety("Perplexity API", "PERPLEXITY_API_KEY"),
    faqs: serviceFaqs({
      name: "Perplexity API",
      credential: "PERPLEXITY_API_KEY",
      unlocks:
        "It authenticates Perplexity API requests available to the console group that issued the credential.",
      workflow:
        "The active registry sequence navigates from the Perplexity console to a group-specific settings page and extracts the credential through a copy button.",
      limits:
        "The skill records no key-creation click, model list, group ID abstraction, or billing state. Confirm that the captured key belongs to the intended group.",
    }),
    related: ["tavily", "openrouter", "deepseek"],
    dataQuality: [
      "Content eligibility: review. The extraction route contains a captured Perplexity group UUID and may not generalize to another account.",
    ],
  },
  pinecone: {
    name: "Pinecone",
    category: "Vector databases",
    summary:
      "Complete Pinecone organization onboarding and vault a service-account API credential for vector workloads.",
    metaDescription:
      "Trusty Squire can complete Pinecone onboarding, reach service-account access settings, and vault the generated API key.",
    prompt: "Set up Pinecone for this app and save the generated API key in Trusty Squire.",
    publicSignupUrl: "https://app.pinecone.io/organizations/registration",
    outcome:
      "A vaulted Pinecone credential for the project and vector-database operations permitted by its service-account access.",
    useCases: [
      "Back semantic search or retrieval-augmented generation with Pinecone indexes.",
      "Run server-side ingestion and query jobs.",
      "Give a deployment revocable access without distributing the Pinecone key.",
    ],
    vaultSafety: vaultSafety("Pinecone", "PINECONE_API_KEY"),
    faqs: serviceFaqs({
      name: "Pinecone",
      credential: "PINECONE_API_KEY",
      unlocks:
        "It authenticates the Pinecone operations permitted for the generated project or service-account credential.",
      workflow:
        "The active flow enters organization registration, selects a personal-project path, skips optional onboarding, opens Settings, Projects, Members, Service Accounts, and Access, then captures the key.",
      limits:
        "Index host, cloud, region, project, and service-account role are not part of this record. The detail endpoint also reports a failed replay, so recheck portability.",
    }),
    related: ["qdrant", "weaviate", "zilliz", "lancedb"],
    dataQuality: [
      "The active detail endpoint reports one consecutive replay failure; eligibility should be rechecked if the registry demotes the skill.",
    ],
  },
  "pinecone-assistant": {
    name: "Pinecone Assistant",
    category: "Managed retrieval assistants",
    summary:
      "Provision Pinecone access intended for Assistant-backed retrieval while keeping the credential vaulted.",
    metaDescription:
      "Set up Pinecone Assistant access with Trusty Squire, capture the service credential, and keep it out of chat and source code.",
    prompt:
      "Set up Pinecone Assistant access for this project and save its API key in Trusty Squire.",
    publicSignupUrl: "https://app.pinecone.io/organizations/registration",
    outcome:
      "A vaulted Pinecone credential that may be used with Assistant features after you verify project and product entitlements.",
    useCases: [
      "Connect a backend to Pinecone Assistant retrieval features.",
      "Run document-grounded question answering without distributing the key.",
      "Revoke application access independently of the provider credential.",
    ],
    vaultSafety: vaultSafety("Pinecone Assistant", "PINECONE_ASSISTANT_API_KEY"),
    faqs: serviceFaqs({
      name: "Pinecone Assistant",
      credential: "PINECONE_ASSISTANT_API_KEY",
      unlocks:
        "The registry captures a Pinecone service-account credential. Assistant access still depends on the selected project and account entitlements.",
      workflow:
        "The sequence mirrors Pinecone organization registration, selects the developer/personal path, skips optional setup, and reaches Service Accounts and Access for extraction.",
      limits:
        "No Assistant creation step, assistant ID, environment, or Assistant-specific permission is recorded. Verify those separately before claiming the credential is product-scoped.",
    }),
    related: ["pinecone", "vectorize", "langsmith"],
    dataQuality: [
      "Content eligibility: review. This active slug shares Pinecone's registration flow and exposes a generic service-account key; the registry does not prove an Assistant-specific credential.",
      "The active detail endpoint reports one consecutive replay failure.",
    ],
  },
  planetscale: {
    name: "PlanetScale",
    category: "Managed databases",
    summary:
      "Create a PlanetScale service token and vault it for server-side database administration.",
    metaDescription:
      "Trusty Squire can open PlanetScale service-token settings, create a token, and vault the UUID credential for backend automation.",
    prompt: "Create a PlanetScale service token for this project and save it in Trusty Squire.",
    publicSignupUrl: "https://app.planetscale.com/new",
    outcome:
      "A vaulted PlanetScale service token for the organization operations permitted by that token's provider-side access.",
    useCases: [
      "Automate PlanetScale organization or database setup.",
      "Run CI database administration with revocable access.",
      "Separate management credentials from application database connections.",
    ],
    vaultSafety: vaultSafety("PlanetScale", "PLANETSCALE_API_KEY"),
    faqs: serviceFaqs({
      name: "PlanetScale",
      credential: "PLANETSCALE_API_KEY",
      unlocks:
        "It is the UUID-shaped service token captured from organization settings, not a database username or connection password.",
      workflow:
        "The skill enters PlanetScale's new-account area, navigates to an organization-specific service-token page, chooses New service token, names it, creates it, and captures the value.",
      limits:
        "The registry does not declare token permissions, organization portability, database name, or connection details. Confirm those in PlanetScale.",
    }),
    related: ["neon", "supabase", "railway"],
    dataQuality: [
      "The extraction route contains a captured organization slug; the signup URL itself is stable but the later settings navigation may need rediscovery.",
    ],
  },
  plunk: {
    name: "Plunk",
    category: "Transactional email",
    summary:
      "Open Plunk settings and vault its API key for transactional-email and subscriber workflows.",
    metaDescription:
      "Set up Plunk API access with Trusty Squire and keep the generated email-platform key in the vault for server-side sends.",
    prompt: "Set up Plunk for this app and save its API key in Trusty Squire.",
    publicSignupUrl: "https://next-app.useplunk.com/",
    outcome:
      "A vaulted Plunk API key for the sending and contact operations enabled on the account.",
    useCases: [
      "Send transactional email from a backend.",
      "Manage contacts or email automation through supported Plunk APIs.",
      "Give a worker revocable access without copying the Plunk key.",
    ],
    vaultSafety: vaultSafety("Plunk", "PLUNK_API_KEY"),
    faqs: serviceFaqs({
      name: "Plunk",
      credential: "PLUNK_API_KEY",
      unlocks:
        "It authenticates Plunk API calls permitted for the issuing account, including supported email and contact operations.",
      workflow:
        "The concise active flow opens the Plunk application, selects Settings, and extracts a long opaque key with a 62–66 character validator.",
      limits:
        "The record does not include a sender domain, project, audience, or sending-status check. Configure and verify those separately.",
    }),
    related: ["mailtrap", "brevo", "svix"],
  },
  porter: {
    name: "Porter",
    category: "Application deployment",
    summary: "Complete Porter onboarding and vault a personal API token for deployment automation.",
    metaDescription:
      "Trusty Squire can complete Porter onboarding, open API-token settings, create a token, and keep it vaulted for CI deployments.",
    prompt: "Set up Porter deployment access and save the generated API token in Trusty Squire.",
    publicSignupUrl: "https://dashboard.porter.run/onboarding",
    outcome:
      "A vaulted Porter API token for the account and deployment operations allowed by the generated token.",
    useCases: [
      "Deploy applications from CI through Porter.",
      "Automate environment and service administration.",
      "Replace a long-lived CI provider secret with a revocable grant.",
    ],
    vaultSafety: vaultSafety("Porter", "PORTER_API_KEY"),
    faqs: serviceFaqs({
      name: "Porter",
      credential: "PORTER_API_KEY",
      unlocks:
        "It authenticates Porter API operations authorized for the account token created by the onboarding flow.",
      workflow:
        "The registry sequence completes role and team-size onboarding, opens Account settings and API tokens, names a token, creates it, and captures the UUID-shaped value.",
      limits:
        "The skill does not include a cluster, project, environment, or token-role selection. Confirm resource scope before deployment automation.",
    }),
    related: ["render", "railway", "qovery", "zeabur"],
  },
  pusher: {
    name: "Pusher",
    category: "Realtime messaging",
    summary:
      "Capture the Pusher application ID, public app key, and secret as one multi-field vaulted credential.",
    metaDescription:
      "Trusty Squire can open Pusher App Keys and vault the application ID, app key, and secret for server-side realtime messaging.",
    prompt: "Set up Pusher credentials for this app and save all app-key fields in Trusty Squire.",
    publicSignupUrl: "https://dashboard.pusher.com/",
    outcome:
      "A three-field vaulted Pusher credential containing the application ID, app key, and secret captured from App Keys.",
    useCases: [
      "Publish realtime events from a trusted backend.",
      "Authenticate supported Pusher server APIs with the full app credential.",
      "Keep the Pusher secret server-side while exposing only client-safe configuration separately.",
    ],
    vaultSafety: vaultSafety("Pusher", "PUSHER_SECRET"),
    faqs: serviceFaqs({
      name: "Pusher",
      credential: "PUSHER_SECRET",
      unlocks:
        "The captured application ID, app key, and secret identify and authenticate a Pusher application for supported server-side messaging operations.",
      workflow:
        "The active skill opens the Pusher dashboard, selects a captured app, enters App Keys, and extracts three labeled fields rather than a single generic token.",
      limits:
        "The app selection is account-specific. Treat the app key and application ID according to Pusher's client guidance, but keep the secret and Trusty Squire grant backend-only.",
    }),
    related: ["svix", "sentry", "supabase"],
    dataQuality: [
      "The recorded click text contains a captured Pusher app name, so replay may need a new app-selection target in another account.",
    ],
  },
  qdrant: {
    name: "Qdrant Cloud",
    category: "Vector databases",
    summary:
      "Open Qdrant Cloud access management and vault a management key for vector infrastructure operations.",
    metaDescription:
      "Use Trusty Squire to reach Qdrant Cloud Management Keys, create access, and store the generated API key in the vault.",
    prompt: "Set up Qdrant Cloud API access and save the generated key in Trusty Squire.",
    publicSignupUrl: "https://cloud.qdrant.io/",
    outcome:
      "A vaulted Qdrant Cloud key for the cloud-management or cluster operations enabled by the generated credential.",
    useCases: [
      "Administer Qdrant Cloud resources from a backend or CI job.",
      "Connect vector ingestion and query services using scoped access.",
      "Revoke workload access without putting the provider key on the machine.",
    ],
    vaultSafety: vaultSafety("Qdrant Cloud", "QDRANT_API_KEY"),
    faqs: serviceFaqs({
      name: "Qdrant Cloud",
      credential: "QDRANT_API_KEY",
      unlocks:
        "The active flow captures a Cloud Management Key. Its exact access is determined by Qdrant's provider-side policy, not by this catalog.",
      workflow:
        "The skill opens Qdrant Cloud, reaches an account-specific clusters page, enters Access Management and Cloud Management Keys, creates a key, and captures it.",
      limits:
        "A cluster URL, collection name, region, and data-plane key are not recorded. Confirm whether the generated key is appropriate for management or database requests.",
    }),
    related: ["pinecone", "weaviate", "zilliz", "lancedb"],
    dataQuality: [
      "A later navigation contains a captured account UUID, although the registry signup URL is the stable Qdrant Cloud root.",
    ],
  },
  qovery: {
    name: "Qovery",
    category: "Application deployment",
    summary:
      "Use Google sign-in, create the Qovery organization, and vault an API key for deployment automation.",
    metaDescription:
      "Trusty Squire can complete Qovery organization setup and vault its generated API key for backend and CI deployment workflows.",
    prompt: "Set up Qovery for this project and save the generated API key in Trusty Squire.",
    publicSignupUrl: "https://console.qovery.com/",
    outcome:
      "A vaulted Qovery API key for the organization and deployment operations enabled on the account.",
    useCases: [
      "Deploy services and environments through Qovery automation.",
      "Run CI administration with a revocable backend grant.",
      "Keep cloud-deployment credentials out of repository secrets.",
    ],
    vaultSafety: vaultSafety("Qovery", "QOVERY_API_KEY"),
    faqs: serviceFaqs({
      name: "Qovery",
      credential: "QOVERY_API_KEY",
      unlocks:
        "It authenticates Qovery API actions allowed for the issuing organization and account.",
      workflow:
        "The registry sequence selects Continue with Google, fills company and organization names, continues onboarding, visits the Qovery console, and opens Settings before extraction.",
      limits:
        "No cloud account, cluster, environment, or project is encoded. The declared OAuth provider is also null despite a Google sign-in step.",
    }),
    related: ["porter", "railway", "render", "zeabur"],
    dataQuality: [
      "Content eligibility: review. The recorded signup URL is myaccount.google.com rather than a Qovery-owned URL, and oauth_provider is null despite Google sign-in steps.",
    ],
  },
  railway: {
    name: "Railway",
    category: "Application deployment",
    summary:
      "Open Railway account tokens and vault an API credential for project and deployment automation.",
    metaDescription:
      "Set up Railway API access with Trusty Squire and keep the account token vaulted for server-side deployment workflows.",
    prompt: "Create Railway API access for this project and save the token in Trusty Squire.",
    publicSignupUrl: "https://railway.com/dashboard",
    outcome:
      "A vaulted Railway token for the account operations available to the extracted credential.",
    useCases: [
      "Automate Railway project and environment management.",
      "Trigger deployments from CI without exposing the Railway token.",
      "Give an operations service revocable Railway access.",
    ],
    vaultSafety: vaultSafety("Railway", "RAILWAY_API_KEY"),
    faqs: serviceFaqs({
      name: "Railway",
      credential: "RAILWAY_API_KEY",
      unlocks:
        "It authenticates Railway account-token operations permitted to the issuing account.",
      workflow:
        "The active registry flow is intentionally short: it opens the Railway dashboard and navigates directly to account token settings for regex extraction.",
      limits:
        "The record does not show token creation, project selection, workspace scope, or expiration. Verify the extracted token and its permissions before automation.",
    }),
    related: ["render", "porter", "fly-io", "zeabur"],
  },
  "redis-cloud": {
    name: "Redis Cloud",
    category: "Managed data services",
    summary:
      "Enable Redis Cloud API access and vault a management key for account and database automation.",
    metaDescription:
      "Use Trusty Squire to enable Redis Cloud API access, open API Keys, and vault the generated credential for backend administration.",
    prompt: "Enable Redis Cloud API access and save the generated key in Trusty Squire.",
    publicSignupUrl: "https://cloud.redis.io/",
    outcome:
      "A vaulted Redis Cloud management API key; database endpoints and data-access passwords remain separate credentials.",
    useCases: [
      "Automate Redis Cloud subscription and database administration.",
      "Run infrastructure setup from CI with revocable management access.",
      "Keep management keys separate from Redis connection secrets.",
    ],
    vaultSafety: vaultSafety("Redis Cloud", "REDIS_CLOUD_API_KEY"),
    faqs: serviceFaqs({
      name: "Redis Cloud",
      credential: "REDIS_CLOUD_API_KEY",
      unlocks:
        "The flow produces a Redis Cloud API key for supported management operations; it is not a Redis database password or connection URL.",
      workflow:
        "The skill opens the databases dashboard, selects Team & API, enables the API, enters API Keys, and captures a UUID-shaped credential.",
      limits:
        "Database host, port, username, password, subscription, and region are not included. Store those separately when your app needs data-plane access.",
    }),
    related: ["upstash", "supabase", "neon"],
  },
  render: {
    name: "Render",
    category: "Application deployment",
    summary:
      "Create a Render API key from account settings and vault it for deployment automation.",
    metaDescription:
      "Trusty Squire can create a Render API key from account settings and store it in the vault for backend deployment workflows.",
    prompt: "Create a Render API key for this deployment and save it in Trusty Squire.",
    publicSignupUrl: "https://dashboard.render.com/",
    outcome:
      "A vaulted Render API key for the services and account operations permitted by the generated credential.",
    useCases: [
      "Trigger or inspect Render deployments from a backend.",
      "Automate service administration from CI.",
      "Revoke workload access independently of the Render key.",
    ],
    vaultSafety: vaultSafety("Render", "RENDER_API_KEY"),
    faqs: serviceFaqs({
      name: "Render",
      credential: "RENDER_API_KEY",
      unlocks: "It authenticates Render API operations available to the issuing account and key.",
      workflow:
        "The active skill opens Render's API-key settings, selects API Keys, chooses Create API Key, supplies a generated name, creates it, and extracts the visible value.",
      limits:
        "The registry does not record owner/team scope, service IDs, or key expiration. Confirm those before granting a deployment access.",
    }),
    related: ["railway", "porter", "fly-io", "zeabur"],
  },
  "render-cron": {
    name: "cron-job.org",
    category: "Scheduled HTTP jobs",
    summary:
      "Create a cron-job.org account and vault the credential captured by the active registry workflow.",
    metaDescription:
      "Trusty Squire can complete the active cron-job.org email signup flow and vault its generated credential, while flagging the mismatched registry slug.",
    prompt: "Sign me up for cron-job.org and save the generated credential in Trusty Squire.",
    publicSignupUrl: "https://console.cron-job.org/signup",
    outcome:
      "A vaulted credential from the cron-job.org account flow; confirm its API purpose before using it for scheduler automation.",
    useCases: [
      "Create an account for managed HTTP schedule execution.",
      "Prepare backend access for cron-job administration after verification.",
      "Keep scheduler credentials out of scripts and deployment configuration.",
    ],
    vaultSafety: vaultSafety("cron-job.org", "RENDER_CRON_API_KEY"),
    faqs: serviceFaqs({
      name: "cron-job.org",
      credential: "RENDER_CRON_API_KEY",
      unlocks:
        "The registry proves extraction of an opaque credential from Settings but does not define its API scope. Verify that it is an API key before integration.",
      workflow:
        "The skill creates an account with email and generated password, follows the sign-in path, opens Settings, and extracts an opaque value.",
      limits:
        "The registry slug says render-cron while every recorded URL points to cron-job.org. Do not present this as a Render product without correcting the registry identity.",
    }),
    related: ["render", "upstash", "svix"],
    dataQuality: [
      "Content eligibility: review. The active slug render-cron conflicts with the cron-job.org signup host and workflow; the public name follows the host while retaining the registry slug.",
      "The live workflow contained a literal generated password; this public snapshot replaces it with ${GENERATED_PASSWORD} and marks the affected steps redacted.",
    ],
  },
  replicate: {
    name: "Replicate",
    category: "AI model inference",
    summary:
      "Finish Replicate onboarding and vault an API token for server-side model predictions.",
    metaDescription:
      "Set up Replicate API access with Trusty Squire and store the generated token in the vault for backend model inference.",
    prompt: "Set up Replicate for this app and save the API token in Trusty Squire.",
    publicSignupUrl: "https://replicate.com/users/onboarding",
    outcome:
      "A vaulted Replicate API token for model prediction operations available on the issuing account.",
    useCases: [
      "Run hosted model predictions from a backend.",
      "Queue media or ML jobs without exposing the Replicate token.",
      "Give a worker revocable access through a Trusty Squire grant.",
    ],
    vaultSafety: vaultSafety("Replicate", "REPLICATE_API_KEY"),
    faqs: serviceFaqs({
      name: "Replicate",
      credential: "REPLICATE_API_KEY",
      unlocks:
        "It authenticates Replicate prediction and account API operations allowed for the issuing user.",
      workflow:
        "The active registry record navigates from Replicate onboarding directly to account API Tokens and extracts a UUID-shaped value.",
      limits:
        "The record does not identify a model, version, hardware, spending limit, or token-creation action. Configure those separately and verify the token is current.",
    }),
    related: ["runpod", "falai", "novita-ai"],
  },
  replit: {
    name: "Replit",
    category: "Cloud development environments",
    summary:
      "Complete the active Replit account flow and vault an API credential for supported workspace automation.",
    metaDescription:
      "Trusty Squire can complete the current Replit onboarding path and vault the extracted API credential for server-side tooling.",
    prompt: "Set up Replit API access for this project and save the credential in Trusty Squire.",
    publicSignupUrl: "https://replit.com/",
    outcome:
      "A vaulted Replit credential for the account capabilities that accept the captured token.",
    useCases: [
      "Automate supported Replit workspace or deployment operations.",
      "Connect server-side tooling without placing the Replit token in source.",
      "Use revocable access while evaluating the API surface.",
    ],
    vaultSafety: vaultSafety("Replit", "REPLIT_API_KEY"),
    faqs: serviceFaqs({
      name: "Replit",
      credential: "REPLIT_API_KEY",
      unlocks:
        "The registry validates a UUID-shaped API credential but does not name the exact Replit API resources it authorizes.",
      workflow:
        "The active sequence opens the Replit home route, clicks Next in the onboarding flow, and extracts the credential from the resulting page state.",
      limits:
        "No token settings URL, creation action, workspace, team, or deployment scope is recorded. Verify the credential type before production use.",
    }),
    related: ["codesandbox", "daytona", "e2b"],
    dataQuality: [
      "Content eligibility: review. The active record has only a generic home route, one onboarding click, and regex extraction, so credential provenance is underspecified.",
    ],
  },
  runpod: {
    name: "Runpod",
    category: "GPU compute and inference",
    summary:
      "Complete Runpod console onboarding and vault an API key for GPU and serverless workload automation.",
    metaDescription:
      "Trusty Squire can navigate Runpod onboarding, create an API key, and store it in the vault for backend GPU workloads.",
    prompt: "Set up Runpod API access for this workload and save the key in Trusty Squire.",
    publicSignupUrl: "https://console.runpod.io/",
    outcome:
      "A vaulted Runpod API key for the compute and account operations enabled by the generated credential.",
    useCases: [
      "Launch or manage GPU workloads from a backend.",
      "Call Runpod serverless inference endpoints through a revocable grant.",
      "Keep compute-account credentials off worker machines.",
    ],
    vaultSafety: vaultSafety("Runpod", "RUNPOD_API_KEY"),
    faqs: serviceFaqs({
      name: "Runpod",
      credential: "RUNPOD_API_KEY",
      unlocks:
        "It authenticates Runpod API operations available to the account, potentially covering compute or serverless resources according to provider-side access.",
      workflow:
        "The 23-step active flow completes console onboarding, explores Settings and Account, expands API-key controls, creates a credential, and captures a UUID-shaped key.",
      limits:
        "The workflow also visits S3 API-key controls, but the credential schema declares only one generic Runpod key. Confirm which key type was ultimately captured.",
    }),
    related: ["modal", "replicate", "hyperbolic", "novita-ai"],
    dataQuality: [
      "The workflow includes both general API-key and S3 API-key affordances while exposing one generic credential, so key purpose should be verified.",
    ],
  },
  sambanova: {
    name: "SambaNova Cloud",
    category: "AI model APIs",
    summary:
      "Use federated sign-in, finish SambaNova Cloud onboarding, and vault the generated model API key.",
    metaDescription:
      "Trusty Squire can complete SambaNova Cloud onboarding, create an API key, and store it safely for server-side model inference.",
    prompt: "Set up SambaNova Cloud API access and save the generated key in Trusty Squire.",
    publicSignupUrl: "https://cloud.sambanova.ai/dashboard",
    outcome:
      "A vaulted SambaNova Cloud credential for the models and inference operations available to the account.",
    useCases: [
      "Call SambaNova-hosted models from a backend.",
      "Run model evaluations without distributing the provider key.",
      "Grant a deployment rate-limited and revocable inference access.",
    ],
    vaultSafety: vaultSafety("SambaNova Cloud", "SAMBANOVA_API_KEY"),
    faqs: serviceFaqs({
      name: "SambaNova Cloud",
      credential: "SAMBANOVA_API_KEY",
      unlocks:
        "It authenticates the model APIs and account capabilities enabled in SambaNova Cloud.",
      workflow:
        "The registry flow offers Google or Microsoft sign-in, completes name and company onboarding, opens APIs, creates and names an API key, saves it, and captures the copyable value.",
      limits:
        "The registry exposed two value-derived credential labels that appear to describe duplicate capture paths. It does not record model access, quota, or billing.",
    }),
    related: ["groq", "cerebras", "mistral", "openrouter"],
    dataQuality: [
      "Content eligibility: review. Two credential names were derived from captured values and likely duplicate the same key. Public names are normalized and the secret-like labels are omitted.",
    ],
  },
  scrapingbee: {
    name: "ScrapingBee",
    category: "Web scraping APIs",
    summary:
      "Complete ScrapingBee registration and vault an API key for server-side page retrieval and scraping jobs.",
    metaDescription:
      "Trusty Squire can register for ScrapingBee, reach the dashboard, and vault its API key for backend scraping workflows.",
    prompt: "Sign me up for ScrapingBee and save the API key in Trusty Squire.",
    publicSignupUrl: "https://dashboard.scrapingbee.com/account/register",
    outcome:
      "A vaulted ScrapingBee API key for the request and scraping capabilities available on the account.",
    useCases: [
      "Fetch JavaScript-rendered pages from a backend.",
      "Run extraction or crawling jobs without shipping the provider key.",
      "Give a worker revocable, audited scraping access.",
    ],
    vaultSafety: vaultSafety("ScrapingBee", "SCRAPINGBEE_API_KEY"),
    faqs: serviceFaqs({
      name: "ScrapingBee",
      credential: "SCRAPINGBEE_API_KEY",
      unlocks:
        "It authenticates ScrapingBee requests supported by the account plan, such as server-side page retrieval and configured scraping options.",
      workflow:
        "The active sequence enters the registration route, follows a Google-login path, returns through login and dashboard URLs, and extracts the API key by pattern.",
      limits:
        "The record does not encode credits, concurrency, premium proxies, target legality, or robots policies. Those remain the caller's responsibility.",
    }),
    related: ["apify", "tavily", "fireworks-ai"],
    dataQuality: [
      "Content eligibility: review. One recorded navigation unexpectedly targets Google Cloud API credentials, and a click label contains captured account text; confirm the route before replay.",
    ],
  },
  sentry: {
    name: "Sentry",
    category: "Error monitoring and observability",
    summary:
      "Open Sentry auth-token settings, create a token, and vault it for server-side issue and release automation.",
    metaDescription:
      "Trusty Squire can create a Sentry auth token and store it in the vault for backend monitoring, release, and issue workflows.",
    prompt: "Create a Sentry API token for this project and save it in Trusty Squire.",
    publicSignupUrl: "https://sentry.io/",
    outcome:
      "A vaulted Sentry token with the registry-validated sntry prefix for the account operations allowed by its selected scopes.",
    useCases: [
      "Upload releases or source-map metadata from CI.",
      "Query and automate issue workflows from a backend.",
      "Keep organization monitoring access out of repository secrets.",
    ],
    vaultSafety: vaultSafety("Sentry", "SENTRY_API_KEY"),
    faqs: serviceFaqs({
      name: "Sentry",
      credential: "SENTRY_API_KEY",
      unlocks:
        "It authenticates Sentry API operations selected when the auth token is created, such as supported organization, project, issue, or release actions.",
      workflow:
        "The active sequence starts inside a captured organization, opens account auth-token settings, chooses Create New Token, names it, selects a scope option, creates it, and captures the token.",
      limits:
        "The organization host and token-settings route are tenant-specific, and the registry does not preserve a human-readable scope list. Verify scopes before use.",
    }),
    related: ["honeycomb", "axiom", "langsmith"],
    dataQuality: [
      "Content eligibility: review. The signup and settings URLs contain a captured Sentry organization subdomain rather than a portable signup entry.",
    ],
  },
  statsig: {
    name: "Statsig",
    category: "Feature flags and experimentation",
    summary:
      "Open Statsig project settings and vault a key for server-side feature-management workflows.",
    metaDescription:
      "Use Trusty Squire to reach Statsig project keys and store the generated credential in the vault for backend flag and experiment access.",
    prompt: "Set up Statsig server access for this project and save the API key in Trusty Squire.",
    publicSignupUrl: "https://console.statsig.com/",
    outcome:
      "A vaulted Statsig key for the project operations supported by the captured credential type.",
    useCases: [
      "Evaluate feature gates from a trusted backend.",
      "Read or manage experimentation configuration through supported APIs.",
      "Keep server secrets separate from client-exposed Statsig keys.",
    ],
    vaultSafety: vaultSafety("Statsig", "STATSIG_API_KEY"),
    faqs: serviceFaqs({
      name: "Statsig",
      credential: "STATSIG_API_KEY",
      unlocks:
        "It authenticates the Statsig operations associated with the captured project key; verify whether it is a server secret, console key, or another key class.",
      workflow:
        "The active flow starts at a project-specific console home, opens Settings, visits that project's key settings route, and extracts an opaque 10–64 character value.",
      limits:
        "Statsig has multiple key classes with different exposure rules. The registry calls this generic API_KEY, so confirm the key type before backend use.",
    }),
    related: ["sentry", "braintrust", "vellum"],
    dataQuality: [
      "Content eligibility: review. The signup URL and extraction route contain a captured Statsig project identifier, and the credential type is generic despite multiple key classes.",
    ],
  },
  supabase: {
    name: "Supabase",
    category: "Backend platforms",
    summary:
      "Create a Supabase organization and vault the captured account or project API credential for backend automation.",
    metaDescription:
      "Trusty Squire can create a Supabase organization, reach account token settings, and vault the extracted credential for server-side work.",
    prompt:
      "Set up Supabase for this app and save the generated backend credential in Trusty Squire.",
    publicSignupUrl: "https://supabase.com/dashboard/new",
    outcome:
      "A vaulted Supabase credential whose exact account-token or project-key role must be verified against the provider dashboard.",
    useCases: [
      "Automate Supabase project administration from CI.",
      "Connect backend tooling while keeping privileged credentials off developer machines.",
      "Separate app database credentials from account-management access.",
    ],
    vaultSafety: vaultSafety("Supabase", "SUPABASE_API_KEY"),
    faqs: serviceFaqs({
      name: "Supabase",
      credential: "SUPABASE_API_KEY",
      unlocks:
        "The workflow visits both account access-token settings and a project API page, so verify whether the extracted value is an account token or project key before choosing its use.",
      workflow:
        "The active skill creates and names an organization, visits account tokens, generates a token, also visits a captured project API settings page, and extracts through a copy button.",
      limits:
        "The registry validator allows only 8–10 characters, which is inconsistent with many Supabase credential formats. Do not rely on the validator to identify the key class.",
    }),
    related: ["neon", "clerk", "upstash"],
    dataQuality: [
      "Content eligibility: review. The workflow mixes account-token and project API routes, includes a captured project reference, and has an unusually short 8–10 character validator.",
    ],
  },
  surrealdb: {
    name: "SurrealDB Cloud",
    category: "Managed databases",
    summary:
      "Open SurrealDB Cloud API-key settings and vault a credential for server-side database administration.",
    metaDescription:
      "Use Trusty Squire to reach SurrealDB Cloud API Keys and store the extracted credential in the vault for backend database work.",
    prompt: "Set up SurrealDB Cloud API access and save the key in Trusty Squire.",
    publicSignupUrl: "https://app.surrealdb.com/",
    outcome:
      "A vaulted SurrealDB Cloud API key for the cloud operations authorized on the issuing account.",
    useCases: [
      "Automate SurrealDB Cloud resource administration.",
      "Connect backend tooling without exposing a cloud management key.",
      "Issue a revocable grant for operational jobs.",
    ],
    vaultSafety: vaultSafety("SurrealDB Cloud", "SURREALDB_API_KEY"),
    faqs: serviceFaqs({
      name: "SurrealDB Cloud",
      credential: "SURREALDB_API_KEY",
      unlocks:
        "It authenticates the SurrealDB Cloud API operations available to the generated key; it is not necessarily a database username/password pair.",
      workflow:
        "The active flow opens the SurrealDB application, navigates through the cloud surface to Settings, visits cloud API-key settings, and extracts an opaque key.",
      limits:
        "Namespace, database, endpoint, authentication level, and key scope are absent from the record. Configure data-plane connectivity separately.",
    }),
    related: ["neon", "planetscale", "redis-cloud"],
  },
  svix: {
    name: "Svix",
    category: "Webhook delivery",
    summary:
      "Open Svix API Access and vault a credential for server-side webhook delivery and application management.",
    metaDescription:
      "Trusty Squire can open Svix API Access and keep the generated key vaulted for backend webhook delivery workflows.",
    prompt: "Set up Svix API access for this app and save the credential in Trusty Squire.",
    publicSignupUrl: "https://dashboard.svix.com/applications",
    outcome:
      "A vaulted Svix API key for the webhook applications and operations enabled on the account.",
    useCases: [
      "Send signed webhooks from a backend.",
      "Manage Svix applications and endpoints through supported APIs.",
      "Give a delivery worker revocable access without distributing the key.",
    ],
    vaultSafety: vaultSafety("Svix", "SVIX_API_KEY"),
    faqs: serviceFaqs({
      name: "Svix",
      credential: "SVIX_API_KEY",
      unlocks:
        "It authenticates Svix API operations permitted for the issuing account, including supported application, endpoint, and message workflows.",
      workflow:
        "The active sequence opens the Svix Applications dashboard, selects API Access, navigates to the resulting application area, and extracts the opaque key.",
      limits:
        "The skill does not record an application ID, endpoint ID, signing secret, or environment. Those resources remain separate from this API credential.",
    }),
    related: ["hookdeck", "pusher", "sentry"],
  },
  tavily: {
    name: "Tavily",
    category: "AI search APIs",
    summary:
      "Create a named Tavily API key and vault it for server-side search and research agents.",
    metaDescription:
      "Trusty Squire can create a Tavily API key and store it in the vault for backend AI search and research workflows.",
    prompt: "Create a Tavily API key for this research agent and save it in Trusty Squire.",
    publicSignupUrl: "https://app.tavily.com/home",
    outcome:
      "A vaulted Tavily API key for the search and research operations available on the account.",
    useCases: [
      "Add web search to a server-side agent.",
      "Build research and retrieval pipelines.",
      "Rate-limit and revoke a deployment's Tavily access independently.",
    ],
    vaultSafety: vaultSafety("Tavily", "TAVILY_API_KEY"),
    faqs: serviceFaqs({
      name: "Tavily",
      credential: "TAVILY_API_KEY",
      unlocks:
        "It authenticates Tavily search and related API operations supported by the account plan.",
      workflow:
        "The active flow opens Tavily Home, chooses the overview key-creation control, names the key, creates it, and extracts the opaque value.",
      limits:
        "Search credits, depth, topic, domain policy, and rate limits are request or account settings, not part of the credential record.",
    }),
    related: ["perplexity", "scrapingbee", "apify"],
  },
  upstash: {
    name: "Upstash",
    category: "Serverless data services",
    summary:
      "Create an Upstash account API key and vault it for server-side resource administration.",
    metaDescription:
      "Use Trusty Squire to open Upstash account API settings, create a key, and keep it vaulted for backend automation.",
    prompt: "Create an Upstash API key for this project and save it in Trusty Squire.",
    publicSignupUrl: "https://console.upstash.com/account/api",
    outcome:
      "A vaulted Upstash account API key for the resource-management operations enabled on the account.",
    useCases: [
      "Automate Upstash resource provisioning from CI.",
      "Manage serverless data services through supported APIs.",
      "Keep account-management access separate from database connection credentials.",
    ],
    vaultSafety: vaultSafety("Upstash", "UPSTASH_API_KEY"),
    faqs: serviceFaqs({
      name: "Upstash",
      credential: "UPSTASH_API_KEY",
      unlocks:
        "It authenticates Upstash account API operations permitted for the generated key; it is not automatically a Redis REST token or database password.",
      workflow:
        "The concise registry flow opens Upstash account API settings, selects Create API key, and extracts the resulting opaque value.",
      limits:
        "Database endpoints, REST tokens, QStash credentials, and resource IDs are separate. Store the specific data-plane values your app needs independently.",
    }),
    related: ["redis-cloud", "supabase", "neon"],
  },
  vectorize: {
    name: "Vectorize",
    category: "Retrieval data pipelines",
    summary:
      "Reach the Vectorize dashboard and vault an API key for server-side retrieval-pipeline operations.",
    metaDescription:
      "Trusty Squire can reach Vectorize and vault the extracted API key for backend RAG ingestion and pipeline automation.",
    prompt:
      "Set up Vectorize API access for this retrieval pipeline and save the key in Trusty Squire.",
    publicSignupUrl: "https://vectorize.io/",
    outcome:
      "A vaulted Vectorize API key for the account capabilities that accept the extracted credential.",
    useCases: [
      "Automate data ingestion for retrieval-augmented applications.",
      "Connect backend indexing jobs to Vectorize pipelines.",
      "Keep pipeline-administration credentials off worker hosts.",
    ],
    vaultSafety: vaultSafety("Vectorize", "VECTORIZE_API_KEY"),
    faqs: serviceFaqs({
      name: "Vectorize",
      credential: "VECTORIZE_API_KEY",
      unlocks:
        "The registry validates an opaque API key but does not enumerate the Vectorize resources or pipeline operations it authorizes.",
      workflow:
        "The active record contains two navigations: it starts at a Google account URL and then reaches the Vectorize dashboard, where regex extraction occurs.",
      limits:
        "There is no OAuth step, key-creation action, pipeline ID, organization, or source/destination configuration. Verify the credential provenance manually.",
    }),
    related: ["pinecone-assistant", "nomic", "lancedb"],
    dataQuality: [
      "Content eligibility: review. The signup URL is myaccount.google.com, oauth_provider is null, and the workflow contains no explicit Vectorize sign-in or key-creation action.",
    ],
  },
  vellum: {
    name: "Vellum",
    category: "LLM application platforms",
    summary:
      "Use Google sign-in, open Vellum API Keys, and vault a credential for production LLM workflows.",
    metaDescription:
      "Trusty Squire can sign in to Vellum, open API Keys, and store the generated credential in the vault for backend LLM applications.",
    prompt: "Set up Vellum API access for this LLM application and save the key in Trusty Squire.",
    publicSignupUrl: "https://app.vellum.ai/",
    outcome:
      "A vaulted Vellum API key for the application, workflow, or evaluation operations available to the account.",
    useCases: [
      "Call deployed Vellum workflows from a backend.",
      "Run prompt or model evaluations through supported APIs.",
      "Give production jobs revocable Vellum access.",
    ],
    vaultSafety: vaultSafety("Vellum", "VELLUM_API_KEY"),
    faqs: serviceFaqs({
      name: "Vellum",
      credential: "VELLUM_API_KEY",
      unlocks:
        "It authenticates Vellum API operations enabled for the issuing workspace and account.",
      workflow:
        "The skill begins at a Google account URL, uses Continue with Google, reaches app.vellum.ai, opens API Keys, and extracts a UUID-shaped credential.",
      limits:
        "Workspace, deployment, workflow, and environment identifiers are not included. Configure those separately from the API key.",
    }),
    related: ["langsmith", "braintrust", "helicone"],
    dataQuality: [
      "Content eligibility: review. The recorded signup URL is myaccount.google.com rather than a Vellum-owned registration route.",
    ],
  },
  vouchflow: {
    name: "VouchFlow",
    category: "Developer APIs",
    summary:
      "Open the VouchFlow dashboard, reveal its API credential, and store it directly in the vault.",
    metaDescription:
      "Use Trusty Squire to open VouchFlow settings and vault the revealed API key, with unclear product scope marked for review.",
    prompt: "Set up VouchFlow API access and save the revealed key in Trusty Squire.",
    publicSignupUrl: "https://vouchflow.dev/",
    outcome:
      "A vaulted VouchFlow API key; confirm the provider's supported resources and intended integration before production use.",
    useCases: [
      "Evaluate authenticated VouchFlow API operations from a backend.",
      "Keep the dashboard credential out of agent context.",
      "Use a revocable grant while product scope is being validated.",
    ],
    vaultSafety: vaultSafety("VouchFlow", "VOUCHFLOW_API_KEY"),
    faqs: serviceFaqs({
      name: "VouchFlow",
      credential: "VOUCHFLOW_API_KEY",
      unlocks:
        "The registry proves a revealable API key exists but does not describe the service resources or operations it authorizes.",
      workflow:
        "The active sequence opens vouchflow.dev/dashboard, selects a captured dashboard item, enters Settings, chooses Reveal, and captures the opaque value.",
      limits:
        "The record contains no signup action, API documentation route, permission model, or stable resource identifier. Treat product claims as provisional.",
    }),
    related: ["svix", "clerk", "sentry"],
    dataQuality: [
      "Content eligibility: review. The registry starts at an authenticated dashboard, includes captured project text, and provides no service-specific API semantics beyond a revealable key.",
    ],
  },
  "voyage-ai": {
    name: "Voyage AI",
    category: "Embeddings and reranking",
    summary:
      "Create a Voyage AI secret key and vault it for server-side embedding and reranking workloads.",
    metaDescription:
      "Trusty Squire can create a Voyage AI secret key and store it in the vault for backend embeddings, retrieval, and reranking.",
    prompt: "Create a Voyage AI key for this retrieval service and save it in Trusty Squire.",
    publicSignupUrl: "https://dashboard.voyageai.com/",
    outcome:
      "A vaulted Voyage AI key for the embedding and reranking operations enabled on the organization project.",
    useCases: [
      "Generate embeddings for a vector-search corpus.",
      "Rerank retrieval results in a backend.",
      "Give an indexing worker revocable Voyage AI access.",
    ],
    vaultSafety: vaultSafety("Voyage AI", "VOYAGE_AI_API_KEY"),
    faqs: serviceFaqs({
      name: "Voyage AI",
      credential: "VOYAGE_AI_API_KEY",
      unlocks:
        "It authenticates Voyage AI model operations available to the selected organization and project.",
      workflow:
        "The active flow opens organization projects, selects API keys, chooses Create new secret key, enters a captured key name, creates the secret, and extracts it by pattern.",
      limits:
        "Model access, project identity, dimensions, quotas, and billing are not encoded. The captured literal key name is not a reusable setting.",
    }),
    related: ["mixedbread", "nomic", "cohere", "pinecone"],
    dataQuality: [
      "The workflow contains a captured test key name; it is non-secret but should be normalized to a generated token name in a future skill revision.",
    ],
  },
  weaviate: {
    name: "Weaviate Cloud",
    category: "Vector databases",
    summary:
      "Open a Weaviate Cloud cluster and vault the API key exposed for authenticated vector operations.",
    metaDescription:
      "Trusty Squire can open Weaviate Cloud, select a cluster, and vault the extracted API key for backend vector-search workloads.",
    prompt: "Set up Weaviate Cloud API access for this app and save the key in Trusty Squire.",
    publicSignupUrl: "https://console.weaviate.cloud/overview",
    outcome:
      "A vaulted Weaviate API key for the cluster operations and data access permitted by the captured credential.",
    useCases: [
      "Index application data into a hosted Weaviate cluster.",
      "Run semantic, hybrid, or retrieval queries from a backend.",
      "Keep cluster credentials off ingestion workers.",
    ],
    vaultSafety: vaultSafety("Weaviate Cloud", "WEAVIATE_API_KEY"),
    faqs: serviceFaqs({
      name: "Weaviate Cloud",
      credential: "WEAVIATE_API_KEY",
      unlocks:
        "It authenticates operations permitted for the selected Weaviate Cloud cluster and user.",
      workflow:
        "The active sequence opens the Weaviate Cloud overview, selects a captured free cluster, and extracts an opaque API key.",
      limits:
        "Cluster URL, cluster ID, collection names, and role are not included. The captured cluster label will not match another account.",
    }),
    related: ["qdrant", "pinecone", "zilliz", "lancedb"],
    dataQuality: [
      "The click target contains a captured cluster name, so another account may require discovery before credential extraction.",
    ],
  },
  zeabur: {
    name: "Zeabur",
    category: "Application deployment",
    summary:
      "Complete Zeabur project onboarding, reveal an account API key, and store it in the vault.",
    metaDescription:
      "Trusty Squire can finish Zeabur onboarding, reveal the account API key, and vault it for backend deployment automation.",
    prompt: "Set up Zeabur deployment access and save the revealed API key in Trusty Squire.",
    publicSignupUrl: "https://zeabur.com/projects",
    outcome:
      "A vaulted Zeabur API key for the account and project operations authorized by that credential.",
    useCases: [
      "Automate Zeabur project and deployment operations.",
      "Connect CI without storing the provider key in repository secrets.",
      "Revoke a deployment's Trusty Squire grant independently.",
    ],
    vaultSafety: vaultSafety("Zeabur", "ZEABUR_API_KEY"),
    faqs: serviceFaqs({
      name: "Zeabur",
      credential: "ZEABUR_API_KEY",
      unlocks:
        "It authenticates Zeabur API operations permitted to the account that revealed the key.",
      workflow:
        "The active flow starts on Projects, accepts terms, completes Next steps, opens account API Keys, chooses Reveal API key, and extracts a UUID-shaped value.",
      limits:
        "No project ID, environment, team, or token scope is recorded. The entry route assumes an authenticated account rather than explicit signup.",
    }),
    related: ["railway", "render", "porter", "zerops"],
  },
  zerops: {
    name: "Zerops",
    category: "Application deployment",
    summary:
      "Open Zerops token management, create a personal token, and vault it for deployment automation.",
    metaDescription:
      "Trusty Squire can create a Zerops personal token and keep it vaulted for backend project and deployment workflows.",
    prompt: "Create a Zerops personal token for this project and save it in Trusty Squire.",
    publicSignupUrl: "https://app.zerops.io/dashboard/projects",
    outcome:
      "A vaulted Zerops personal token for the account operations permitted by the generated credential.",
    useCases: [
      "Automate Zerops project and service administration.",
      "Use Zerops tooling from CI without exposing the personal token.",
      "Give an operations backend revocable access.",
    ],
    vaultSafety: vaultSafety("Zerops", "ZEROPS_API_KEY"),
    faqs: serviceFaqs({
      name: "Zerops",
      credential: "ZEROPS_API_KEY",
      unlocks:
        "It is the UUID-shaped personal token created in Zerops token management and authorizes the account operations allowed by that token.",
      workflow:
        "The active sequence opens the projects dashboard, navigates to token management, chooses Generate Personal Token, names it, creates it, and extracts the value.",
      limits:
        "The record does not include project, service, team, or token-scope data. Personal tokens should remain backend-only and tightly granted.",
    }),
    related: ["zeabur", "render", "railway", "porter"],
  },
  zilliz: {
    name: "Zilliz Cloud",
    category: "Vector databases",
    summary:
      "Complete Zilliz Cloud email signup and vault an API key for managed Milvus vector workloads.",
    metaDescription:
      "Trusty Squire can sign up for Zilliz Cloud, verify email, reach API Keys, and vault the generated credential for backend vector search.",
    prompt: "Sign me up for Zilliz Cloud and save the API key in Trusty Squire.",
    publicSignupUrl: "https://cloud.zilliz.com/signup",
    outcome:
      "A vaulted Zilliz Cloud API key for the managed vector-database operations available on the account.",
    useCases: [
      "Ingest embeddings into managed Milvus collections.",
      "Run semantic or hybrid vector search from a backend.",
      "Give an indexing service revocable Zilliz access.",
    ],
    vaultSafety: vaultSafety("Zilliz Cloud", "ZILLIZ_API_KEY"),
    faqs: serviceFaqs({
      name: "Zilliz Cloud",
      credential: "ZILLIZ_API_KEY",
      unlocks:
        "It authenticates Zilliz Cloud operations permitted to the account and credential, including supported managed vector-database work.",
      workflow:
        "The 15-step flow fills email and generated password, verifies an emailed code, completes name and company onboarding, skips optional setup, opens API Keys, and extracts the credential.",
      limits:
        "Cluster URI, cluster ID, database, collection, cloud, region, and role are separate. Add them from the Zilliz console after account creation.",
    }),
    related: ["weaviate", "qdrant", "pinecone", "lancedb"],
    dataQuality: [
      "The live workflow contained a literal generated password; this public snapshot replaces it with ${GENERATED_PASSWORD} and marks the affected step redacted.",
    ],
  },
} satisfies Record<string, ServiceCopy>;

type RegistryCredential = ActiveRegistrySkill["credentials"][number];
type RegistryStepKind = ActiveRegistrySkill["steps"][number]["kind"];

function apiKey(
  envVar: string,
  shape: string,
  minLength: number,
  maxLength: number,
  name?: string,
  visibility?: string,
): RegistryCredential {
  return {
    ...(name === undefined ? {} : { name }),
    type: "api_key",
    shape_hint: shape,
    env_var_suggestion: envVar,
    ...(visibility === undefined ? {} : { visibility }),
    post_extract_validator: { min_length: minLength, max_length: maxLength },
  };
}

function activeSkill(input: {
  service: string;
  skill_id: string;
  oauth_provider: string | null;
  source_step_count: number;
  steps: readonly (readonly [RegistryStepKind, string])[];
  credentials: readonly RegistryCredential[];
}): ActiveRegistrySkill {
  return {
    service: input.service,
    version: "v1",
    skill_id: input.skill_id,
    status: "active",
    oauth_provider: input.oauth_provider,
    source_step_count: input.source_step_count,
    steps: input.steps.map(([kind, summary]) => ({ kind, summary })),
    credentials: input.credentials,
  };
}

const REGISTRY_B = [
  activeSkill({
    service: "kinde",
    skill_id: "9TEA7W5MB6X4FS500MASJ33AGK",
    oauth_provider: null,
    source_step_count: 13,
    steps: [
      ["navigate", "Open Kinde's account registration experience."],
      ["fill", "Supply a generated business name and tenant-domain choice."],
      ["click", "Complete the required onboarding steps and skip the optional tour."],
      ["navigate", "Open the business administration area."],
      ["click", "Open Settings, then Applications, then an application detail page."],
      [
        "extract_via_copy_button",
        "Capture the copyable application credential directly into the vault.",
      ],
    ],
    credentials: [apiKey("KINDE_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "lancedb",
    skill_id: "YEGH304CZ9VR2HWJ6XP3HM8E31",
    oauth_provider: null,
    source_step_count: 16,
    steps: [
      ["navigate", "Open the LanceDB Cloud dashboard."],
      ["click", "Open the account and organization-management menus."],
      ["navigate", "Reach project and organization API-key settings."],
      ["extract_via_regex", "Capture the displayed API key into the vault."],
    ],
    credentials: [apiKey("LANCEDB_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "langsmith",
    skill_id: "S9T650PXYY2S6C8Y08XSYZYVHD",
    oauth_provider: "google",
    source_step_count: 7,
    steps: [
      ["click_oauth_button", "Continue to LangSmith with the user's existing Google session."],
      ["click", "Complete the required experience-selection step."],
      ["navigate", "Open LangSmith Settings."],
      ["extract_via_regex", "Capture the LangSmith API key into the vault."],
    ],
    credentials: [apiKey("LANGSMITH_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "mailtrap",
    skill_id: "4J39FGZT1KJWAB96BGMTFP974Z",
    oauth_provider: null,
    source_step_count: 5,
    steps: [
      ["navigate", "Open Mailtrap Home."],
      ["click", "Handle the consent choice and open Settings."],
      ["navigate", "Open Mailtrap API Tokens."],
      ["extract_via_regex", "Capture the API token into the vault."],
    ],
    credentials: [apiKey("MAILTRAP_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "meorphis",
    skill_id: "BHAXQDYRT7AP466HGM7SS1VM72",
    oauth_provider: null,
    source_step_count: 9,
    steps: [
      ["navigate", "Open the MOR-hosted signup page recorded for Meorphis."],
      [
        "fill",
        "Supply a generated email alias and generated password; no captured password is retained publicly.",
      ],
      ["click", "Submit the account-registration form."],
      ["await_email_code", "Wait for and apply the email confirmation code."],
      ["click", "Confirm the account and continue to the credential screen."],
      ["extract_via_copy_button", "Capture the generated key into the vault."],
    ],
    credentials: [apiKey("MEORPHIS_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "mistral",
    skill_id: "D60E3F590CP1XYRNQ6DXVVN2C2",
    oauth_provider: null,
    source_step_count: 4,
    steps: [
      ["navigate", "Open the Mistral Console."],
      ["click", "Accept the required console terms and open API Keys."],
      ["extract_via_regex", "Capture the UUID-shaped API key into the vault."],
    ],
    credentials: [apiKey("MISTRAL_API_KEY", "uuid", 32, 80)],
  }),
  activeSkill({
    service: "mixedbread",
    skill_id: "CXZN2YG9KRWG84DQWZDASE1VDB",
    oauth_provider: "google",
    source_step_count: 11,
    steps: [
      ["navigate", "Open Mixedbread's public application entry."],
      ["click_oauth_button", "Log in with the user's existing Google session."],
      ["click", "Enter the dashboard and skip optional onboarding."],
      ["click", "Open API Keys and create a new key."],
      [
        "extract_via_copy_button_named",
        "Capture the key from the available copy controls without retaining value-derived labels.",
      ],
    ],
    credentials: [
      apiKey("MIXEDBREAD_API_KEY", "opaque", 16, 512),
      apiKey("MIXEDBREAD_API_KEY", "opaque", 16, 512),
    ],
  }),
  activeSkill({
    service: "modal",
    skill_id: "A05335VGZ07GSV5CZJXDX301GC",
    oauth_provider: null,
    source_step_count: 6,
    steps: [
      ["navigate", "Open Modal's account application surface."],
      ["click", "Open Settings and API Tokens."],
      ["click", "Visit Secrets and the token-creation controls."],
      ["extract_via_regex", "Capture the API token into the vault."],
    ],
    credentials: [apiKey("MODAL_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "neon",
    skill_id: "3QCCYE45PD93B5NR1G50YNJY60",
    oauth_provider: null,
    source_step_count: 5,
    steps: [
      ["navigate", "Open the Neon Console and account API-key settings."],
      ["click", "Choose to create a new API key."],
      ["fill", "Give the key a generated, non-identifying name."],
      ["click", "Create the key."],
      ["extract_via_copy_button", "Capture the generated key into the vault."],
    ],
    credentials: [apiKey("NEON_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "nomic",
    skill_id: "YKG6DRATCFN3EQF3R7DBJ37W1G",
    oauth_provider: "google",
    source_step_count: 9,
    steps: [
      ["click_oauth_button", "Continue to Nomic with the user's existing Google session."],
      ["click", "Enter the Nomic Atlas dashboard."],
      ["navigate", "Open Atlas settings."],
      ["click", "Open API Keys."],
      ["extract_via_regex", "Capture the Nomic key into the vault."],
    ],
    credentials: [apiKey("NOMIC_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "novita-ai",
    skill_id: "XSK2ZNNRPP67T8CDFNHB3CJT3W",
    oauth_provider: null,
    source_step_count: 7,
    steps: [
      ["navigate", "Open the stable Novita AI console entry."],
      ["fill", "Supply the required generated organization name."],
      ["click", "Skip optional onboarding and choose Add New Key."],
      ["fill", "Give the key a generated name."],
      ["click", "Confirm key creation."],
      ["extract_via_copy_button", "Capture the new API key into the vault."],
    ],
    credentials: [apiKey("NOVITA_AI_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "openrouter",
    skill_id: "NQXN5EQP8XND7M24HR0KX5YHN7",
    oauth_provider: null,
    source_step_count: 7,
    steps: [
      ["navigate", "Open OpenRouter and its API-key settings."],
      ["click", "Choose New Key."],
      ["fill", "Assign a generated key name."],
      ["click", "Create the key."],
      ["extract_via_regex", "Capture the sk-or-v1 credential into the vault."],
    ],
    credentials: [apiKey("OPENROUTER_API_KEY", "prefix:sk-or-v1-", 30, 120)],
  }),
  activeSkill({
    service: "perplexity",
    skill_id: "GJABGZ65EEXX9FP6RQ4X1DRQ1B",
    oauth_provider: null,
    source_step_count: 2,
    steps: [
      ["navigate", "Open Perplexity Console and the current account's settings."],
      ["extract_via_copy_button", "Capture the visible API key into the vault."],
    ],
    credentials: [apiKey("PERPLEXITY_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "pinecone",
    skill_id: "QAB3WX6W8D8WBX9B43V0H7VCKK",
    oauth_provider: null,
    source_step_count: 12,
    steps: [
      ["navigate", "Open Pinecone organization registration."],
      ["click", "Choose the personal-project path and skip optional onboarding."],
      ["click", "Open Settings, Projects, Members, and Service Accounts."],
      ["click", "Open Access for the selected service account."],
      ["extract_via_copy_button", "Capture the UUID-shaped key into the vault."],
    ],
    credentials: [apiKey("PINECONE_API_KEY", "uuid", 32, 80)],
  }),
  activeSkill({
    service: "pinecone-assistant",
    skill_id: "M093YNVAYC8CYAJ3ANGVMM7C2K",
    oauth_provider: null,
    source_step_count: 14,
    steps: [
      ["navigate", "Open Pinecone organization registration."],
      ["click", "Choose the developer and personal-project onboarding path."],
      ["click", "Skip optional setup and open project Service Accounts."],
      ["click", "Open Access for the selected service account."],
      ["extract_via_copy_button", "Capture the UUID-shaped Pinecone credential into the vault."],
    ],
    credentials: [apiKey("PINECONE_ASSISTANT_API_KEY", "uuid", 32, 80)],
  }),
  activeSkill({
    service: "planetscale",
    skill_id: "08GF9SZEM0TY9QMQZZJJ0FBNXR",
    oauth_provider: null,
    source_step_count: 5,
    steps: [
      ["navigate", "Open PlanetScale and the current organization's service-token settings."],
      ["click", "Choose New service token."],
      ["fill", "Give the token a generated name."],
      ["click", "Create the service token."],
      ["extract_via_copy_button", "Capture the UUID-shaped token into the vault."],
    ],
    credentials: [apiKey("PLANETSCALE_API_KEY", "uuid", 36, 36)],
  }),
  activeSkill({
    service: "plunk",
    skill_id: "MSGMVBYNH7DFMBA535J1XGBB7Q",
    oauth_provider: null,
    source_step_count: 3,
    steps: [
      ["navigate", "Open the Plunk application."],
      ["click", "Open Settings."],
      ["extract_via_copy_button", "Capture the long opaque API key into the vault."],
    ],
    credentials: [apiKey("PLUNK_API_KEY", "opaque", 62, 66)],
  }),
  activeSkill({
    service: "porter",
    skill_id: "C1JQ97BW22E00GFBY2SGV62H03",
    oauth_provider: null,
    source_step_count: 12,
    steps: [
      ["navigate", "Open Porter onboarding."],
      ["select", "Choose the required role, team-size, and onboarding options."],
      ["click", "Complete onboarding and open Account settings."],
      ["navigate", "Open API-token settings."],
      ["click", "Choose Create API token."],
      ["fill", "Assign a generated token name."],
      ["click", "Create the token."],
      ["extract_via_copy_button", "Capture the UUID-shaped token into the vault."],
    ],
    credentials: [apiKey("PORTER_API_KEY", "uuid", 36, 36)],
  }),
  activeSkill({
    service: "pusher",
    skill_id: "DRAPN0GR0VZRV13VX2D57FTJVQ",
    oauth_provider: null,
    source_step_count: 6,
    steps: [
      ["navigate", "Open the Pusher dashboard."],
      ["click", "Select the intended Pusher application without retaining its captured name."],
      ["click", "Open App Keys."],
      [
        "extract_labeled",
        "Capture application_id, app_key, and secret as one multi-field vault entry.",
      ],
    ],
    credentials: [
      apiKey("PUSHER_APPLICATION_ID", "opaque", 4, 512, "application_id"),
      apiKey("PUSHER_APP_KEY", "opaque", 16, 512, "app_key"),
      apiKey("PUSHER_SECRET", "opaque", 16, 512, "secret"),
    ],
  }),
  activeSkill({
    service: "qdrant",
    skill_id: "C60SXMFK8E0WPXZ33BDSCJAPRC",
    oauth_provider: null,
    source_step_count: 5,
    steps: [
      ["navigate", "Open Qdrant Cloud and the current account's cluster area."],
      ["click", "Open Access Management."],
      ["click", "Open Cloud Management Keys and choose Create."],
      ["extract_via_copy_button", "Capture the management key into the vault."],
    ],
    credentials: [apiKey("QDRANT_API_KEY", "opaque", 8, 64, undefined, "show_once_at_creation")],
  }),
  activeSkill({
    service: "qovery",
    skill_id: "EV57XZA0HC9S5GY58TQA7TX2WV",
    oauth_provider: null,
    source_step_count: 9,
    steps: [
      ["click", "Choose Continue with Google for Qovery."],
      ["fill", "Supply generated company and organization names."],
      ["click", "Complete the required onboarding steps."],
      ["navigate", "Open the Qovery console."],
      ["click", "Open Settings."],
      ["extract_via_regex", "Capture the UUID-shaped API credential into the vault."],
    ],
    credentials: [apiKey("QOVERY_API_KEY", "uuid", 32, 80)],
  }),
  activeSkill({
    service: "railway",
    skill_id: "DNRE802B26Q673MCGBVC26ZW04",
    oauth_provider: null,
    source_step_count: 2,
    steps: [
      ["navigate", "Open Railway and account token settings."],
      ["extract_via_regex", "Capture the account token into the vault."],
    ],
    credentials: [apiKey("RAILWAY_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "redis-cloud",
    skill_id: "0109E1WMH0NDF8TV1K0TXN2GD1",
    oauth_provider: null,
    source_step_count: 5,
    steps: [
      ["navigate", "Open Redis Cloud."],
      ["click", "Open Team & API."],
      ["click", "Enable API access and open API Keys."],
      ["extract_via_copy_button", "Capture the UUID-shaped management key into the vault."],
    ],
    credentials: [apiKey("REDIS_CLOUD_API_KEY", "uuid", 32, 80)],
  }),
  activeSkill({
    service: "render",
    skill_id: "001KTN2FQ511CE2AV31YZ4R3C8",
    oauth_provider: null,
    source_step_count: 6,
    steps: [
      ["navigate", "Open Render account API-key settings."],
      ["click", "Choose API Keys and Create API Key."],
      ["fill", "Give the key a generated name."],
      ["click", "Create the key."],
      ["extract_via_regex", "Capture the Render key into the vault."],
    ],
    credentials: [apiKey("RENDER_API_KEY", "opaque", 20, 80)],
  }),
  activeSkill({
    service: "render-cron",
    skill_id: "TWTJP0SD9QR5T95NY5NNDQP8BF",
    oauth_provider: null,
    source_step_count: 8,
    steps: [
      ["navigate", "Open the cron-job.org signup page represented by this registry slug."],
      ["click", "Choose account creation."],
      [
        "fill",
        "Supply a generated email and generated password; no captured password is retained publicly.",
      ],
      ["click", "Submit the account form and continue to sign-in."],
      ["click", "Open Settings."],
      ["extract_via_regex", "Capture the opaque credential into the vault."],
    ],
    credentials: [apiKey("RENDER_CRON_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "replicate",
    skill_id: "TH4XEP115WJEQ819K19P5GJN11",
    oauth_provider: null,
    source_step_count: 2,
    steps: [
      ["navigate", "Open Replicate onboarding and account API Tokens."],
      ["extract_via_regex", "Capture the UUID-shaped API token into the vault."],
    ],
    credentials: [apiKey("REPLICATE_API_KEY", "uuid", 36, 36)],
  }),
  activeSkill({
    service: "replit",
    skill_id: "F1HZ1K3K1GKGBYE58WWDR7R5HN",
    oauth_provider: null,
    source_step_count: 3,
    steps: [
      ["navigate", "Open Replit's account home."],
      ["click", "Continue the required onboarding step."],
      ["extract_via_regex", "Capture the UUID-shaped credential into the vault."],
    ],
    credentials: [apiKey("REPLIT_API_KEY", "uuid", 32, 80)],
  }),
  activeSkill({
    service: "runpod",
    skill_id: "6P7XHA67RKGAQ384KC388QFE1G",
    oauth_provider: null,
    source_step_count: 23,
    steps: [
      ["navigate", "Open the Runpod Console."],
      ["click", "Complete or skip the required onboarding prompts."],
      ["click", "Open Account and Settings."],
      ["click", "Expand the API-key controls and choose to create a key."],
      ["click", "Confirm credential creation and close transient dialogs."],
      ["extract_via_regex", "Capture the UUID-shaped key into the vault."],
    ],
    credentials: [apiKey("RUNPOD_API_KEY", "uuid", 32, 80, undefined, "show_once_at_creation")],
  }),
  activeSkill({
    service: "sambanova",
    skill_id: "NF8BM84N3D2V9FKN20WH5JH6R7",
    oauth_provider: "google",
    source_step_count: 17,
    steps: [
      ["navigate", "Open SambaNova Cloud."],
      ["click_oauth_button", "Continue with the user's existing Google session."],
      ["fill", "Supply generated name and company details."],
      ["click", "Complete account onboarding and open the APIs area."],
      ["click", "Choose Create API Key."],
      ["fill", "Give the key a generated name."],
      ["click", "Save the key."],
      ["extract_via_copy_button_named", "Capture the key without retaining value-derived labels."],
    ],
    credentials: [
      apiKey("SAMBANOVA_API_KEY", "opaque", 16, 512),
      apiKey("SAMBANOVA_API_KEY", "opaque", 16, 512),
    ],
  }),
  activeSkill({
    service: "scrapingbee",
    skill_id: "27QQRB80DBBXDGV7VJFY5WWKW4",
    oauth_provider: null,
    source_step_count: 10,
    steps: [
      ["navigate", "Open ScrapingBee registration."],
      ["fill", "Supply a generated work email."],
      ["click", "Use the available Google sign-in path without retaining captured account labels."],
      ["navigate", "Return through the ScrapingBee login and dashboard flow."],
      ["extract_via_regex", "Capture the API key into the vault."],
    ],
    credentials: [apiKey("SCRAPINGBEE_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "sentry",
    skill_id: "KB811DEPPNNZZ8YZDXT4MEAW08",
    oauth_provider: null,
    source_step_count: 12,
    steps: [
      [
        "navigate",
        "Open the current Sentry organization and account auth-token settings without retaining its tenant host.",
      ],
      ["click", "Choose Create New Token."],
      ["fill", "Give the token a generated name."],
      ["select", "Choose the required provider-side token option."],
      ["click", "Create the token."],
      ["extract_via_copy_button", "Capture the sntry-prefixed credential into the vault."],
    ],
    credentials: [
      apiKey("SENTRY_API_KEY", "prefix:sntry", 30, 200, undefined, "show_once_at_creation"),
    ],
  }),
  activeSkill({
    service: "statsig",
    skill_id: "G0DM9PMVKN1Q5VV9DMV5JHQFCM",
    oauth_provider: null,
    source_step_count: 4,
    steps: [
      ["navigate", "Open Statsig Console without retaining a captured project identifier."],
      ["click", "Open Settings."],
      ["navigate", "Open the current project's key settings."],
      ["extract_via_regex", "Capture the opaque key into the vault."],
    ],
    credentials: [apiKey("STATSIG_API_KEY", "opaque", 10, 64)],
  }),
  activeSkill({
    service: "supabase",
    skill_id: "N6XEQQETKJQVR9BQ3DNSDNNPTB",
    oauth_provider: null,
    source_step_count: 9,
    steps: [
      ["navigate", "Open Supabase's new-project dashboard."],
      ["click", "Choose Create organization."],
      ["fill", "Supply generated organization and credential names."],
      ["navigate", "Open account token settings without retaining a project reference."],
      ["click", "Generate a new token."],
      ["extract_via_copy_button", "Capture the credential into the vault."],
    ],
    credentials: [apiKey("SUPABASE_API_KEY", "opaque", 8, 10)],
  }),
  activeSkill({
    service: "surrealdb",
    skill_id: "2E5GAH3F9KPDMQJZY3ZKDQ8NQ8",
    oauth_provider: null,
    source_step_count: 4,
    steps: [
      ["navigate", "Open SurrealDB Cloud."],
      ["click", "Open Settings."],
      ["navigate", "Open cloud API-key settings."],
      ["extract_via_regex", "Capture the opaque API key into the vault."],
    ],
    credentials: [apiKey("SURREALDB_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "svix",
    skill_id: "QQWWFYZ08F1S5217GA3WNDJVAY",
    oauth_provider: null,
    source_step_count: 3,
    steps: [
      ["navigate", "Open the Svix Applications dashboard."],
      ["click", "Open API Access."],
      ["extract_via_regex", "Capture the opaque API credential into the vault."],
    ],
    credentials: [apiKey("SVIX_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "tavily",
    skill_id: "R42Q3FY7K2R6SAWWK0AWGR2AWF",
    oauth_provider: null,
    source_step_count: 5,
    steps: [
      ["navigate", "Open Tavily Home."],
      ["click", "Choose the API-key creation control."],
      ["fill", "Give the key a generated name."],
      ["click", "Create the key."],
      ["extract_via_regex", "Capture the opaque Tavily key into the vault."],
    ],
    credentials: [apiKey("TAVILY_API_KEY", "opaque", 8, 64, undefined, "show_once_at_creation")],
  }),
  activeSkill({
    service: "upstash",
    skill_id: "FHZ1DNVE0V49WPXG5EGMMS8YWK",
    oauth_provider: null,
    source_step_count: 3,
    steps: [
      ["navigate", "Open Upstash account API settings."],
      ["click", "Choose Create API key."],
      ["extract_via_regex", "Capture the opaque account API key into the vault."],
    ],
    credentials: [apiKey("UPSTASH_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "vectorize",
    skill_id: "ZVEBZ2RTKYX79TJWN9DZ8NQTFA",
    oauth_provider: null,
    source_step_count: 2,
    steps: [
      ["navigate", "Continue from the recorded identity entry to the Vectorize dashboard."],
      ["extract_via_regex", "Capture the opaque Vectorize key into the vault."],
    ],
    credentials: [apiKey("VECTORIZE_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "vellum",
    skill_id: "ZVFP5X4FK9GXZ597Q8EN1D6DF1",
    oauth_provider: "google",
    source_step_count: 5,
    steps: [
      ["click_oauth_button", "Continue to Vellum with the user's existing Google session."],
      ["navigate", "Open the Vellum application."],
      ["navigate", "Open Vellum API Keys."],
      ["extract_via_regex", "Capture the UUID-shaped credential into the vault."],
    ],
    credentials: [apiKey("VELLUM_API_KEY", "uuid", 32, 80)],
  }),
  activeSkill({
    service: "vouchflow",
    skill_id: "XNKKYMG910Q2V86D8MT8204GKZ",
    oauth_provider: null,
    source_step_count: 5,
    steps: [
      ["navigate", "Open the VouchFlow dashboard."],
      ["click", "Select the intended dashboard resource without retaining its captured label."],
      ["click", "Open Settings."],
      ["click", "Reveal the credential."],
      ["extract_via_copy_button", "Capture the revealed key directly into the vault."],
    ],
    credentials: [apiKey("VOUCHFLOW_API_KEY", "opaque", 8, 64, undefined, "show_once_at_creation")],
  }),
  activeSkill({
    service: "voyage-ai",
    skill_id: "JH03HXERJ0N7YFASDBD2QG7P02",
    oauth_provider: null,
    source_step_count: 6,
    steps: [
      ["navigate", "Open Voyage AI organization projects."],
      ["click", "Open API keys and choose Create new secret key."],
      ["fill", "Give the key a generated, non-identifying name."],
      ["click", "Create the secret key."],
      ["extract_via_regex", "Capture the opaque credential into the vault."],
    ],
    credentials: [apiKey("VOYAGE_AI_API_KEY", "opaque", 8, 64, undefined, "show_once_at_creation")],
  }),
  activeSkill({
    service: "weaviate",
    skill_id: "83ZAMGFF45Z68SCZPBXEA5CZCG",
    oauth_provider: null,
    source_step_count: 3,
    steps: [
      ["navigate", "Open the Weaviate Cloud overview."],
      ["click", "Select the intended cluster without retaining its captured name."],
      ["extract_via_regex", "Capture the opaque cluster API key into the vault."],
    ],
    credentials: [apiKey("WEAVIATE_API_KEY", "opaque", 8, 64)],
  }),
  activeSkill({
    service: "zeabur",
    skill_id: "ESCT3W2B2QX9KDDX4VNRHRWCH9",
    oauth_provider: null,
    source_step_count: 6,
    steps: [
      ["navigate", "Open Zeabur Projects."],
      ["click", "Accept the required terms and complete the next onboarding step."],
      ["navigate", "Open account API Keys."],
      ["click", "Reveal the API key."],
      ["extract_via_regex", "Capture the UUID-shaped key into the vault."],
    ],
    credentials: [apiKey("ZEABUR_API_KEY", "uuid", 32, 80)],
  }),
  activeSkill({
    service: "zerops",
    skill_id: "AS35QVPP402TECNF16FEEBSATQ",
    oauth_provider: null,
    source_step_count: 5,
    steps: [
      ["navigate", "Open Zerops Projects and token management."],
      ["click", "Choose Generate Personal Token."],
      ["fill", "Give the token a generated name."],
      ["click", "Create the token."],
      ["extract_via_regex", "Capture the UUID-shaped personal token into the vault."],
    ],
    credentials: [apiKey("ZEROPS_API_KEY", "uuid", 32, 80, undefined, "show_once_at_creation")],
  }),
  activeSkill({
    service: "zilliz",
    skill_id: "NVXEDM7XHH9P1MBS6X8MC6NT69",
    oauth_provider: null,
    source_step_count: 15,
    steps: [
      ["navigate", "Open Zilliz Cloud signup."],
      [
        "fill",
        "Supply a generated work email and generated password; no captured password is retained publicly.",
      ],
      ["click", "Submit signup."],
      ["await_email_code", "Wait for and apply the email verification code."],
      ["fill", "Supply generated name and company details."],
      ["click", "Complete verification and skip optional onboarding."],
      ["click", "Open API Keys."],
      ["extract_via_regex", "Capture the opaque Zilliz credential into the vault."],
    ],
    credentials: [apiKey("ZILLIZ_API_KEY", "opaque", 10, 64)],
  }),
];

export const SERVICE_CONTENT_B = defineServices(
  REGISTRY_B.map((registry): ServicePageContent => {
    const content = (CONTENT_B as Readonly<Record<string, ServiceCopy>>)[registry.service];
    if (content === undefined) {
      throw new Error(`Missing public service content for ${registry.service}`);
    }
    return { registry, ...content };
  }),
);
