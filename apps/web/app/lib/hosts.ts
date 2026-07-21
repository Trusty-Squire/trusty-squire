// Host-input helpers shared by the vault create + edit forms. The server
// re-normalises every host on store (normaliseHost / normaliseLoginHosts), so
// these only tokenise what the user typed into a clean array — one
// implementation instead of the copy-pasted split/trim/dedupe that had drifted
// across three call sites.

// Split a newline/comma-separated hosts textarea into a deduped list.
export function parseHostList(text: string): string[] {
  return Array.from(
    new Set(text.split(/[\n,]/).map((h) => h.trim()).filter((h) => h.length > 0)),
  );
}

// A website login is entered as a single "sign-in URL or host". Derive the
// required login host and — when a full URL was given — the signin_url, so the
// form asks one intuitive question instead of overlapping login_hosts +
// signin_url fields. Bare host (optional path stripped) → just the host; full
// URL (has a scheme) → host + the URL as signin_url.
export function deriveLoginTarget(input: string): { host: string | null; signinUrl?: string } {
  const raw = input.trim();
  if (raw === "") return { host: null };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
      return host.length > 0 ? { host, signinUrl: raw } : { host: null };
    } catch {
      return { host: null };
    }
  }
  const host = raw.split("/")[0]!.trim().toLowerCase().replace(/^www\./, "");
  return host.length > 0 ? { host } : { host: null };
}
