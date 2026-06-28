const ALLOWED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:"]);

export function normalizeProxyUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (!ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol)) return undefined;
    if (parsed.hostname.length === 0) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}
