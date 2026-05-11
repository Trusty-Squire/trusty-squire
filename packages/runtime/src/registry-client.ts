// HTTP-backed AdapterRegistry implementation. Plug-compatible with
// InMemoryAdapterRegistry — both implement the same `load(service,
// version)` interface so the executor doesn't care which is wired in.
//
// Signature verification is currently a TODO per the chunk-9 spec
// ("Do not implement signature verification at runtime"). Future work:
// embed the registry's public key, verify each fetched manifest's
// signature before returning. The error type already exists.

import type { AdapterManifest } from "@trusty-squire/adapter-sdk";
import { AdapterNotFoundError, type AdapterRegistry } from "./adapter-registry.js";

export class AdapterDisabledError extends Error {
  constructor(adapterId: string, version: string, reason: string | null) {
    super(`Adapter disabled: ${adapterId}@${version}${reason ? ` — ${reason}` : ""}`);
    this.name = "AdapterDisabledError";
    this.adapterId = adapterId;
    this.version = version;
    this.reason = reason;
  }
  public readonly adapterId: string;
  public readonly version: string;
  public readonly reason: string | null;
}

export class RegistryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryUnavailableError";
  }
}

export interface RegistryClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  // Per-worker cache TTL for the runtime side too — registry serves
  // a `Cache-Control: max-age=3600` header but we re-cache here so
  // we don't hit fetch's HTTP cache reliance during a hot run.
  cacheTtlMs?: number;
}

interface CacheEntry {
  manifest: AdapterManifest;
  expires_at: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class RegistryClient implements AdapterRegistry {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;

  constructor(opts: RegistryClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
  }

  async load(adapterId: string, version: string): Promise<AdapterManifest> {
    const cacheKey = `${adapterId}@${version}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && cached.expires_at > Date.now()) {
      return cached.manifest;
    }

    const url = `${this.baseUrl}/adapters/${encodeURIComponent(adapterId)}/${encodeURIComponent(version)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url);
    } catch (err) {
      throw new RegistryUnavailableError(
        `registry fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (res.status === 404) throw new AdapterNotFoundError(adapterId, version);
    if (res.status === 410) {
      const body = (await safeJson(res)) as { disabled_reason?: string } | null;
      throw new AdapterDisabledError(adapterId, version, body?.disabled_reason ?? null);
    }
    if (!res.ok) {
      throw new RegistryUnavailableError(`registry returned HTTP ${res.status}`);
    }

    const body = (await res.json()) as { manifest?: AdapterManifest };
    if (body.manifest === undefined) {
      throw new RegistryUnavailableError("registry response missing 'manifest' field");
    }
    // TODO: verify body.signature against the registry's published
    // public key before returning. Tracked for the post-v0 hardening
    // pass; the registry serves only signed manifests today, but the
    // runtime doesn't yet verify.
    this.cache.set(cacheKey, {
      manifest: body.manifest,
      expires_at: Date.now() + this.cacheTtlMs,
    });
    return body.manifest;
  }

  // Test / ops helper.
  invalidate(adapterId: string, version: string): void {
    this.cache.delete(`${adapterId}@${version}`);
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
