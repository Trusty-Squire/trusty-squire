// email-verification.ts — choose which link in a verification email to click.
// The provision session uses this to follow the confirm/activate link without
// navigating to an unsubscribe or asset URL.

// Choose which link in a verification email to click. Scores each URL
// by keyword and picks the best — but only if it scored positive.
//
// The all-negative case is the bug this guards: an email whose only
// links are unsubscribe/preferences scores <= 0 everywhere, and an
// earlier version returned links[0] anyway, navigating the bot straight
// to an unsubscribe URL.
export function pickVerificationLink(links: readonly string[]): string | null {
  const scored = links.map((raw) => {
    // Decode HTML-escaped separators BEFORE scoring so `&amp;token=` matches the
    // token heuristic below, not just at return time.
    const url = raw.replace(/&amp;/gi, "&");
    const lower = url.toLowerCase();
    let score = 0;
    if (isEmailAssetLink(lower)) score -= 50;
    if (lower.includes("unsubscribe") || lower.includes("preferences")) score -= 10;
    // Explicit verification vocabulary — the strongest, unambiguous signal.
    if (lower.includes("verify") || lower.includes("confirm")) score += 10;
    if (lower.includes("activate") || lower.includes("activation")) score += 8;
    // Magic-link / passwordless / auth-callback shapes. A verification link often
    // carries NONE of the words above: a Next.js app (Loops) emails a bare
    // `/api/auth/callback/email?token=…`, and Supabase/Clerk/Auth0 send
    // `/auth/…?token=…`. Without these two heuristics such a link scored 0 and was
    // dropped as `link:null` even though it was the only actionable link.
    if (/(?:\/auth\/|\/callback\/|magic[-_]?link|passwordless|sign[-_]?in)/.test(lower)) score += 6;
    if (
      /[?&](?:token|otp|oob[-_]?code|confirmation[-_]?token|verification[-_]?token|access[-_]?token|auth[-_]?token|code)=/.test(
        lower,
      )
    )
      score += 6;
    if (lower.includes("welcome")) score += 3;
    return { url, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  return top !== undefined && top.score > 0 ? top.url : null;
}

function isEmailAssetLink(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl.replace(/&amp;/g, "&"));
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    return (
      /\.(?:png|jpe?g|gif|webp|svg|ico|css|woff2?|ttf|otf)(?:$|[?#])/.test(path) ||
      /^(?:static|cdn|assets|images|img|media)\./.test(host) ||
      /\/(?:static|assets|images|img|media)\//.test(path)
    );
  } catch {
    return false;
  }
}
