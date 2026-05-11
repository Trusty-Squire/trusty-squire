// Reverse-HTTP executor — fires the cancellation/rollback request a
// side effect's reverse_action describes.
//
// Stripped down vs http-request.ts: no template interpolation (the
// compensator passes a fully-resolved ReverseAction), no side-effect
// emission, no extraction. Just: build auth header, POST/DELETE,
// throw on non-2xx.

import type { ReverseAction, ReverseAuth } from "@trusty-squire/adapter-sdk";
import type { VaultClient } from "../vault-client.js";

export class ReverseHttpError extends Error {
  public readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "ReverseHttpError";
    this.status = status;
  }
}

export interface ReverseHttpOptions {
  fetch?: typeof fetch;
  idempotencyKey: string;
  // Used when the reverse action declares a vault-sourced auth credential
  // and we need to look up the actual secret at execute time.
  vault: VaultClient;
}

export async function executeReverseHttp(
  action: Extract<ReverseAction, { kind: "http_request" }>,
  options: ReverseHttpOptions,
): Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  const headers: Record<string, string> = {};

  if (action.auth !== undefined) {
    await applyAuthHeaders(headers, action.auth, options.vault);
  }

  if (action.method !== "GET") {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  let response: Response;
  try {
    response = await fetchImpl(action.url_template, { method: action.method, headers });
  } catch (err) {
    throw new ReverseHttpError(
      `network error: ${err instanceof Error ? err.message : String(err)}`,
      null,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ReverseHttpError(
      `reverse HTTP returned ${response.status}`,
      response.status,
    );
  }
}

async function applyAuthHeaders(
  headers: Record<string, string>,
  auth: ReverseAuth,
  vault: VaultClient,
): Promise<void> {
  if (auth.source !== "vault") {
    // 'context' source is only useful while a run is live; reverse
    // actions execute later. Reject loudly so misconfigured manifests
    // surface in dev rather than silently leaking auth.
    throw new ReverseHttpError(
      `unsupported reverse auth source '${auth.source}' (only 'vault' is valid post-run)`,
      null,
    );
  }
  const value = await vault.retrieveForRuntime(auth.reference_template, "reverse_http");
  const scheme = auth.scheme ?? "bearer";
  switch (scheme) {
    case "bearer":
      headers["Authorization"] = `Bearer ${value}`;
      break;
    case "basic":
      headers["Authorization"] = `Basic ${value}`;
      break;
    case "header": {
      const name = auth.header_name ?? "X-Auth";
      headers[name] = value;
      break;
    }
  }
}
