export type GoogleAuthState = "chooser" | "consent" | "needs_login" | "challenge" | "not_google";

export function classifyGoogleAuthState(url: string, bodyText: string): GoogleAuthState {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "not_google";
  }
  if (!/(^|\.)accounts\.google\.com$/i.test(parsed.hostname)) return "not_google";
  const path = parsed.pathname.toLowerCase();
  const text = bodyText.toLowerCase();

  if (
    (path.includes("/challenge/") && !path.includes("/challenge/pwd")) ||
    text.includes("verify it's you") ||
    text.includes("verify it’s you") ||
    text.includes("2-step verification")
  ) {
    return "challenge";
  }
  if (
    path.includes("/accountchooser") ||
    path.includes("/chooser") ||
    path.includes("/signin/chooser") ||
    /\bchoose an account\b/.test(text)
  ) {
    return "chooser";
  }
  if (
    path.includes("/oauth/consent") ||
    path.includes("/signin/oauth") ||
    path.includes("/consent") ||
    text.includes("wants access to your google account") ||
    text.includes("wants to access your google account") ||
    (text.includes("to continue to") && (text.includes("allow") || text.includes("continue")))
  ) {
    return "consent";
  }
  return "needs_login";
}

export function extractGoogleNumberMatch(text: string): string | null {
  const m1 = text.match(/tap\s+(\d{1,3})\s+on\s+your/i);
  if (m1?.[1] !== undefined) return m1[1];
  const m2 = text.match(/\b(\d{1,3})\s+on\s+your\s+(?:phone|other\s+device)/i);
  if (m2?.[1] !== undefined) return m2[1];
  if (/match the number|tap the number|google wants to make sure/i.test(text)) {
    const digits = text.match(/\b\d{1,3}\b/g);
    if (digits !== null) return digits.find((digit) => digit.length === 2) ?? digits[0] ?? null;
  }
  return null;
}

export interface GoogleHumanChallenge {
  provider: "google";
  kind: "number_match" | "verification";
  attempt_id: string;
  challenge_revision: string;
  document_id: string;
  number: string | null;
  observed_at: string;
  expires_at: string | null;
}

export function extractGoogleHumanChallenge(input: {
  attemptId: string;
  challengeRevision: string;
  documentId: string;
  url: string;
  bodyText: string;
  observedAt: Date;
  expiresAt?: Date | null;
}): GoogleHumanChallenge | null {
  if (classifyGoogleAuthState(input.url, input.bodyText) !== "challenge") return null;
  const number = extractGoogleNumberMatch(input.bodyText);
  return {
    provider: "google",
    kind: number === null ? "verification" : "number_match",
    attempt_id: input.attemptId,
    challenge_revision: input.challengeRevision,
    document_id: input.documentId,
    number,
    observed_at: input.observedAt.toISOString(),
    expires_at: input.expiresAt?.toISOString() ?? null,
  };
}
