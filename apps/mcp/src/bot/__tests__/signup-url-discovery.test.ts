// Covers the two pure helpers that drive the new signup-URL
// discovery: `guessSignupUrl` (the canonical-URL guess used when the
// caller doesn't pass `signup_url`) and `isGoogleSearchUrl` (the
// fallback predicate). The full agent flow that uses them is exercised
// live; these are the deterministic pieces unit tests can pin.

import { describe, expect, it } from "vitest";
import {
  detectAlreadySignedIn,
  detectAntiBotBlock,
  firstHttpsUrl,
  guessSignupUrl,
  isGoogleSearchUrl,
  resolveSignupUrl,
} from "../agent.js";
import type { InteractiveElement } from "../browser.js";
import type { LLMClient, LLMResponse } from "../llm-client.js";

// Stub LLMClient that returns a canned text (or throws), counting calls.
function stubLLM(
  reply: string | (() => Promise<LLMResponse>),
  calls: { n: number } = { n: 0 },
): LLMClient {
  return {
    name: "stub",
    async createMessage() {
      calls.n += 1;
      if (typeof reply === "function") return reply();
      return { text: reply, backend: "stub" };
    },
  };
}

function mkEl(over: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0,
    tag: "button",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: null,
    labelText: null,
    visibleText: null,
    selector: "#x",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...over,
  };
}

describe("guessSignupUrl", () => {
  it("returns https://<name>.com/signup for the common dev-SaaS pattern", () => {
    expect(guessSignupUrl("Resend")).toBe("https://resend.com/signup");
    expect(guessSignupUrl("Postmark")).toBe("https://postmark.com/signup");
    expect(guessSignupUrl("IPInfo")).toBe("https://ipinfo.com/signup");
  });

  it("strips spaces, punctuation, and case", () => {
    expect(guessSignupUrl("Mail Gun")).toBe("https://mailgun.com/signup");
    expect(guessSignupUrl("Stack-Auth")).toBe("https://stackauth.com/signup");
    expect(guessSignupUrl("send.grid")).toBe("https://sendgrid.com/signup");
  });

  it("handles single-word lowercase already", () => {
    expect(guessSignupUrl("resend")).toBe("https://resend.com/signup");
  });

  // guessSignupUrl is now the LAST-resort fallback only — the KNOWN_DOMAINS
  // table was retired. Non-.com TLDs and non-obvious entry points are
  // resolved upstream by resolveSignupUrl (promoted-skill URL → model), so
  // even a service that lives on .io returns the .com guess from THIS
  // function; a wrong guess is recovered by the Google-search fallback.
  it("returns the .com guess even for non-.com products (resolved upstream now)", () => {
    expect(guessSignupUrl("Sentry")).toBe("https://sentry.com/signup");
    expect(guessSignupUrl("Railway")).toBe("https://railway.com/signup");
  });
});

describe("firstHttpsUrl", () => {
  it("extracts a bare URL", () => {
    expect(firstHttpsUrl("https://xata.io/signup")).toBe("https://xata.io/signup");
  });
  it("extracts a URL embedded in prose, trimming trailing punctuation", () => {
    expect(firstHttpsUrl("The signup page is https://fly.io/app/sign-up.")).toBe(
      "https://fly.io/app/sign-up",
    );
  });
  it("returns null when there's no URL", () => {
    expect(firstHttpsUrl("UNKNOWN")).toBeNull();
    expect(firstHttpsUrl("I'm not sure")).toBeNull();
  });
});

describe("resolveSignupUrl", () => {
  it("uses the model's resolved URL (the .io/.xyz fix)", async () => {
    expect(await resolveSignupUrl("xata", stubLLM("https://xata.io/signup"))).toBe(
      "https://xata.io/signup",
    );
    expect(await resolveSignupUrl("hyperbolic", stubLLM("https://app.hyperbolic.xyz/signup"))).toBe(
      "https://app.hyperbolic.xyz/signup",
    );
  });

  it("extracts the URL when the model wraps it in prose", async () => {
    expect(
      await resolveSignupUrl("xata", stubLLM("Sure — it's https://xata.io/signup")),
    ).toBe("https://xata.io/signup");
  });

  it("falls back to the .com guess when the model says UNKNOWN", async () => {
    expect(await resolveSignupUrl("obscurething", stubLLM("UNKNOWN"))).toBe(
      "https://obscurething.com/signup",
    );
  });

  it("falls back to the .com guess when the model call throws", async () => {
    const llm = stubLLM(() => Promise.reject(new Error("rate limited")));
    expect(await resolveSignupUrl("obscurething", llm)).toBe(
      "https://obscurething.com/signup",
    );
  });

  it("with no LLM wired, degrades to the .com guess", async () => {
    expect(await resolveSignupUrl("obscurething", null)).toBe(
      "https://obscurething.com/signup",
    );
    expect(await resolveSignupUrl("Sentry", undefined)).toBe("https://sentry.com/signup");
  });

  it("logs the resolved URL via the optional logger", async () => {
    const lines: string[] = [];
    await resolveSignupUrl("xata", stubLLM("https://xata.io/signup"), {
      log: (m) => lines.push(m),
    });
    expect(lines.some((l) => l.includes("xata.io/signup"))).toBe(true);
  });

  it("prefers a promoted skill's URL over the model (registry beats LLM)", async () => {
    const calls = { n: 0 };
    const llm = stubLLM("https://wrong.example/signup", calls);
    const url = await resolveSignupUrl("xata", llm, {
      lookupSkillUrl: async () => "https://xata.io/app/signup",
    });
    expect(url).toBe("https://xata.io/app/signup");
    expect(calls.n).toBe(0); // a verified skill URL never spends an LLM call
  });

  it("falls through to the model when the skill lookup returns null", async () => {
    const url = await resolveSignupUrl("xata", stubLLM("https://xata.io/signup"), {
      lookupSkillUrl: async () => null,
    });
    expect(url).toBe("https://xata.io/signup");
  });

  it("falls through to the model when the skill lookup throws", async () => {
    const url = await resolveSignupUrl("xata", stubLLM("https://xata.io/signup"), {
      lookupSkillUrl: async () => {
        throw new Error("registry unavailable");
      },
    });
    expect(url).toBe("https://xata.io/signup");
  });

});

