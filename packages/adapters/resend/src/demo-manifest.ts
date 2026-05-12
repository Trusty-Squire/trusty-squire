// Demo-mode Resend manifest — points at scripts/mock-resend.mjs at
// localhost:4001 so `pnpm demo` can run the full provisioning loop
// repeatedly without burning real Resend accounts.
//
// Structurally identical to the canonical resend manifest (see
// ./manifest.ts) — same step IDs, same vault writes, same side-effect
// references. The only differences are url_template prefixes and
// capabilities.network.allowed_domains. Keeping them in lockstep means
// switching DEMO_MODE off to a real adapter is a one-import change.

import { defineAdapter } from "@trusty-squire/adapter-sdk";

const MOCK_BASE = "http://localhost:4001";

export const resendDemoManifest = defineAdapter({
  service: "resend",
  version: "0.1.0-demo",
  schema_version: 1,

  authored_by: {
    org: "Trusty Squire",
    contact: "core@trustysquire.ai",
    homepage: "https://trustysquire.ai",
  },
  audit: {
    reviewer: "bento@trustysquire.ai",
    reviewed_at: "2026-05-10T00:00:00Z",
  },
  signature: "DEMO-PLACEHOLDER",

  metadata: {
    display_name: "Resend (demo)",
    category: "email",
    homepage: "https://resend.com",
    description: "Transactional email API — demo manifest hitting the local mock server.",
  },

  plans: [
    {
      id: "free",
      display_name: "Free",
      monthly_cents: 0,
      recurrence: "none",
      description: "3,000 emails/month",
    },
  ],
  default_plan: "free",

  capabilities: {
    payment: { max_authorize_cents: 0, recurrence: "none" },
    email: { receive_from: ["resend.com", "*.resend.com"] },
    network: { allowed_domains: ["localhost"] },
    vault_writes: [
      {
        kind: "api_key",
        reference_template: "vault://${context.email_alias}/resend/api_key",
        rotation_required: false,
      },
    ],
  },

  signup: {
    steps: [
      {
        id: "create_account",
        type: "http_request",
        request: {
          method: "POST",
          url_template: `${MOCK_BASE}/v1/accounts`,
          headers: { "Content-Type": "application/json" },
          body_template: {
            email: "${context.email_alias}",
            display_name: "${context.project_name}",
          },
        },
        expect: {
          status: [200, 201],
          extract: { account_id: "$.body.id" },
        },
        emit_side_effect: {
          type: "saas_account",
          reference_template: "resend:${response.body.id}",
          reversible: true,
          reverse_action: {
            kind: "http_request",
            method: "DELETE",
            url_template: `${MOCK_BASE}/v1/accounts/\${response.body.id}`,
            auth: {
              source: "vault",
              reference_template: "vault://${context.email_alias}/resend/api_key",
              scheme: "bearer",
            },
          },
        },
      },
      {
        id: "confirm_account",
        type: "http_request",
        request: {
          method: "POST",
          url_template: `${MOCK_BASE}/v1/accounts/\${steps.create_account.body.id}/confirm`,
          headers: { "Content-Type": "application/json" },
        },
        expect: { status: 200 },
      },
      {
        id: "create_api_key",
        type: "http_request",
        request: {
          method: "POST",
          url_template: `${MOCK_BASE}/v1/api-keys`,
          headers: { "Content-Type": "application/json" },
          body_template: { name: "${context.project_name}" },
        },
        expect: {
          status: [200, 201],
          extract: { api_key: "$.body.token" },
        },
        emit_side_effect: {
          type: "vault_entry",
          reference_template: "vault://${context.email_alias}/resend/api_key",
          reversible: true,
          reverse_action: {
            kind: "vault_delete",
            reference_template: "vault://${context.email_alias}/resend/api_key",
          },
        },
      },
    ],
  },

  cancel: {
    steps: [
      {
        id: "delete_account",
        type: "http_request",
        request: {
          method: "DELETE",
          url_template: `${MOCK_BASE}/v1/accounts/\${steps.create_account.body.id}`,
          auth: {
            source: "vault",
            reference_template: "vault://${context.email_alias}/resend/api_key",
            scheme: "bearer",
          },
        },
        expect: { status: [200, 204] },
      },
    ],
  },

  rotate: {
    steps: [
      {
        id: "rotate_api_key",
        type: "http_request",
        request: {
          method: "POST",
          url_template: `${MOCK_BASE}/v1/api-keys/rotate`,
          auth: {
            source: "vault",
            reference_template: "vault://${context.email_alias}/resend/api_key",
            scheme: "bearer",
          },
        },
        expect: {
          status: 200,
          extract: { api_key: "$.body.token" },
        },
        emit_side_effect: {
          type: "vault_entry",
          reference_template: "vault://${context.email_alias}/resend/api_key",
          reversible: false,
          reverse_action: {
            kind: "noop",
            reason: "rotation is non-reversible by design",
          },
        },
      },
    ],
  },
});
