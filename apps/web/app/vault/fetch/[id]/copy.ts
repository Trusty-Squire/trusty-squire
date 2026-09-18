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

export function fieldLabel(field: string | null, fieldNames: string[]): string {
  if (field !== null && field.length > 0) return humanizeFieldKey(field);
  if (fieldNames.length === 1) return humanizeFieldKey(fieldNames[0]!);
  if (fieldNames.length > 1) return fieldNames.map(humanizeFieldKey).join(", ");
  return "";
}

export function revealQuestion(
  service: string | null,
  field: string | null,
  fieldNames: string[],
): string {
  const label = fieldLabel(field, fieldNames);
  const subject = [service, label].filter((part) => part !== null && part !== "").join(" ");
  return `Reveal ${subject.length > 0 ? subject : "this secret"} to your agent?`;
}

export function requestedByLine(
  requestedBy: string | null | undefined,
  reason: string | null | undefined,
): string | null {
  const who = requestedBy?.trim() ?? "";
  const why = reason?.trim() ?? "";
  if (who.length > 0 && why.length > 0) return `Requested by ${who} · ${why}`;
  if (who.length > 0) return `Requested by ${who}`;
  if (why.length > 0) return why;
  return null;
}

export function formatExpiryRemaining(expiresAt: string, nowMs = Date.now()): string {
  const remainingMs = new Date(expiresAt).getTime() - nowMs;
  const seconds = Math.max(0, Math.floor(remainingMs / 1000));
  if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

export function consequenceLine(expiresAt: string, nowMs = Date.now()): string {
  return (
    "Your agent sees this value once, in clear, and it stays in that conversation. " +
    `Expires in ${formatExpiryRemaining(expiresAt, nowMs)}.`
  );
}
