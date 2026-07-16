import type { ServicePageContent } from "./service-types";
import { defineServices } from "./service-types";

const REGISTRY_A = [
  {
    service: "activeloop",
    version: "v1",
    skill_id: "TKGFDXBQG5JXJ0175GRCFYCVS3",
    status: "active",
    oauth_provider: null,
    source_step_count: 2,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Activeloop account console.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "ACTIVELOOP_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "ai21",
    version: "v1",
    skill_id: "VEV2W84FXB8NKEKJQBRGH2FGQB",
    status: "active",
    oauth_provider: "google",
    source_step_count: 15,
    steps: [
      {
        kind: "navigate",
        summary: "Open the AI21 account console.",
      },
      {
        kind: "click",
        summary: "Continue through the account flow.",
      },
      {
        kind: "click",
        summary: "Continue through the account flow.",
      },
      {
        kind: "fill",
        summary: "Complete the requested onboarding field.",
      },
      {
        kind: "click",
        summary: "Continue through the account flow.",
      },
      {
        kind: "fill",
        summary: "Complete the requested onboarding field.",
      },
      {
        kind: "click",
        summary: "Continue through the account flow.",
      },
      {
        kind: "click_oauth_button",
        summary: "Choose google sign-in.",
      },
      {
        kind: "click",
        summary: "Continue through the account flow.",
      },
      {
        kind: "click",
        summary: "Open account settings.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "click",
        summary: "Create a new API credential.",
      },
      {
        kind: "click",
        summary: "Create a new API credential.",
      },
      {
        kind: "extract_via_copy_button_named",
        summary: "Capture the validated credential directly into the vault.",
      },
      {
        kind: "extract_via_copy_button_named",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        name: "save_your_key",
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "AI21_SAVE_YOUR_KEY",
        post_extract_validator: {
          min_length: 16,
          max_length: 512,
        },
      },
      {
        name: "copy",
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "AI21_COPY",
        post_extract_validator: {
          min_length: 16,
          max_length: 512,
        },
      },
    ],
  },
  {
    service: "algolia",
    version: "v1",
    skill_id: "TY7E89A4SK25Y07SH7P402RCCT",
    status: "active",
    oauth_provider: null,
    source_step_count: 2,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Algolia account console.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "ALGOLIA_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "anthropic-api",
    version: "v1",
    skill_id: "XKFDB1KS7D7N997126JQXN9EPH",
    status: "active",
    oauth_provider: null,
    source_step_count: 7,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Anthropic API account console.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "navigate",
        summary: "Open the Anthropic API account console.",
      },
      {
        kind: "click",
        summary: "Create a new API credential.",
      },
      {
        kind: "fill",
        summary: "Name the new API credential.",
      },
      {
        kind: "click",
        summary: "Continue through the recorded account flow.",
      },
      {
        kind: "extract_via_copy_button",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "prefix:sk-ant-",
        env_var_suggestion: "ANTHROPIC_API_API_KEY",
        post_extract_validator: {
          min_length: 60,
          max_length: 200,
        },
      },
    ],
  },
  {
    service: "apify",
    version: "v1",
    skill_id: "KNDHF9CX9XV18K42D36QWQNGCP",
    status: "active",
    oauth_provider: null,
    source_step_count: 3,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Apify account console.",
      },
      {
        kind: "click",
        summary: "Open account settings.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "APIFY_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "assemblyai",
    version: "v1",
    skill_id: "H84QBYS69WZCMG9MMW48HA92EX",
    status: "active",
    oauth_provider: null,
    source_step_count: 7,
    steps: [
      {
        kind: "navigate",
        summary: "Open the AssemblyAI account console.",
      },
      {
        kind: "click",
        summary: "Continue through the account flow.",
      },
      {
        kind: "click",
        summary: "Open account settings.",
      },
      {
        kind: "navigate",
        summary: "Open the AssemblyAI account console.",
      },
      {
        kind: "click",
        summary: "Continue through the recorded account flow.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "uuid",
        env_var_suggestion: "ASSEMBLYAI_API_KEY",
        post_extract_validator: {
          min_length: 32,
          max_length: 80,
        },
      },
    ],
  },
  {
    service: "axiom",
    version: "v1",
    skill_id: "RYVRAK4PH0YDASB05E7T5WBBH0",
    status: "active",
    oauth_provider: null,
    source_step_count: 4,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Axiom account console.",
      },
      {
        kind: "click",
        summary: "Dismiss the current overlay or notice.",
      },
      {
        kind: "click",
        summary: "Open account settings.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "AXIOM_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "baseten",
    version: "v1",
    skill_id: "P7GBEG46TGEZZSVMR57X15WQTE",
    status: "active",
    oauth_provider: null,
    source_step_count: 5,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Baseten account console.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "fill",
        summary: "Complete the requested onboarding field.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "extract_via_copy_button",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "BASETEN_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "braintrust",
    version: "v1",
    skill_id: "Y5RKNS7A7SC5JWEFET5TCDCW4C",
    status: "active",
    oauth_provider: "google",
    source_step_count: 4,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Braintrust account console.",
      },
      {
        kind: "click_oauth_button",
        summary: "Choose google sign-in.",
      },
      {
        kind: "click",
        summary: "Continue through the account flow.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "BRAINTRUST_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "brevo",
    version: "v1",
    skill_id: "R3X0KGEZ2XAWKJD69SH8QTG3AN",
    status: "active",
    oauth_provider: null,
    source_step_count: 4,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Brevo account console.",
      },
      {
        kind: "click",
        summary: "Open account settings.",
      },
      {
        kind: "click",
        summary: "Continue through the recorded account flow.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "BREVO_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "cartesia",
    version: "v1",
    skill_id: "B5D4ZRGBRVR4BHZ36663NWWJDY",
    status: "active",
    oauth_provider: null,
    source_step_count: 10,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Cartesia account console.",
      },
      {
        kind: "fill",
        summary: "Enter the generated signup email alias.",
      },
      {
        kind: "fill",
        summary: "Enter a generated password through the sealed browser session.",
      },
      {
        kind: "click",
        summary: "Continue through the account flow.",
      },
      {
        kind: "await_email_code",
        summary:
          "Receive and enter the email verification code through the sealed verification flow.",
      },
      {
        kind: "click",
        summary: "Continue through the recorded account flow.",
      },
      {
        kind: "navigate",
        summary: "Open the Cartesia account console.",
      },
      {
        kind: "click",
        summary: "Reveal the newly generated credential for sealed capture.",
      },
      {
        kind: "extract_via_copy_button_named",
        summary: "Capture the validated credential directly into the vault.",
      },
      {
        kind: "extract_via_copy_button_named",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        name: "primary_key",
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "CARTESIA_API_KEY",
        post_extract_validator: {
          min_length: 16,
          max_length: 512,
        },
      },
      {
        name: "secondary_key",
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "CARTESIA_SECONDARY_KEY",
        post_extract_validator: {
          min_length: 16,
          max_length: 512,
        },
      },
    ],
  },
  {
    service: "cerebras",
    version: "v1",
    skill_id: "VN9KWN9JHSZZ0W3PM1ZR8AVTFD",
    status: "active",
    oauth_provider: "google",
    source_step_count: 7,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Cerebras account console.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "navigate",
        summary: "Open the Cerebras account console.",
      },
      {
        kind: "click_oauth_button",
        summary: "Choose google sign-in.",
      },
      {
        kind: "click",
        summary: "Continue through the account flow.",
      },
      {
        kind: "click",
        summary: "Continue through the account flow.",
      },
      {
        kind: "extract_via_copy_button",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "CEREBRAS_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "chroma",
    version: "v1",
    skill_id: "ENEHC38M9E2F2VEZD7R0AJPX09",
    status: "active",
    oauth_provider: null,
    source_step_count: 3,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Chroma account console.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "extract_via_copy_button",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "CHROMA_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "clerk",
    version: "v1",
    skill_id: "8YACTGEPASNKRA7AS2W7KXHRFM",
    status: "active",
    oauth_provider: null,
    source_step_count: 7,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Clerk account console.",
      },
      {
        kind: "fill",
        summary: "Enter the generated signup email alias.",
      },
      {
        kind: "fill",
        summary: "Enter a generated password through the sealed browser session.",
      },
      {
        kind: "click",
        summary: "Continue through the account flow.",
      },
      {
        kind: "await_email_code",
        summary:
          "Receive and enter the email verification code through the sealed verification flow.",
      },
      {
        kind: "click",
        summary: "Create a new API credential.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "prefix:sk_live",
        env_var_suggestion: "CLERK_API_KEY",
        post_extract_validator: {
          min_length: 28,
          max_length: 128,
        },
      },
    ],
  },
  {
    service: "cloud66",
    version: "v1",
    skill_id: "SZT4MC5979GMAKB349KHNH5H03",
    status: "active",
    oauth_provider: "google",
    source_step_count: 6,
    steps: [
      {
        kind: "click_oauth_button",
        summary: "Choose google sign-in.",
      },
      {
        kind: "navigate",
        summary: "Open the Cloud 66 account console.",
      },
      {
        kind: "navigate",
        summary: "Open the Cloud 66 account console.",
      },
      {
        kind: "click",
        summary: "Continue through the recorded account flow.",
      },
      {
        kind: "click",
        summary: "Open account settings.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "CLOUD66_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "codesandbox",
    version: "v1",
    skill_id: "JCBH7CN4NJMSRR2Z5XY7C6GDG6",
    status: "active",
    oauth_provider: null,
    source_step_count: 2,
    steps: [
      {
        kind: "navigate",
        summary: "Open the CodeSandbox account console.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "CODESANDBOX_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "cohere",
    version: "v1",
    skill_id: "PHEVE87GKDNSM5YYX8TZBR933Q",
    status: "active",
    oauth_provider: null,
    source_step_count: 3,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Cohere account console.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "COHERE_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "convex",
    version: "v1",
    skill_id: "5HH3ZZBQE2Q8V47B3BDSV87JC7",
    status: "active",
    oauth_provider: null,
    source_step_count: 2,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Convex account console.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "CONVEX_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "daytona",
    version: "v1",
    skill_id: "ZHN1M0YZSSSX6R6K96Z84Q8JCV",
    status: "active",
    oauth_provider: "google",
    source_step_count: 9,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Daytona account console.",
      },
      {
        kind: "click_oauth_button",
        summary: "Choose google sign-in.",
      },
      {
        kind: "click",
        summary: "Continue through the account flow.",
      },
      {
        kind: "click",
        summary: "Continue through the recorded account flow.",
      },
      {
        kind: "click",
        summary: "Continue through the recorded account flow.",
      },
      {
        kind: "click",
        summary: "Continue through the account flow.",
      },
      {
        kind: "fill",
        summary: "Name the new API credential.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "extract_via_copy_button",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "uuid",
        env_var_suggestion: "DAYTONA_API_KEY",
        post_extract_validator: {
          min_length: 32,
          max_length: 80,
        },
      },
    ],
  },
  {
    service: "deepinfra",
    version: "v1",
    skill_id: "MN8RJB7N1N50XCNP6F1ZSX4WPE",
    status: "active",
    oauth_provider: "github",
    source_step_count: 9,
    steps: [
      {
        kind: "navigate",
        summary: "Open the DeepInfra account console.",
      },
      {
        kind: "click_oauth_button",
        summary: "Choose github sign-in.",
      },
      {
        kind: "navigate",
        summary: "Open the DeepInfra account console.",
      },
      {
        kind: "click",
        summary: "Dismiss the current overlay or notice.",
      },
      {
        kind: "click",
        summary: "Dismiss the current overlay or notice.",
      },
      {
        kind: "click",
        summary: "Continue through the recorded account flow.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "fill",
        summary: "Name the new API credential.",
      },
      {
        kind: "extract_via_copy_button",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "DEEPINFRA_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "deepseek",
    version: "v1",
    skill_id: "E1KW3WZ39TQJJMGQK434N0E075",
    status: "active",
    oauth_provider: null,
    source_step_count: 3,
    steps: [
      {
        kind: "navigate",
        summary: "Open the DeepSeek account console.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "DEEPSEEK_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "e2b",
    version: "v1",
    skill_id: "62F5DYYF88DY98532TE0VVYRRB",
    status: "active",
    oauth_provider: null,
    source_step_count: 6,
    steps: [
      {
        kind: "navigate",
        summary: "Open the E2B account console.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "click",
        summary: "Create a new API credential.",
      },
      {
        kind: "fill",
        summary: "Name the new API credential.",
      },
      {
        kind: "click",
        summary: "Create a new API credential.",
      },
      {
        kind: "extract_via_copy_button",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "uuid",
        env_var_suggestion: "E2B_API_KEY",
        visibility: "show_once_at_creation",
        post_extract_validator: {
          min_length: 32,
          max_length: 80,
        },
      },
    ],
  },
  {
    service: "electric-sql",
    version: "v1",
    skill_id: "HRSE738PTS8BYVK8WKK673DCY5",
    status: "active",
    oauth_provider: null,
    source_step_count: 8,
    steps: [
      {
        kind: "navigate",
        summary: "Open the ElectricSQL account console.",
      },
      {
        kind: "click",
        summary: "Open account settings.",
      },
      {
        kind: "navigate",
        summary: "Open the ElectricSQL account console.",
      },
      {
        kind: "navigate",
        summary: "Open the ElectricSQL account console.",
      },
      {
        kind: "click",
        summary: "Continue through the recorded account flow.",
      },
      {
        kind: "click",
        summary: "Continue through the recorded account flow.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "ELECTRIC_SQL_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "elevenlabs",
    version: "v1",
    skill_id: "JD2W6XEDFJ94PVPRX3KZ3JP1S6",
    status: "active",
    oauth_provider: null,
    source_step_count: 2,
    steps: [
      {
        kind: "navigate",
        summary: "Open the ElevenLabs account console.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "ELEVENLABS_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "falai",
    version: "v1",
    skill_id: "1Q0Z057YJZ3ZFEQTCJ9FGXM9X2",
    status: "active",
    oauth_provider: null,
    source_step_count: 6,
    steps: [
      {
        kind: "navigate",
        summary: "Open the fal account console.",
      },
      {
        kind: "click",
        summary: "Dismiss the current overlay or notice.",
      },
      {
        kind: "click",
        summary: "Create a new API credential.",
      },
      {
        kind: "fill",
        summary: "Complete the requested onboarding field.",
      },
      {
        kind: "click",
        summary: "Create a new API credential.",
      },
      {
        kind: "extract_via_copy_button",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "FALAI_API_KEY",
        visibility: "show_once_at_creation",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "fireworks-ai",
    version: "v1",
    skill_id: "G8PMVHZE00DS9XZR67EAZR6P4Z",
    status: "active",
    oauth_provider: null,
    source_step_count: 2,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Fireworks AI account console.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "FIREWORKS_AI_API_KEY",
        post_extract_validator: {
          min_length: 9,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "fly-io",
    version: "v1",
    skill_id: "V3EQ74Z05QSBMHYG5J3JVQHWXR",
    status: "active",
    oauth_provider: null,
    source_step_count: 7,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Fly.io account console.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "navigate",
        summary: "Open the Fly.io account console.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "fill",
        summary: "Name the new API credential.",
      },
      {
        kind: "click",
        summary: "Create a new API credential.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "FLY_IO_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "friendliai",
    version: "v1",
    skill_id: "9WF9MWCJDP5W7H84CZZHF4JDDS",
    status: "active",
    oauth_provider: null,
    source_step_count: 5,
    steps: [
      {
        kind: "navigate",
        summary: "Open the FriendliAI account console.",
      },
      {
        kind: "click",
        summary: "Continue through the account flow.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "uuid",
        env_var_suggestion: "FRIENDLIAI_API_KEY",
        post_extract_validator: {
          min_length: 32,
          max_length: 80,
        },
      },
    ],
  },
  {
    service: "gladia",
    version: "v1",
    skill_id: "DGTH18J8SCNK9NCAZZGS0EK3R5",
    status: "active",
    oauth_provider: "google",
    source_step_count: 6,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Gladia account console.",
      },
      {
        kind: "click_oauth_button",
        summary: "Choose google sign-in.",
      },
      {
        kind: "click",
        summary: "Continue through the account flow.",
      },
      {
        kind: "click",
        summary: "Continue through the recorded account flow.",
      },
      {
        kind: "click_oauth_button",
        summary: "Choose google sign-in.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "GLADIA_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "groq",
    version: "v1",
    skill_id: "X0R51NTV477SCNMP72D0RYM9P9",
    status: "active",
    oauth_provider: null,
    source_step_count: 4,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Groq account console.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "GROQ_API_KEY",
        visibility: "show_once_at_creation",
        post_extract_validator: {
          min_length: 10,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "helicone",
    version: "v1",
    skill_id: "B3XPJ6TF45YG3JE2M95RNSMKSZ",
    status: "active",
    oauth_provider: null,
    source_step_count: 3,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Helicone account console.",
      },
      {
        kind: "navigate",
        summary: "Open the Helicone account console.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "HELICONE_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "honeycomb",
    version: "v1",
    skill_id: "59D4X692SYPTGTNEXPR7EK2RFE",
    status: "active",
    oauth_provider: null,
    source_step_count: 2,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Honeycomb account console.",
      },
      {
        kind: "extract_via_copy_button",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "HONEYCOMB_API_KEY",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "hookdeck",
    version: "v1",
    skill_id: "YMCFAV5TJVMZ9MZG3B4Z7PF92E",
    status: "active",
    oauth_provider: null,
    source_step_count: 7,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Hookdeck account console.",
      },
      {
        kind: "fill",
        summary: "Enter the new organization name.",
      },
      {
        kind: "click",
        summary: "Create a new API credential.",
      },
      {
        kind: "click",
        summary: "Continue through the recorded account flow.",
      },
      {
        kind: "navigate",
        summary: "Open the Hookdeck account console.",
      },
      {
        kind: "click",
        summary: "Continue through the recorded account flow.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "uuid",
        env_var_suggestion: "HOOKDECK_API_KEY",
        post_extract_validator: {
          min_length: 32,
          max_length: 80,
        },
      },
    ],
  },
  {
    service: "hyperbolic",
    version: "v1",
    skill_id: "9895VPAJGVT91WGSKH0HR9B2SD",
    status: "active",
    oauth_provider: null,
    source_step_count: 6,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Hyperbolic account console.",
      },
      {
        kind: "click",
        summary: "Dismiss the current overlay or notice.",
      },
      {
        kind: "click",
        summary: "Open account settings.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "extract_via_copy_button",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "prefix:sk_live",
        env_var_suggestion: "HYPERBOLIC_API_KEY",
        post_extract_validator: {
          min_length: 28,
          max_length: 128,
        },
      },
    ],
  },
  {
    service: "ideogram",
    version: "v1",
    skill_id: "2SXRWWW8H46N3TK1CJ50W6J353",
    status: "active",
    oauth_provider: null,
    source_step_count: 5,
    steps: [
      {
        kind: "navigate",
        summary: "Open the Ideogram account console.",
      },
      {
        kind: "click",
        summary: "Open the API key or access-token area.",
      },
      {
        kind: "click",
        summary: "Create a new API credential.",
      },
      {
        kind: "click",
        summary: "Create a new API credential.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "IDEOGRAM_API_KEY",
        visibility: "show_once_at_creation",
        post_extract_validator: {
          min_length: 8,
          max_length: 64,
        },
      },
    ],
  },
  {
    service: "imagekit",
    version: "v1",
    skill_id: "001KTN389YTM30XRHXJ9FAXEWV",
    status: "active",
    oauth_provider: "google",
    source_step_count: 2,
    steps: [
      {
        kind: "navigate",
        summary: "Open the ImageKit account console.",
      },
      {
        kind: "extract_labeled",
        summary: "Capture the labeled public key directly into the vault.",
      },
    ],
    credentials: [
      {
        name: "api_key",
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "IMAGEKIT_PUBLIC_KEY",
        post_extract_validator: {
          min_length: 20,
          max_length: 120,
        },
      },
    ],
  },
  {
    service: "ipinfo",
    version: "v1",
    skill_id: "V1WW5HRBNP6FEY7683XP9AVPE9",
    status: "active",
    oauth_provider: null,
    source_step_count: 2,
    steps: [
      {
        kind: "navigate",
        summary: "Open the IPinfo account console.",
      },
      {
        kind: "extract_via_regex",
        summary: "Capture the validated credential directly into the vault.",
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "IPINFO_API_KEY",
        post_extract_validator: {
          min_length: 12,
          max_length: 64,
        },
      },
    ],
  },
] as const;

type ServiceSlugA = (typeof REGISTRY_A)[number]["service"];

type EditorialContent = Pick<
  ServicePageContent,
  "name" | "category" | "summary" | "outcome" | "useCases" | "related" | "dataQuality"
>;

const EDITORIAL_A = {
  activeloop: {
    name: "Activeloop",
    category: "Vector data infrastructure",
    summary:
      "Set up Activeloop for Deep Lake datasets and retrieval pipelines, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Activeloop for Deep Lake datasets and retrieval pipelines while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Connect a Deep Lake dataset to a RAG workflow.",
      "Automate dataset ingestion without copying a key into .env.",
    ],
    related: ["chroma", "convex"],
    dataQuality: [
      "Registry signup URL contained a captured account path; public URL reduced to a stable provider entry point.",
    ],
  },
  ai21: {
    name: "AI21",
    category: "Language model APIs",
    summary:
      "Set up AI21 for Jamba inference and language tools, with the resulting credential stored directly in the vault.",
    outcome:
      "Use AI21 for Jamba inference and language tools while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Add Jamba inference to an application.",
      "Evaluate AI21 generation beside another model provider.",
    ],
    related: ["anthropic-api", "cohere"],
    dataQuality: [
      "The active skill exposes two generic copy-control labels as separate credentials.",
    ],
  },
  algolia: {
    name: "Algolia",
    category: "Search infrastructure",
    summary:
      "Set up Algolia for indexed search and discovery, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Algolia for indexed search and discovery while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Build fast product or documentation search.",
      "Populate a hosted search index from a deployment pipeline.",
    ],
    related: ["chroma", "convex"],
    dataQuality: [
      "Registry signup URL contained a captured application identifier; public URL reduced to the dashboard origin.",
    ],
  },
  "anthropic-api": {
    name: "Anthropic API",
    category: "Language model APIs",
    summary:
      "Set up Anthropic API for Claude-powered application features, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Anthropic API for Claude-powered application features while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Add Claude generation or tool use to an application.",
      "Run model experiments without putting a key in .env.",
    ],
    related: ["ai21", "cohere"],
  },
  apify: {
    name: "Apify",
    category: "Web data automation",
    summary:
      "Set up Apify for Actors, tasks, and dataset automation, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Apify for Actors, tasks, and dataset automation while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Trigger a scraping Actor from a backend job.",
      "Move Actor results into a search or analytics pipeline.",
    ],
    related: ["hookdeck", "ipinfo"],
  },
  assemblyai: {
    name: "AssemblyAI",
    category: "Speech intelligence",
    summary:
      "Set up AssemblyAI for transcription and audio intelligence, with the resulting credential stored directly in the vault.",
    outcome:
      "Use AssemblyAI for transcription and audio intelligence while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Transcribe uploaded meetings or interviews.",
      "Add speaker labels and audio analysis to a media workflow.",
    ],
    related: ["gladia", "elevenlabs"],
  },
  axiom: {
    name: "Axiom",
    category: "Observability",
    summary:
      "Set up Axiom for logs, events, and operational queries, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Axiom for logs, events, and operational queries while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Ship structured application logs to Axiom.",
      "Query events during debugging and incident response.",
    ],
    related: ["honeycomb", "helicone"],
    dataQuality: [
      "Registry signup URL contained a captured organization slug; public URL reduced to the app origin.",
    ],
  },
  baseten: {
    name: "Baseten",
    category: "Model deployment",
    summary:
      "Set up Baseten for deployed model inference and management, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Baseten for deployed model inference and management while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Call a production model deployment from an application.",
      "Automate model deployment checks from CI.",
    ],
    related: ["fireworks-ai", "friendliai"],
  },
  braintrust: {
    name: "Braintrust",
    category: "AI evaluation",
    summary:
      "Set up Braintrust for model evaluations, experiments, and traces, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Braintrust for model evaluations, experiments, and traces while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Record model traces and experiment results.",
      "Run repeatable evaluation datasets during development.",
    ],
    related: ["helicone", "honeycomb"],
  },
  brevo: {
    name: "Brevo",
    category: "Email delivery",
    summary:
      "Set up Brevo for transactional email and messaging, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Brevo for transactional email and messaging while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Deliver verification and password-reset emails.",
      "Trigger transactional messages from backend events.",
    ],
    related: ["hookdeck", "clerk"],
  },
  cartesia: {
    name: "Cartesia",
    category: "Voice generation",
    summary:
      "Set up Cartesia for low-latency speech generation, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Cartesia for low-latency speech generation while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Add responsive text-to-speech to a voice interface.",
      "Generate narration for media or accessibility workflows.",
    ],
    related: ["elevenlabs", "gladia"],
    dataQuality: [
      "Captured password and secret-derived credential labels were replaced with safe public placeholders.",
    ],
  },
  cerebras: {
    name: "Cerebras",
    category: "Language model APIs",
    summary:
      "Set up Cerebras for fast language-model inference, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Cerebras for fast language-model inference while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Prototype a low-latency generation feature.",
      "Compare Cerebras inference with other providers.",
    ],
    related: ["groq", "fireworks-ai"],
    dataQuality: [
      "Registry signup URL pointed to Google account management; public URL now uses the Cerebras console.",
    ],
  },
  chroma: {
    name: "Chroma",
    category: "Vector databases",
    summary:
      "Set up Chroma for hosted collections and semantic retrieval, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Chroma for hosted collections and semantic retrieval while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Back a retrieval-augmented generation feature.",
      "Index product, support, or documentation embeddings.",
    ],
    related: ["activeloop", "algolia"],
    dataQuality: [
      "Registry signup URL contained a captured account slug; public URL reduced to the provider origin.",
    ],
  },
  clerk: {
    name: "Clerk",
    category: "Authentication",
    summary:
      "Set up Clerk for application authentication and user management, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Clerk for application authentication and user management while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Add sign-up and sign-in to a new web application.",
      "Provision authentication for a prototype.",
    ],
    related: ["convex", "brevo"],
    dataQuality: ["A captured password literal was replaced with a generated-password summary."],
  },
  cloud66: {
    name: "Cloud 66",
    category: "Application deployment",
    summary:
      "Set up Cloud 66 for deployment and account automation, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Cloud 66 for deployment and account automation while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Automate deployment checks and environment operations.",
      "Connect an application delivery workflow to Cloud 66.",
    ],
    related: ["fly-io", "codesandbox"],
  },
  codesandbox: {
    name: "CodeSandbox",
    category: "Cloud development environments",
    summary:
      "Set up CodeSandbox for cloud development workspace automation, with the resulting credential stored directly in the vault.",
    outcome:
      "Use CodeSandbox for cloud development workspace automation while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Create repeatable cloud development environments.",
      "Connect sandbox automation to an agent coding workflow.",
    ],
    related: ["e2b", "daytona"],
    dataQuality: [
      "Registry signup URL pointed to a captured sandbox; public URL reduced to the provider origin.",
    ],
  },
  cohere: {
    name: "Cohere",
    category: "Language model APIs",
    summary:
      "Set up Cohere for generation, embeddings, and reranking, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Cohere for generation, embeddings, and reranking while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Rerank search results for a retrieval application.",
      "Generate embeddings or text through Cohere.",
    ],
    related: ["ai21", "anthropic-api"],
  },
  convex: {
    name: "Convex",
    category: "Application backends",
    summary:
      "Set up Convex for a realtime application backend, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Convex for a realtime application backend while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Stand up a realtime backend for a new application.",
      "Automate data and deployment tasks for a Convex project.",
    ],
    related: ["clerk", "electric-sql"],
    dataQuality: [
      "Registry signup URL contained a captured team slug; public URL reduced to the dashboard origin.",
    ],
  },
  daytona: {
    name: "Daytona",
    category: "Cloud development environments",
    summary:
      "Set up Daytona for managed development environments and workspaces, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Daytona for managed development environments and workspaces while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Create isolated development environments on demand.",
      "Drive reproducible workspace setup from an agent.",
    ],
    related: ["e2b", "codesandbox"],
    dataQuality: [
      "Registry signup URL pointed to Google account management; public URL now uses the Daytona app.",
    ],
  },
  deepinfra: {
    name: "DeepInfra",
    category: "Model inference",
    summary:
      "Set up DeepInfra for hosted open-model inference, with the resulting credential stored directly in the vault.",
    outcome:
      "Use DeepInfra for hosted open-model inference while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Serve model inference behind an application endpoint.",
      "Compare model quality and latency across providers.",
    ],
    related: ["baseten", "fireworks-ai"],
  },
  deepseek: {
    name: "DeepSeek",
    category: "Language model APIs",
    summary:
      "Set up DeepSeek for reasoning and generation workloads, with the resulting credential stored directly in the vault.",
    outcome:
      "Use DeepSeek for reasoning and generation workloads while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Add reasoning or code generation to an application.",
      "Test DeepSeek in a multi-provider evaluation.",
    ],
    related: ["groq", "cerebras"],
  },
  e2b: {
    name: "E2B",
    category: "Agent sandboxes",
    summary:
      "Set up E2B for secure cloud code sandboxes, with the resulting credential stored directly in the vault.",
    outcome:
      "Use E2B for secure cloud code sandboxes while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Run generated code in an isolated cloud sandbox.",
      "Give an agent disposable execution environments.",
    ],
    related: ["daytona", "codesandbox"],
    dataQuality: [
      "Registry signup URL contained a captured team path; public URL reduced to the dashboard root.",
    ],
  },
  "electric-sql": {
    name: "ElectricSQL",
    category: "Data synchronization",
    summary:
      "Set up ElectricSQL for Postgres-backed local-first synchronization, with the resulting credential stored directly in the vault.",
    outcome:
      "Use ElectricSQL for Postgres-backed local-first synchronization while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Add local-first sync to a Postgres application.",
      "Automate environment setup for a sync project.",
    ],
    related: ["convex", "chroma"],
    dataQuality: [
      "Registry steps contained captured project, environment, and workspace identifiers; public summaries omit them.",
    ],
  },
  elevenlabs: {
    name: "ElevenLabs",
    category: "Voice generation",
    summary:
      "Set up ElevenLabs for speech and audio generation, with the resulting credential stored directly in the vault.",
    outcome:
      "Use ElevenLabs for speech and audio generation while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Add high-quality narration to a product.",
      "Build a conversational voice or accessibility feature.",
    ],
    related: ["cartesia", "gladia"],
  },
  falai: {
    name: "fal",
    category: "Generative media",
    summary:
      "Set up fal for image, video, and media models, with the resulting credential stored directly in the vault.",
    outcome:
      "Use fal for image, video, and media models while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Generate images or video from an application.",
      "Run media model jobs from a backend workflow.",
    ],
    related: ["ideogram", "fireworks-ai"],
  },
  "fireworks-ai": {
    name: "Fireworks AI",
    category: "Model inference",
    summary:
      "Set up Fireworks AI for fast hosted model inference, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Fireworks AI for fast hosted model inference while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Serve open models behind a production feature.",
      "Benchmark inference latency across providers.",
    ],
    related: ["baseten", "groq"],
  },
  "fly-io": {
    name: "Fly.io",
    category: "Application deployment",
    summary:
      "Set up Fly.io for application and infrastructure operations, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Fly.io for application and infrastructure operations while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Deploy an application close to its users.",
      "Automate organization or machine operations from CI.",
    ],
    related: ["cloud66", "codesandbox"],
  },
  friendliai: {
    name: "FriendliAI",
    category: "Model inference",
    summary:
      "Set up FriendliAI for managed inference endpoints, with the resulting credential stored directly in the vault.",
    outcome:
      "Use FriendliAI for managed inference endpoints while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Deploy an optimized model endpoint.",
      "Connect a backend service to FriendliAI inference.",
    ],
    related: ["deepinfra", "baseten"],
    dataQuality: [
      "Registry signup URL contained a captured suite identifier; public URL reduced to the provider origin.",
    ],
  },
  gladia: {
    name: "Gladia",
    category: "Speech intelligence",
    summary:
      "Set up Gladia for transcription and audio understanding, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Gladia for transcription and audio understanding while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Transcribe calls, meetings, or uploaded media.",
      "Add multilingual speech processing to a workflow.",
    ],
    related: ["assemblyai", "elevenlabs"],
    dataQuality: [
      "Registry signup URL pointed to Google account management; public URL now uses the Gladia app.",
    ],
  },
  groq: {
    name: "Groq",
    category: "Language model APIs",
    summary:
      "Set up Groq for low-latency model inference, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Groq for low-latency model inference while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Build a latency-sensitive generation feature.",
      "Evaluate open models on Groq infrastructure.",
    ],
    related: ["cerebras", "deepseek"],
  },
  helicone: {
    name: "Helicone",
    category: "AI observability",
    summary:
      "Set up Helicone for LLM request tracing and analytics, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Helicone for LLM request tracing and analytics while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Trace model requests, latency, and cost.",
      "Add observability to a multi-provider AI application.",
    ],
    related: ["braintrust", "honeycomb"],
    dataQuality: [
      "Registry signup URL pointed to Google account management and oauth_provider was null; public URL now uses Helicone sign-in.",
    ],
  },
  honeycomb: {
    name: "Honeycomb",
    category: "Observability",
    summary:
      "Set up Honeycomb for events, traces, and production debugging, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Honeycomb for events, traces, and production debugging while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Instrument a service with distributed tracing.",
      "Query high-cardinality events during incidents.",
    ],
    related: ["axiom", "helicone"],
    dataQuality: [
      "Registry signup URL contained captured team and environment slugs; public URL reduced to the provider origin.",
    ],
  },
  hookdeck: {
    name: "Hookdeck",
    category: "Webhook infrastructure",
    summary:
      "Set up Hookdeck for webhook delivery, inspection, and replay, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Hookdeck for webhook delivery, inspection, and replay while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Receive and replay development webhooks.",
      "Add reliable webhook delivery to an integration.",
    ],
    related: ["brevo", "apify"],
  },
  hyperbolic: {
    name: "Hyperbolic",
    category: "GPU and model inference",
    summary:
      "Set up Hyperbolic for hosted GPU and inference workloads, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Hyperbolic for hosted GPU and inference workloads while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Run model inference on hosted GPU capacity.",
      "Connect an AI backend to Hyperbolic compute.",
    ],
    related: ["deepinfra", "fireworks-ai"],
  },
  ideogram: {
    name: "Ideogram",
    category: "Image generation",
    summary:
      "Set up Ideogram for programmatic image generation, with the resulting credential stored directly in the vault.",
    outcome:
      "Use Ideogram for programmatic image generation while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Generate product, campaign, or interface imagery.",
      "Automate prompt-to-image jobs from a backend.",
    ],
    related: ["falai", "imagekit"],
    dataQuality: [
      "Registry signup URL pointed to documentation; public URL now uses the API manager.",
    ],
  },
  imagekit: {
    name: "ImageKit",
    category: "Image delivery",
    summary:
      "Set up ImageKit for image delivery and transformation, with the resulting credential stored directly in the vault.",
    outcome:
      "Use ImageKit for image delivery and transformation while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Optimize and deliver application images.",
      "Connect media upload and transformation workflows.",
    ],
    related: ["ideogram", "falai"],
  },
  ipinfo: {
    name: "IPinfo",
    category: "IP data APIs",
    summary:
      "Set up IPinfo for IP geolocation and network intelligence, with the resulting credential stored directly in the vault.",
    outcome:
      "Use IPinfo for IP geolocation and network intelligence while Trusty Squire injects the credential only into allowed provider requests.",
    useCases: [
      "Add IP geolocation to request handling.",
      "Enrich security or analytics events with network data.",
    ],
    related: ["apify", "hookdeck"],
  },
} as const satisfies Record<ServiceSlugA, EditorialContent>;

