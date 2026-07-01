import { describe, it, expect } from "vitest";
import type { Skill } from "@trusty-squire/skill-schema";
import { renderSkillHint, serviceSlugFromUrl, loginSessionGuidance } from "../skill-hint.js";

// renderSkillHint reads only a handful of Skill fields (service, signup_url,
// steps, credentials). A full valid Skill is heavy to construct; cast a minimal
// fixture carrying exactly those fields — the cast is scoped to the test.
function fixture(partial: Partial<Skill>): Skill {
  return partial as unknown as Skill;
}

describe("serviceSlugFromUrl", () => {
  it("derives a slug from a service URL", () => {
    expect(serviceSlugFromUrl("https://vouchflow.dev/signup")).not.toBeNull();
    expect(serviceSlugFromUrl("https://app.langwatch.ai/x")).not.toBeNull();
  });

  it("returns null on a malformed url", () => {
    expect(serviceSlugFromUrl("not a url")).toBeNull();
  });
});

describe("loginSessionGuidance", () => {
  it("prefers Google when the user has multiple live sessions", () => {
    const g = loginSessionGuidance(["github", "google"]);
    expect(g).toContain('prefer "google"');
    expect(g).toContain("live session for google, github");
  });

  it("uses the only live session when there's one", () => {
    expect(loginSessionGuidance(["github"])).toContain('prefer "github"');
  });

  it("hedges on the page offering OAuth — falls back to email if no button", () => {
    // Regression: telling the agent to use google on an email-only signup
    // (Postmark) sent it chasing a button that wasn't there.
    const g = loginSessionGuidance(["google"]).toLowerCase();
    expect(g).toContain("if the page offers");
    expect(g).toContain("email");
  });

  it("falls back to method-agnostic guidance when no live session", () => {
    const g = loginSessionGuidance([]);
    expect(g.toLowerCase()).toContain("whichever method");
    expect(g.toLowerCase()).toContain("log in");
  });

  it("always says log in, not re-sign-up", () => {
    expect(loginSessionGuidance(["google"]).toLowerCase()).toContain("don't re-sign-up");
  });
});

describe("renderSkillHint", () => {
  const hint = renderSkillHint(
    fixture({
      service: "vouchflow",
      signup_url: "https://vouchflow.dev",
      steps: [
        { kind: "click_oauth_button", provider: "google" },
        { kind: "click", text_match: "Settings" },
        { kind: "click", text_match: "API Keys" },
        { kind: "extract_via_copy_button", near_text_hint: "Sandbox write key" },
      ] as unknown as Skill["steps"],
      // Single-cred capture — the hint must STILL exhort grab-all.
      credentials: [{}] as unknown as Skill["credentials"],
    }),
  );

  it("names the service and entry url", () => {
    expect(hint).toContain('"vouchflow"');
    expect(hint).toContain("https://vouchflow.dev");
  });

  it("carries NO login line — login is composed from live sessions at start", () => {
    expect(hint).not.toContain("Continue with google");
    expect(hint).not.toContain("- login:");
  });

  it("surfaces the post-auth navigation breadcrumb (the durable value)", () => {
    expect(hint).toContain("Settings → API Keys");
  });

  it("surfaces where the key lives", () => {
    expect(hint).toContain("Sandbox write key");
  });

  it("always exhorts grab-all even for a single-cred capture", () => {
    expect(hint.toLowerCase()).toContain("every credential");
    expect(hint.toLowerCase()).toContain("do not stop at the first");
  });

  it("drops login/signup affordances from the breadcrumb", () => {
    const h = renderSkillHint(
      fixture({
        service: "x",
        signup_url: "https://x.ai",
        steps: [
          { kind: "click", text_match: "Sign up" },
          { kind: "click", text_match: "Continue with Google" },
          { kind: "click", text_match: "Team" },
          { kind: "extract_via_regex", regex_name: "generic_api_key" },
        ] as unknown as Skill["steps"],
        credentials: [{}] as unknown as Skill["credentials"],
      }),
    );
    expect(h).toContain("Team");
    expect(h).not.toContain("Sign up →");
    expect(h).not.toContain("Continue with Google →");
  });
});
