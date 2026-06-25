import { describe, it, expect } from "vitest";
import type { Skill } from "@trusty-squire/skill-schema";
import { renderSkillHint, serviceSlugFromUrl } from "../skill-hint.js";

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

describe("renderSkillHint", () => {
  const hint = renderSkillHint(
    fixture({
      service: "vouchflow",
      signup_url: "https://vouchflow.dev",
      steps: [
        { kind: "click_oauth_button", provider: "google" },
        { kind: "extract_via_copy_button", near_text_hint: "Sandbox write key" },
      ] as unknown as Skill["steps"],
      credentials: [{}, {}] as unknown as Skill["credentials"],
    }),
  );

  it("names the service and entry url", () => {
    expect(hint).toContain('"vouchflow"');
    expect(hint).toContain("https://vouchflow.dev");
  });

  it("surfaces the login method", () => {
    expect(hint).toContain("Continue with google");
  });

  it("surfaces where the key lives", () => {
    expect(hint).toContain("Sandbox write key");
  });

  it("flags a multi-credential service", () => {
    expect(hint).toContain("2");
    expect(hint.toLowerCase()).toContain("extract all");
  });

  it("falls back to a form login when there is no oauth step", () => {
    const formHint = renderSkillHint(
      fixture({
        service: "resend",
        signup_url: "https://resend.com/signup",
        steps: [] as unknown as Skill["steps"],
        credentials: [{}] as unknown as Skill["credentials"],
      }),
    );
    expect(formHint).toContain("email/password form");
  });
});
