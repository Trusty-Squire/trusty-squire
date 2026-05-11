// Reference adapter — Resend (illustrative).
//
// The real Resend signup flow uses Stack Auth (browser-only). This
// manifest models a hypothetical API-only signup so we have an
// end-to-end fixture for the chunk-3 executor / state-machine tests
// without depending on browser tier-2 plumbing. When chunk 8 adds the
// browser tier, this manifest will be rewritten against the real flow.
//
// All API URLs point at api.resend.com; capability check enforces the
// hostname whitelist regardless of what the templates resolve to.

import { defineAdapter } from "@trusty-squire/adapter-sdk";

export const resendManifest = defineAdapter({
  service: "resend",
  version: "0.1.0",
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
  signature: "PLACEHOLDER",

  metadata: {
    display_name: "Resend",
    category: "email",
    homepage: "https://resend.com",
    description: "Transactional email API.",
  },

  plans: [
    {
      id: "free",
      display_name: "Free",
      monthly_cents: 0,
      recurrence: "none",
      description: "3,000 emails/month",
    },
    {
      id: "pro",
      display_name: "Pro",
      monthly_cents: 2000,
      recurrence: "monthly",
      description: "50,000 emails/month",
    },
  ],
  default_plan: "free",

  capabilities: {
    payment: { max_authorize_cents: 2000, recurrence: "monthly" },
    email: { receive_from: ["resend.com", "*.resend.com"] },
    network: { allowed_domains: ["api.resend.com"] },
    vault_writes: [
      {
        kind: "api_key",
        // Per-account namespacing; the run's email alias is unique.
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
          url_template: "https://api.resend.com/v1/accounts",
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
            url_template: "https://api.resend.com/v1/accounts/${response.body.id}",
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
          url_template:
            "https://api.resend.com/v1/accounts/${steps.create_account.body.id}/confirm",
          headers: { "Content-Type": "application/json" },
        },
        expect: { status: 200 },
      },
      {
        id: "create_api_key",
        type: "http_request",
        request: {
          method: "POST",
          url_template: "https://api.resend.com/v1/api-keys",
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
          url_template:
            "https://api.resend.com/v1/accounts/${steps.create_account.body.id}",
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
          url_template: "https://api.resend.com/v1/api-keys/rotate",
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

export default resendManifest;
