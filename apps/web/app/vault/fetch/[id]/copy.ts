// Copy helpers for the fetch-credential approval page. Kept beside the page
// rather than in the design system: the page is the only caller, and the
// humanization is a tiny acronym list, not a general label dictionary.

const ACRONYMS = new Set(["api", "id", "sid", "aws", "url", "http", "https", "otp", "jwt"]);

export function humanizeFieldKey(key: string): string {
  return key
    .split(/[_-\s]+/)
    .filter((word) => word.length > 0)
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      if (index === 0) return lower.charAt(0).toUpperCase() + lower.slice(1);
      return lower;
    })
    .join(" ");
}

// The route settles field selection before minting, refusing a multi-field
// credential with no field named — so the ceremony always describes exactly
// one field: the one the agent named, or the credential's only one.
export function fieldLabel(field: string | null, fieldNames: string[]): string {
  return humanizeFieldKey(field ?? fieldNames[0]!);
}

export function revealQuestion(
  service: string | null,
  field: string | null,
  fieldNames: string[],
): string {
  const label = fieldLabel(field, fieldNames);
  return `Reveal ${service === null ? label : `${service} ${label}`} to your agent?`;
}

// The agent is the authenticated requester the approval was minted under, so
// there is always one to name; only the stated reason is optional.
export function requestedByLine(agent: string, reason: string | null): string {
  const why = reason?.trim() ?? "";
  return why.length > 0 ? `Requested by ${agent} · ${why}` : `Requested by ${agent}`;
}

export function formatExpiryRemaining(expiresAt: string, nowMs = Date.now()): string {
  const remainingMs = new Date(expiresAt).getTime() - nowMs;
  const seconds = Math.max(0, Math.floor(remainingMs / 1000));
  if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export function consequenceLine(expiresAt: string, nowMs = Date.now()): string {
  return (
    "Your agent sees this value once, in clear, and it stays in that conversation. " +
    `Expires in ${formatExpiryRemaining(expiresAt, nowMs)}.`
  );
}
