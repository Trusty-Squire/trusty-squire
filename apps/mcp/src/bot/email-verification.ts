// email-verification.ts — choose which link in a verification email to click.
// Carved out of agent.ts (the retired universal-bot monolith); the provision
// session uses this to follow the confirm/activate link without navigating to
// an unsubscribe or asset URL.

// Choose which link in a verification email to click. Scores each URL
// by keyword and picks the best — but only if it scored positive.
//
// The all-negative case is the bug this guards: an email whose only
// links are unsubscribe/preferences scores <= 0 everywhere, and an
// earlier version returned links[0] anyway, navigating the bot straight
// to an unsubscribe URL.
export function pickVerificationLink(links: readonly string[]): string | null {
  const scored = links.map((url) => {
    const lower = url.toLowerCase();
    let score = 0;
    if (isEmailAssetLink(lower)) score -= 50;
    if (lower.includes("verify") || lower.includes("confirm")) score += 10;
    if (lower.includes("activate")) score += 8;
    if (lower.includes("welcome")) score += 3;
    if (lower.includes("unsubscribe") || lower.includes("preferences")) score -= 10;
    return { url, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  return top !== undefined && top.score > 0
    ? top.url.replace(/&amp;/gi, "&")
    : null;
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