describe("detectAntiBotBlock", () => {
  it("detects Cloudflare 'Just a moment...' interstitial", () => {
    expect(
      detectAntiBotBlock(
        '<title>Just a moment...</title><body class="cf-challenge">Performing security verification</body>',
      ),
    ).toBe("Cloudflare");
    expect(
      detectAntiBotBlock("<body>Just a moment... dash.cloudflare.com</body>"),
    ).toBe("Cloudflare");
  });

  it("detects Sucuri / DataDome / Imperva interstitials", () => {
    expect(detectAntiBotBlock("<body>Sucuri Website Firewall</body>")).toBe("Sucuri");
    expect(detectAntiBotBlock('<div class="dd-captcha">solve me</div>')).toBe("DataDome");
    expect(detectAntiBotBlock("<title>Powered by Imperva</title>")).toBe("Imperva");
  });

  it("returns null on a normal signup page", () => {
    expect(
      detectAntiBotBlock(
        '<form><input type="email" name="email" /><button>Sign up</button></form>',
      ),
    ).toBeNull();
    expect(detectAntiBotBlock("")).toBeNull();
  });
});

describe("isGoogleSearchUrl", () => {
  it("matches www.google.com/search and bare google.com/search", () => {
    expect(isGoogleSearchUrl("https://www.google.com/search?q=Resend")).toBe(true);
    expect(isGoogleSearchUrl("https://google.com/search?q=Postmark")).toBe(true);
  });

  it("rejects other Google paths and other domains", () => {
    expect(isGoogleSearchUrl("https://www.google.com/")).toBe(false);
    expect(isGoogleSearchUrl("https://accounts.google.com/signin")).toBe(false);
    expect(isGoogleSearchUrl("https://resend.com/signup")).toBe(false);
    expect(isGoogleSearchUrl("not-a-url")).toBe(false);
  });
});