const PUBLIC_SIGNUP_URLS = {
  activeloop: "https://app.activeloop.ai/",
  ai21: "https://studio.ai21.com/",
  algolia: "https://dashboard.algolia.com/",
  "anthropic-api": "https://console.anthropic.com/settings/keys",
  apify: "https://console.apify.com/",
  assemblyai: "https://www.assemblyai.com/dashboard/",
  axiom: "https://app.axiom.co/",
  baseten: "https://app.baseten.co/settings/api_keys",
  braintrust: "https://www.braintrust.dev/app",
  brevo: "https://app.brevo.com/",
  cartesia: "https://play.cartesia.ai/sign-up",
  cerebras: "https://cloud.cerebras.ai/",
  chroma: "https://www.trychroma.com/",
  clerk: "https://dashboard.clerk.com/sign-up",
  cloud66: "https://app.cloud66.com/users/sign_in",
  codesandbox: "https://codesandbox.io/",
  cohere: "https://dashboard.cohere.com/",
  convex: "https://dashboard.convex.dev/",
  daytona: "https://app.daytona.io/",
  deepinfra: "https://deepinfra.com/login",
  deepseek: "https://platform.deepseek.com/",
  e2b: "https://e2b.dev/dashboard",
  "electric-sql": "https://dashboard.electric-sql.cloud/",
  elevenlabs: "https://elevenlabs.io/app/",
  falai: "https://fal.ai/dashboard/keys",
  "fireworks-ai": "https://app.fireworks.ai/",
  "fly-io": "https://fly.io/dashboard",
  friendliai: "https://friendli.ai/",
  gladia: "https://app.gladia.io/",
  groq: "https://console.groq.com/",
  helicone: "https://www.helicone.ai/signin",
  honeycomb: "https://ui.honeycomb.io/",
  hookdeck: "https://dashboard.hookdeck.com/onboarding",
  hyperbolic: "https://app.hyperbolic.ai/",
  ideogram: "https://ideogram.ai/manage-api",
  imagekit: "https://imagekit.io/dashboard/developer/api-keys",
  ipinfo: "https://ipinfo.io/dashboard",
} as const satisfies Record<ServiceSlugA, string>;

