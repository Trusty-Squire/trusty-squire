const BASIC_OAUTH_SCOPES: ReadonlySet<string> = new Set([
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
]);

export function extractOAuthScopes(rawUrl: string): string[] | null {
  const scopes: string[] = [];
  const visit = (urlStr: string, depth: number): void => {
    if (scopes.length > 0 || depth > 8) return;
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      return;
    }
    const scope = url.searchParams.get("scope");
    if (scope !== null && scope.trim().length > 0) {
      for (const value of scope.split(/[\s,+]+/)) {
        const trimmed = value.trim();
        if (trimmed.length > 0) scopes.push(trimmed);
      }
      return;
    }
    for (const value of url.searchParams.values()) {
      if (/^https?:\/\//i.test(value.trim())) visit(value, depth + 1);
    }
  };
  visit(rawUrl, 0);
  return scopes.length > 0 ? scopes : null;
}

export function scopesAreBasic(scopes: readonly string[]): boolean {
  return scopes.length > 0 && scopes.every((scope) => BASIC_OAUTH_SCOPES.has(scope));
}

export function scrapeGoogleScopePhrases(text: string): string[] {
  const patterns: RegExp[] = [
    /see\s+(?:and\s+download|and\s+manage)\s+[^.\n]+/gi,
    /manage\s+(?:your|all|all\s+your)\s+(?:contacts|google\s+drive|photos|calendars?|tasks|mail|gmail|files|account|youtube)[^.\n]*/gi,
    /edit\s+(?:your|all)\s+(?:contacts|google\s+drive|photos|calendars?|tasks|mail|gmail|files)[^.\n]*/gi,
    /send\s+(?:email|mail|messages)\s+(?:on\s+your\s+behalf|as\s+you)[^.\n]*/gi,
    /view\s+(?:your|all|all\s+your)\s+(?:contacts|google\s+drive|photos|calendars?|tasks|mail|gmail|files|youtube|location\s+history)[^.\n]*/gi,
    /access\s+your\s+(?:google\s+drive|gmail|contacts|calendars?|photos|youtube)[^.\n]*/gi,
    /delete\s+(?:your|all)\s+[^.\n]+/gi,
  ];
  const matches = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      matches.add(match[0].slice(0, 80).trim());
    }
  }
  return Array.from(matches);
}
