// HTTP client for the skill CLI. Separate from the in-MCP
// SkillRegistryClient (apps/mcp/src/skill-registry-client.ts) because
// the router and the CLI have different needs:
//
//   - The router fails open: a 500 means "fall through to bot."
//   - The CLI fails loud: a 500 should print the error + exit 66.
//
// Both talk to the same endpoints, but this client throws CliExit on
// every non-2xx so subcommand handlers can `await` cleanly.

import { CliExit, ExitCode } from "./errors.js";

export interface RegistryHttpOpts {
  /** Base URL. Required. CLI dispatcher reads this from env. */
  baseUrl: string;
  /** x-account-id header value. Optional — many CLI commands work without it. */
  accountId?: string;
  /** Override fetch for tests. Production uses globalThis.fetch. */
  fetchFn?: typeof globalThis.fetch;
  /** Network timeout. Default 10s — generous because the CLI is human-driven. */
  timeoutMs?: number;
}

export class RegistryHttpClient {
  private readonly baseUrl: string;
  private readonly accountId: string | undefined;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(opts: RegistryHttpOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.accountId = opts.accountId;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async get<T = unknown>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (this.accountId !== undefined) headers["x-account-id"] = this.accountId;
    if (body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await withTimeout(
        this.fetchFn(url, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
        this.timeoutMs,
      );
    } catch (err) {
      throw new CliExit(
        ExitCode.UNAVAILABLE,
        `registry call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (response.status === 404) {
      const detail = await tryReadDetail(response);
      throw new CliExit(ExitCode.NOT_FOUND, detail ?? `not found: ${path}`);
    }
    if (response.status === 401 || response.status === 403) {
      const detail = await tryReadDetail(response);
      throw new CliExit(ExitCode.FORBIDDEN, detail ?? `forbidden (HTTP ${response.status})`);
    }
    if (response.status === 400) {
      const detail = await tryReadDetail(response);
      throw new CliExit(ExitCode.VALIDATION, detail ?? "request rejected (HTTP 400)");
    }
    if (!response.ok) {
      throw new CliExit(
        ExitCode.UNAVAILABLE,
        `registry returned HTTP ${response.status}`,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new CliExit(
        ExitCode.UNAVAILABLE,
        `malformed JSON from registry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function tryReadDetail(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { detail?: unknown; error?: unknown };
    if (typeof body.detail === "string") return body.detail;
    if (typeof body.error === "string") return body.error;
    return null;
  } catch {
    return null;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`call timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Build a RegistryHttpClient from env or the explicit opts. Returns
 * the client or throws CliExit(CONFIG) when the registry URL isn't
 * configured.
 */
export function clientFromEnvOrThrow(opts?: Partial<RegistryHttpOpts>): RegistryHttpClient {
  const baseUrl = opts?.baseUrl ?? process.env.TRUSTY_SQUIRE_REGISTRY_URL;
  if (baseUrl === undefined || baseUrl.trim().length === 0) {
    throw new CliExit(
      ExitCode.CONFIG,
      "TRUSTY_SQUIRE_REGISTRY_URL is not set. Set it to the registry-api base URL " +
        "(e.g. https://registry.trustysquire.com) before running skill commands.",
    );
  }
  return new RegistryHttpClient({
    baseUrl,
    ...(opts?.accountId !== undefined ? { accountId: opts.accountId } : {}),
    ...(opts?.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}
