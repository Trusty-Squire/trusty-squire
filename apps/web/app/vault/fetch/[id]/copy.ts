// Copy helpers for the fetch-credential approval page. Kept beside the page
// rather than in the design system: the page is the only caller, and the
// humanization is a tiny acronym list, not a general label dictionary.

const ACRONYMS = new Set(["api", "id", "sid", "aws", "url", "http", "https", "otp", "jwt"]);

// A credential pasted as one lone secret is stored under the pseudo-field
// `value`, and a credential nobody renamed carries the label `default`.
// Neither is a name a human chose, so neither is a name to show one.
const ANONYMOUS_FIELD = "value";
const ANONYMOUS_LABEL = "default";

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
  const names = field === null ? fieldNames : [field];
  const labels = names.map(humanizeFieldKey);
  if (labels.length <= 1) return labels[0] ?? "secret";
  if (labels.length === 2) return labels.join(" and ");
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

export function revealQuestion(
  credential: { service: string | null; name: string },
  field: string | null,
  fieldNames: string[],
): string {
  const qualifiers = [
    credential.service,
    credential.name === ANONYMOUS_LABEL ? null : `(${credential.name})`,
  ];
  const anonymous = fieldNames.length === 1 && (field ?? fieldNames[0]) === ANONYMOUS_FIELD;
  const subject = (
    anonymous ? ["your", ...qualifiers, "secret"] : [...qualifiers, fieldLabel(field, fieldNames)]
  ).filter((part) => part !== null);
  return `Reveal ${subject.join(" ")} to your agent?`;
}

export function formatExpiryRemaining(expiresAt: string, nowMs = Date.now()): string {
  const remainingMs = new Date(expiresAt).getTime() - nowMs;
  const seconds = Math.max(0, Math.floor(remainingMs / 1000));
  if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export function consequenceLine(expiresAt: string, nowMs = Date.now(), fieldCount = 1): string {
  return (
    `Your agent sees ${fieldCount === 1 ? "this value" : "these values"} once, in clear, and ${fieldCount === 1 ? "it stays" : "they stay"} in that conversation. ` +
    `Expires in ${formatExpiryRemaining(expiresAt, nowMs)}.`
  );
}
