// Test fixtures: a valid AdapterManifest builder + helpers for
// test-only Ed25519 keys.

import { Buffer } from "node:buffer";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { defineAdapter, type AdapterManifest } from "@trusty-squire/adapter-sdk";

export function makeValidManifest(overrides: Partial<AdapterManifest> = {}): AdapterManifest {
  return defineAdapter({
    service: "demo",
    version: "0.1.0",
    schema_version: 1,
    authored_by: { org: "Test", contact: "test@example.com" },
    audit: { reviewer: "test@example.com", reviewed_at: "2026-05-10T00:00:00.000Z" },
    signature: "PLACEHOLDER",
    metadata: {
      display_name: "Demo",
      category: "test",
      homepage: "https://demo.example.com",
      description: "A test adapter",
    },
    plans: [
      { id: "free", display_name: "Free", monthly_cents: 0, recurrence: "none" },
      { id: "pro", display_name: "Pro", monthly_cents: 1000, recurrence: "monthly" },
    ],
    default_plan: "free",
    capabilities: {
      payment: { max_authorize_cents: 1000, recurrence: "monthly" },
      email: { receive_from: ["demo.example.com"] },
      network: { allowed_domains: ["api.demo.example.com"] },
      vault_writes: [
        {
          kind: "api_key",
          reference_template: "vault://${context.email_alias}/demo/api_key",
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
            url_template: "https://api.demo.example.com/v1/accounts",
          },
          expect: { status: 201, extract: { id: "$.body.id" } },
        },
        {
          id: "create_api_key",
          type: "http_request",
          request: {
            method: "POST",
            url_template: "https://api.demo.example.com/v1/api-keys",
          },
          expect: { status: 200, extract: { api_key: "$.body.token" } },
        },
      ],
    },
    cancel: { steps: [] },
    rotate: { steps: [] },
    ...overrides,
  });
}

export function generateEd25519KeyPair(): { privateKey: KeyObject; publicKey: KeyObject; publicKeyB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return { privateKey, publicKey, publicKeyB64: Buffer.from(spki).toString("base64url") };
}
