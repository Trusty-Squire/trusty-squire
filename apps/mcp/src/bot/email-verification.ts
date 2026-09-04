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
//
// A link candidate can carry its visible anchor text alongside the href. Many
// transactional-mail senders (SendGrid/Mailgun/Customer.io click trackers,
// Postmark link tracking) rewrite the href to an opaque per-recipient
// tracking URL on the SENDER's tracking domain — no verify/login/token
// vocabulary survives in the URL at all. The button's visible text ("Link
// Google account", "Verify email") is still the real signal in that case, so
// callers that have it (a rendered <a>, not a raw href string) should pass it.
export interface VerificationLinkCandidate {
  url: string;
  text?: string | null;
}

type LinkInput = string | VerificationLinkCandidate;

function asCandidate(link: LinkInput): VerificationLinkCandidate {
  return typeof link === "string" ? { url: link } : link;
}

// `expectedDomains` (optional) are hosts the caller already trusts for this
// verification (typically the service's own domain, from the sender address
// or the `sender` search hint) — a link on one of them (or a subdomain, e.g.
// `auth.xata.io` under `xata.io`) gets a small tie-breaking bonus. It never
// turns a negative/zero score positive on its own.
export function pickVerificationLink(
  links: readonly LinkInput[],
  expectedDomains?: readonly string[],
): string | null {
  const expected = (expectedDomains ?? []).map((d) => d.toLowerCase()).filter((d) => d.length > 0);
  const scored = links.map((raw, index) => {
    const { url: rawUrl, text: rawText } = asCandidate(raw);
    // Decode HTML-escaped separators BEFORE scoring so `&amp;token=` matches the
    // token heuristic below, not just at return time.
    const url = rawUrl.replace(/&amp;/gi, "&");
    const lower = url.toLowerCase();
    const text = (rawText ?? "").toLowerCase();
    // True when either the href or the anchor's visible text/label matches —
    // a click-tracking rewritten href (no vocabulary left in the URL at all)
    // still scores on what the button actually says.
    const hits = (re: RegExp): boolean => re.test(lower) || (text.length > 0 && re.test(text));
    let score = 0;
    if (isEmailAssetLink(lower)) score -= 50;
    // "marketing"/"footer" are checked in the anchor TEXT only, not the href —
    // a legit verify link commonly carries `&utm_campaign=marketing_email` and
    // would otherwise self-cancel.
    if (/unsubscribe|preferences/.test(lower) || /unsubscribe|preferences|footer|marketing/.test(text))
      score -= 10;
    // Explicit verification vocabulary — the strongest, unambiguous signal.
    if (hits(/verify|confirm/)) score += 10;
    if (hits(/activate|activation/)) score += 8;
    // Account-linking shapes (Keycloak's identity-broker "link your Google
    // account" flow: `/realms/…/broker/google/link?…` or
    // `/login-actions/action-token?key=…`, or a button reading "Link your
    // Google account") — a bare "link"/"login" URL scores lower than explicit
    // verify/confirm since it's a more generic word, but still positive so it
    // isn't dropped as found:false.
    if (
      /link[-_]?account|account[-_]?link|\/broker\/|\/link(?:$|[/?#])/.test(lower) ||
      /link\s+(?:your|this|google|account)|link\s+.*\baccount\b/.test(text)
    )
      score += 8;
    if (hits(/log[-_]?in\b|logon\b|sign[-_ ]?in\b/)) score += 6;
    // Magic-link / passwordless / auth-callback shapes. A verification link often
    // carries NONE of the words above: a Next.js app (Loops) emails a bare
    // `/api/auth/callback/email?token=…`, and Supabase/Clerk/Auth0 send
    // `/auth/…?token=…`. Without these two heuristics such a link scored 0 and was
    // dropped as `link:null` even though it was the only actionable link.
    if (/(?:\/auth\/|\/callback\/|magic[-_]?link|passwordless|sign[-_]?in)/.test(lower)) score += 6;
    if (
      /[?&](?:token|otp|oob[-_]?code|confirmation[-_]?token|verification[-_]?token|access[-_]?token|auth[-_]?token|key|code)=/.test(
        lower,
      )
    )
      score += 6;
    if (hits(/continue/)) score += 3;
    if (hits(/welcome/)) score += 3;
    if (expected.length > 0) {
      try {
        const host = new URL(url).hostname.toLowerCase();
        if (expected.some((d) => host === d || host.endsWith(`.${d}`))) score += 4;
      } catch {
        // Not an absolute URL — no host to compare, no bonus.
      }
    }
    return { url, score, index };
  });
  // Ties break to the LATER link. In a multi-message verification thread (Gmail
  // renders oldest→newest top-to-bottom, and a re-sent link supersedes older
  // ones), the freshest token is the last matching link — taking the first
  // handed back an EXPIRED token. MEASURED 2026-07-01 (Loops repeated logins).
  scored.sort((a, b) => b.score - a.score || b.index - a.index);
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