function credentialLabel(service: (typeof REGISTRY_A)[number]): string {
  return service.credentials.map((credential) => credential.env_var_suggestion).join(" and ");
}

export const SERVICE_CONTENT_A: readonly ServicePageContent[] = defineServices(
  REGISTRY_A.map((registry) => {
    const editorial = EDITORIAL_A[registry.service];
    const credential = credentialLabel(registry);
    const hasMultipleCredentials = registry.credentials.length > 1;
    return {
      registry,
      ...editorial,
      publicSignupUrl: PUBLIC_SIGNUP_URLS[registry.service],
      metaDescription: `Let your coding agent set up ${editorial.name} and save ${credential} in Trusty Squire's vault without exposing ${hasMultipleCredentials ? "them" : "it"} in chat, code, or .env files.`,
      prompt: `Sign me up for ${editorial.name}, create the API credential${hasMultipleCredentials ? "s" : ""}, and save ${hasMultipleCredentials ? "them" : "it"} to my Trusty Squire vault.`,
      vaultSafety: `${editorial.name}'s ${credential} ${hasMultipleCredentials ? "are" : "is"} stored as write-only vault credential${hasMultipleCredentials ? "s" : ""}. For backend use, mint a host-scoped egress grant and keep its revocable token in server-side secret storage. The raw provider ${hasMultipleCredentials ? "values are" : "value is"} not returned to the agent or written to the project.`,
    };
  }),
);
