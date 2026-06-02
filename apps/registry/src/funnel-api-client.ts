// Registry→API client for Panel 1 (the registry's first-ever outbound
// HTTP). Fetches the API-side funnel counts from trusty-squire-api's
// GET /v1/admin/funnel, passing explicit window bounds so both services
// aggregate over identical boundaries. Fail-soft: any failure, timeout,
// non-200, or shape mismatch returns null and the dashboard renders the
// registry-side stages with the API metrics marked unavailable.
//
// The response type is duplicated here (the two packages can't share a
// type across the deploy boundary) and pinned by a shared JSON fixture
// contract test — see __tests__/fixtures/funnel-response.json.

export interface ApiFunnelData {
  window_start: string;
  window_end: string;
  as_of: string;
  tokens_issued: number;
  accounts_created: number;
  new_accounts_series: Array<{ date: string; count: number }>;
  npm_downloads: number | null;
}

const DEFAULT_TIMEOUT_MS = 1500;

export async function fetchApiFunnel(opts: {
  apiBase: string;
  token: string;
  start: Date;
  end: Date;
  fetchFn?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<ApiFunnelData | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const qs = new URLSearchParams({
    window_start: opts.start.toISOString(),
    window_end: opts.end.toISOString(),
  });
  const url = `${opts.apiBase.replace(/\/$/, "")}/v1/admin/funnel?${qs.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      headers: { authorization: `Bearer ${opts.token}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Partial<ApiFunnelData>;
    // Validate the contract before trusting it.
    if (
      typeof json.tokens_issued !== "number" ||
      typeof json.accounts_created !== "number" ||
      !Array.isArray(json.new_accounts_series)
    ) {
      return null;
    }
    return json as ApiFunnelData;
  } catch {
    return null; // timeout / network / parse — fail-soft
  } finally {
    clearTimeout(timer);
  }
}