describe("detectAlreadySignedIn (F17)", () => {
  const SIGNUP_URL = "https://example.com/signup";
  const LOGIN_URL = "https://example.com/login";
  const DASHBOARD_URL = "https://example.com/dashboard";
  const NEW_URL = "https://railway.com/new";

  it("fires when dashboard markers present and no credential inputs", () => {
    expect(
      detectAlreadySignedIn({
        url: DASHBOARD_URL,
        inventory: [
          mkEl({ tag: "a", visibleText: "Dashboard" }),
          mkEl({ tag: "a", visibleText: "Projects" }),
          mkEl({ tag: "button", visibleText: "Sign out" }),
        ],
      }),
    ).toBe(true);
  });

  it("does NOT fire when an email or password input is present", () => {
    expect(
      detectAlreadySignedIn({
        url: SIGNUP_URL,
        inventory: [
          mkEl({ tag: "a", visibleText: "Dashboard" }),
          mkEl({ tag: "input", type: "email", visibleText: null }),
        ],
      }),
    ).toBe(false);
    expect(
      detectAlreadySignedIn({
        url: SIGNUP_URL,
        inventory: [
          mkEl({ tag: "button", visibleText: "Sign out" }),
          mkEl({ tag: "input", type: "password" }),
        ],
      }),
    ).toBe(false);
  });

  it("does NOT fire on a true sign-up page (no auth markers)", () => {
    expect(
      detectAlreadySignedIn({
        url: SIGNUP_URL,
        inventory: [
          mkEl({ tag: "button", visibleText: "Continue with Google" }),
          mkEl({ tag: "button", visibleText: "Sign up" }),
          mkEl({ tag: "a", visibleText: "Home" }),
        ],
      }),
    ).toBe(false);
  });

  it("matches Sign out / Log out / Workspaces / Settings", () => {
    for (const text of ["Sign out", "Log out", "Workspaces", "Settings", "My Account"]) {
      expect(
        detectAlreadySignedIn({
          url: LOGIN_URL,
          inventory: [mkEl({ tag: "a", visibleText: text })],
        }),
        `should fire on "${text}"`,
      ).toBe(true);
    }
  });

  // rc.18 — Railway's /new project-creation page has none of the
  // strict nav keywords. The only post-login signal is the "$X.XX
  // left / Trial" billing widget. Signal 2 (billing) covers this.
  it("fires on a billing/trial widget even without nav keywords", () => {
    expect(
      detectAlreadySignedIn({
        url: NEW_URL,
        inventory: [
          mkEl({ tag: "button", visibleText: "New project" }),
          mkEl({ tag: "button", visibleText: "28 days or $5.00 leftTrial" }),
        ],
      }),
    ).toBe(true);
  });

  it("fires on dashboard URL + creation CTA without billing widget", () => {
    // Signal 3 alone.
    expect(
      detectAlreadySignedIn({
        url: NEW_URL,
        inventory: [
          mkEl({ tag: "button", visibleText: "New project" }),
          mkEl({ tag: "a", visibleText: "Templates" }),
        ],
      }),
    ).toBe(true);
  });

  it("does NOT fire on /signup with a 'Create account' CTA — would otherwise false-positive", () => {
    // The URL gate excludes /signup paths so a Create button there
    // doesn't trip the dashboard+CTA signal.
    expect(
      detectAlreadySignedIn({
        url: SIGNUP_URL,
        inventory: [
          mkEl({ tag: "button", visibleText: "Create account" }),
        ],
      }),
    ).toBe(false);
  });

  it("does NOT fire when only a billing-shaped string but no signal-1/3 — must respect input precondition", () => {
    // Email input still beats billing.
    expect(
      detectAlreadySignedIn({
        url: NEW_URL,
        inventory: [
          mkEl({ tag: "input", type: "email" }),
          mkEl({ tag: "button", visibleText: "Trial $5.00 left" }),
        ],
      }),
    ).toBe(false);
  });

  // 0.8.2-rc.5 — PostHog regression. The bot navigated to
  // https://app.posthog.com/signup which auto-redirected to
  // us.posthog.com/project/440416/onboarding for the already-signed-in
  // user. None of signal 1/2/3 matched, so the bot bailed
  // `oauth_required`. The wizard's only affordances are project picker
  // + account avatar + "Hand off setup" — a strong post-auth signal.
  describe("PostHog-class onboarding wizard (TS-1923)", () => {
    const POSTHOG_URL =
      "https://us.posthog.com/project/440416/onboarding?next=%2Fhome";

    it("fires on a 'Hand off setup' skip-onboarding affordance", () => {
      expect(
        detectAlreadySignedIn({
          url: POSTHOG_URL,
          inventory: [
            mkEl({ tag: "button", visibleText: "Default project" }),
            mkEl({ tag: "button", visibleText: "BBento" }),
            mkEl({ tag: "button", visibleText: "Hand off setup" }),
          ],
        }),
      ).toBe(true);
    });

    it("fires on 'Skip onboarding' / 'Continue to dashboard'", () => {
      for (const text of [
        "Skip onboarding",
        "Skip for now",
        "Continue to dashboard",
        "Continue to app",
        "Invite teammates",
        "Finish setup",
      ]) {
        expect(
          detectAlreadySignedIn({
            url: POSTHOG_URL,
            inventory: [mkEl({ tag: "button", visibleText: text })],
          }),
          `should fire on "${text}"`,
        ).toBe(true);
      }
    });

    it("fires on workspace-picker pattern with no signup/OAuth affordance", () => {
      // Backstop signal — a project/workspace picker visible and no
      // signup/oauth CTA is highly indicative of authenticated state.
      expect(
        detectAlreadySignedIn({
          url: POSTHOG_URL,
          inventory: [
            mkEl({ tag: "button", visibleText: "Default project" }),
            mkEl({ tag: "a", visibleText: "Settings" }),
          ],
        }),
      ).toBe(true);
    });

    it("does NOT fire when both a workspace label AND a signup affordance are present", () => {
      // A signup chooser page that mentions "project" should not trip
      // the backstop signal.
      expect(
        detectAlreadySignedIn({
          url: POSTHOG_URL,
          inventory: [
            mkEl({ tag: "button", visibleText: "Continue with Google" }),
            mkEl({ tag: "a", visibleText: "Your project starts here" }),
          ],
        }),
      ).toBe(false);
    });

    it("respects the credential-input precondition (no fire even with handoff button)", () => {
      // Email/password input visible → not authenticated, no matter
      // what dashboard-y affordance is also present.
      expect(
        detectAlreadySignedIn({
          url: POSTHOG_URL,
          inventory: [
            mkEl({ tag: "input", type: "email" }),
            mkEl({ tag: "button", visibleText: "Hand off setup" }),
          ],
        }),
      ).toBe(false);
    });
  });
});
