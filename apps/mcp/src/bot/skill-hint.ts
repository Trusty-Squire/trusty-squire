// Render a registry Skill into a concise "route" the host frontier agent reads
// before driving — the missing map that stops it making ad-hoc decisions (the
// Grok-flail: try Google → "account exists" → tombstone → grab junk). A hint is
// best-effort guidance, NOT a script: the agent still drives; if the live page
// diverges it falls back to its own judgment.

import { canonicalizeServiceSlug, type Skill, type SkillStep } from "@trusty-squire/skill-schema";
import type { OAuthProviderId } from "./oauth-providers.js";

// Login guidance built from the user's ACTUAL live sessions (the bot knows
// which providers are authenticated — detectSessionProviders), not the skill's
// recorded login (which reflects how the discoverer signed up). Google is
// preferred when multiple sessions exist. This is session-state, so it's
// composed at provision_start, separate from the skill route hint.
export function loginSessionGuidance(liveProviders: readonly OAuthProviderId[]): string {
  if (liveProviders.length === 0) {
    return (
      `- login: use whichever method the page offers (Google / GitHub / Microsoft / ` +
      `email). The account may already exist — log IN, don't re-sign-up.`
    );
  }
  const preferred: OAuthProviderId = liveProviders.includes("google")
    ? "google"
    : (liveProviders[0] as OAuthProviderId);
  const ordered = [preferred, ...liveProviders.filter((p) => p !== preferred)];
  return (
    `- login: the user has a LIVE session for ${ordered.join(", ")} — use "${preferred}" ` +
    `(preferred). The account may already exist; log IN with that provider, don't re-sign-up.`
  );
}

// The registry keys skills by canonical service slug; derive it from the URL the
// agent is provisioning so provision_start can look the skill up.
export function serviceSlugFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return canonicalizeServiceSlug(host);
  } catch {
    return null;
  }
}

function isExtractStep(s: SkillStep): boolean {
  return s.kind.startsWith("extract_via");
}

// Login/signup affordances to drop from the post-auth breadcrumb. The skill's
// recorded login is discoverer-specific (the housekeeper signs up via email
// alias; ~81% of skills carry no usable provider), so it is NOT prescribed —
// the agent picks whatever session the USER has. The durable, reusable value
// is the POST-auth navigation to the key.
const LOGIN_AFFORDANCE_RE =
  /\b(google|github|microsoft|gitlab|continue with|sign[\s-]?in|sign[\s-]?up|log[\s-]?in|create\s+(an?\s+|your\s+)?account|get started)\b/i;

// The navigation breadcrumb AFTER login — click labels + path segments that
// lead to the keys page. This is the part of the skill worth keeping.
export function postAuthBreadcrumb(steps: readonly SkillStep[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    if (out.length >= 6) break;
    if (s.kind === "click_oauth_button") continue;
    if (s.kind === "click" && typeof s.text_match === "string") {
      if (LOGIN_AFFORDANCE_RE.test(s.text_match)) continue;
      const t = s.text_match.trim();
      // A real nav label is short; a long capture (a row label with a date,
      // "Trusty Squire trusty-squire Web May 12, 2026 ›") is row noise — drop it.
      if (t.length > 0 && t.length <= 32) out.push(t);
    } else if (s.kind === "navigate" && "url" in s && typeof s.url === "string") {
      try {
        const p = new URL(s.url).pathname.replace(/\/$/, "");
        if (p.length > 0) out.push(p);
      } catch {
        /* skip malformed */
      }
    }
  }
  return out;
}

export function renderSkillHint(skill: Skill): string {
  const lines: string[] = [
    `Known route for "${skill.service}" — a MAP, not a script. Drive toward it; ` +
      `fall back to your own judgment if the live page diverges.`,
    `- entry: ${skill.signup_url}`,
    // NB: login guidance is NOT here — it's composed at provision_start from the
    // user's live sessions (loginSessionGuidance), because that's session-state,
    // not skill-state.
  ];

  // The durable value: the post-auth path to the key.
  const route = postAuthBreadcrumb(skill.steps);
  if (route.length > 0) {
    lines.push(`- after login, navigate: ${route.join(" → ")}`);
  }
  const extractStep = skill.steps.find(isExtractStep);
  if (extractStep !== undefined) {
    if ("near_text_hint" in extractStep && typeof extractStep.near_text_hint === "string") {
      lines.push(`- the key is near the text "${extractStep.near_text_hint}" (reveal/copy if masked)`);
    } else if (extractStep.kind === "extract_via_copy_button") {
      lines.push(`- the key is revealed/copied via a copy button on the keys page`);
    }
  }

  // Always exhort grab-all — the recorded credential count is a floor, not a
  // ceiling (most captures only grabbed one even when the service issues more).
  lines.push(
    `- extraction: grab EVERY credential-shaped value on the keys page ` +
      `(api key, secret, project/app id, token) — many services issue several; ` +
      `do NOT stop at the first.`,
  );

  return lines.join("\n");
}
