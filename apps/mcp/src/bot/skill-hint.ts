// Render a registry Skill into a concise "route" the host frontier agent reads
// before driving — the missing map that stops it making ad-hoc decisions (the
// Grok-flail: try Google → "account exists" → tombstone → grab junk). A hint is
// best-effort guidance, NOT a script: the agent still drives; if the live page
// diverges it falls back to its own judgment.

import { canonicalizeServiceSlug, type Skill, type SkillStep } from "@trusty-squire/skill-schema";

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

export function renderSkillHint(skill: Skill): string {
  const lines: string[] = [
    `Known route for "${skill.service}" (from a registry skill — a MAP, not a ` +
      `script: drive toward it, fall back to your own judgment if the page diverges):`,
    `- entry: ${skill.signup_url}`,
  ];

  // Login method — the OAuth provider this service uses, or a form.
  const oauthStep = skill.steps.find(
    (s): s is Extract<SkillStep, { kind: "click_oauth_button" }> =>
      s.kind === "click_oauth_button",
  );
  lines.push(
    oauthStep !== undefined
      ? `- login: "Continue with ${oauthStep.provider}" (if the account already ` +
          `exists, log in that way — don't try to sign up again)`
      : `- login: email/password form`,
  );

  // Where the key lives + its shape, from the extract step.
  const extractStep = skill.steps.find(isExtractStep);
  if (extractStep !== undefined) {
    if ("near_text_hint" in extractStep && typeof extractStep.near_text_hint === "string") {
      lines.push(`- key location: near the text "${extractStep.near_text_hint}"`);
    } else if (extractStep.kind === "extract_via_copy_button") {
      lines.push(`- key: revealed/copied via a copy button on the keys page`);
    }
    if ("regex_name" in extractStep && typeof extractStep.regex_name === "string") {
      lines.push(`- key shape: matches the "${extractStep.regex_name}" pattern`);
    }
  }

  // Multi-credential services present more than one key — extract them all.
  if (Array.isArray(skill.credentials) && skill.credentials.length > 1) {
    lines.push(
      `- credentials: this service issues ${skill.credentials.length} — extract ALL of them, not just the first`,
    );
  }

  // A skill that exists means replay is the fast path — flag it.
  lines.push(
    `- if this run succeeds, a faster deterministic replay already exists for this service.`,
  );

  return lines.join("\n");
}
