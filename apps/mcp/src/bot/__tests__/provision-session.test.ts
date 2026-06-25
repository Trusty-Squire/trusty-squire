import { describe, it, expect } from "vitest";
import type { InteractiveElement } from "../browser.js";
import {
  resolveTarget,
  hostAllowed,
  elementRef,
  parseVerification,
  looksLikeCodeIdentifier,
  findCredentialTokens,
  detectExtractionBlock,
  buildScreenOutline,
  provisionPerceptionGuidance,
  shouldBlockUnsafeProvisionAction,
} from "../provision-session.js";

// Minimal InteractiveElement factory — only the fields targeting reads matter;
// the rest get inert defaults so the fixtures stay readable.
function el(partial: Partial<InteractiveElement>): InteractiveElement {
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
    selector: "button",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...partial,
  };
}

describe("elementRef", () => {
  it("prefers visibleText, then falls back through the label chain", () => {
    expect(elementRef(el({ visibleText: "Continue with Google" }))).toBe("Continue with Google");
    expect(elementRef(el({ visibleText: null, ariaLabel: "Show key" }))).toBe("Show key");
    expect(elementRef(el({ visibleText: null, placeholder: "Organization name" }))).toBe(
      "Organization name",
    );
  });

  it("falls back to tag#index when there is no label at all", () => {
    expect(elementRef(el({ tag: "input", index: 7 }))).toBe("input#7");
  });
});

describe("resolveTarget", () => {
  const inv = [
    el({ index: 0, visibleText: "Continue with Google", selector: "#g" }),
    el({ index: 1, visibleText: "Continue with GitHub", selector: "#gh" }),
    el({ index: 2, visibleText: "Next", selector: "#next" }),
    el({ index: 3, tag: "input", placeholder: "Email", selector: "#email" }),
  ];

  it("matches exact label", () => {
    expect(resolveTarget(inv, "Next")?.selector).toBe("#next");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolveTarget(inv, "  continue with google  ")?.selector).toBe("#g");
  });

  it("disambiguates similar prefixes to the closest match", () => {
    // "Continue with GitHub" must not collapse onto the Google entry.
    expect(resolveTarget(inv, "Continue with GitHub")?.selector).toBe("#gh");
  });

  it("matches a placeholder-only input by contains", () => {
    expect(resolveTarget(inv, "email")?.selector).toBe("#email");
  });

  it("returns null when nothing matches", () => {
    expect(resolveTarget(inv, "Submit invoice")).toBeNull();
  });

  it("returns null for an empty target", () => {
    expect(resolveTarget(inv, "   ")).toBeNull();
  });

  it("prefers the shorter (more specific) label at equal score", () => {
    const two = [
      el({ visibleText: "Create", selector: "#short" }),
      el({ visibleText: "Create API key now", selector: "#long" }),
    ];
    expect(resolveTarget(two, "Create")?.selector).toBe("#short");
  });

  it("can target a repeated label by its screen path", () => {
    const two = [
      el({
        visibleText: "Create account",
        selector: "#background-create",
        screenPath: "main:dashboard > button:create-account",
      }),
      el({
        visibleText: "Create account",
        selector: "#modal-create",
        screenPath: "dialog:finish-account > button:create-account",
      }),
    ];

    expect(resolveTarget(two, "dialog:finish-account > button:create-account")?.selector).toBe(
      "#modal-create",
    );
  });
});

describe("parseVerification (email OTP + link extraction)", () => {
  it("prefers a code adjacent to an OTP keyword", () => {
    const text = "Your order 1842 shipped. Your verification code is 503914. Thanks.";
    expect(parseVerification(text, []).code).toBe("503914");
  });

  it("matches a code that precedes the keyword", () => {
    expect(parseVerification("Enter 284619 to verify your email", []).code).toBe("284619");
  });

  it("falls back to a standalone 4-8 digit run when no keyword is present", () => {
    expect(parseVerification("Your one time pin: 9087", []).code).toBe("9087");
  });

  it("returns null code when there is no plausible OTP", () => {
    expect(parseVerification("Welcome to the service! Get started now.", []).code).toBeNull();
  });

  it("picks a verification link from the mail's hrefs", () => {
    const links = [
      "https://mail.google.com/settings",
      "https://resend.com/verify-email?token=abc123def456",
    ];
    expect(parseVerification("Click to confirm your email", links).link).toContain("resend.com");
  });

  it("returns both code and link when present", () => {
    const r = parseVerification("Your code 778201. Or click https://x.com/confirm?t=zz", [
      "https://x.com/confirm?t=zz",
    ]);
    expect(r.code).toBe("778201");
    expect(r.link).toContain("confirm");
  });
});

describe("looksLikeCodeIdentifier (false-green guard)", () => {
  it("rejects the X-tombstone JS function name that leaked as a key", () => {
    expect(looksLikeCodeIdentifier("loader.tweetUnavailableTombstoneHandler")).toBe(true);
  });

  it("accepts real prefixed keys (no dots)", () => {
    expect(looksLikeCodeIdentifier("xai-abc123DEF456ghi789")).toBe(false);
    expect(looksLikeCodeIdentifier("vsk_sandbox_write_20af25f2668a65ae")).toBe(false);
    expect(looksLikeCodeIdentifier("sk-lw-QQgBj9Z2abcdefghij")).toBe(false);
  });

  it("accepts a JWT despite its dots (eyJ prefix)", () => {
    expect(looksLikeCodeIdentifier("eyJhbGciOi.eyJzdWIiOi.sigPart")).toBe(false);
  });
});

describe("findCredentialTokens (multi-credential extraction)", () => {
  it("finds both VouchFlow keys of the same shape", () => {
    const page =
      "Sandbox write key vsk_sandbox_write_20af25f2668a65ae268625ab2235e765 " +
      "Sandbox read key vsk_sandbox_read_02ae44b1c9d3e6f7a8b9c0d1e2f3a4b5";
    const toks = findCredentialTokens(page);
    expect(toks).toContain("vsk_sandbox_write_20af25f2668a65ae268625ab2235e765");
    expect(toks).toContain("vsk_sandbox_read_02ae44b1c9d3e6f7a8b9c0d1e2f3a4b5");
  });

  it("does NOT pick up the dotted function-name false positive", () => {
    expect(findCredentialTokens("loader.tweetUnavailableTombstoneHandler")).toEqual([]);
  });

  it("ignores prose and short/digitless tokens", () => {
    expect(findCredentialTokens("Welcome to your dashboard. Get started now.")).toEqual([]);
    // has a separator but no digit → not a key
    expect(findCredentialTokens("user_account_settings_panel")).toEqual([]);
  });
});

describe("detectExtractionBlock (fail-closed on a login wall)", () => {
  it("flags X's anti-bot tombstone (the Grok false-green source)", () => {
    const tombstone = "JavaScript is not available.\nWe've detected that JavaScript is disabled in this browser.";
    expect(detectExtractionBlock(tombstone)).not.toBeNull();
    expect(detectExtractionBlock(tombstone)).toContain("login_wall");
  });

  it("flags the Cloudflare 'Just a moment' interstitial", () => {
    expect(detectExtractionBlock("Just a moment...\nVerifying you are human.")).not.toBeNull();
  });

  it("does NOT flag a real keys page that merely mentions enabling JavaScript", () => {
    // A long, content-rich page is not a wall even if the phrase appears in a footer.
    const realPage =
      "Your API keys\nProduction key sk-live-abc123def456ghi789\n".repeat(20) +
      "Note: enable JavaScript for the best experience.";
    expect(detectExtractionBlock(realPage)).toBeNull();
  });

  it("returns null for an ordinary short dashboard with a key", () => {
    expect(detectExtractionBlock("Dashboard\nAPI key: xai-abc123DEF456ghi789")).toBeNull();
  });
});

describe("hostAllowed (gates only agent-initiated goto)", () => {
  const allowed = ["langwatch.ai"];

  it("allows the target host and its subdomains", () => {
    expect(hostAllowed("https://langwatch.ai/onboarding", allowed)).toBe(true);
    expect(hostAllowed("https://app.langwatch.ai/x", allowed)).toBe(true);
  });

  it("allows default identity-provider hosts", () => {
    expect(hostAllowed("https://accounts.google.com/o/oauth2/auth", allowed)).toBe(true);
    expect(hostAllowed("https://github.com/login/oauth", allowed)).toBe(true);
  });

  it("allows firebase/web.app auth handlers", () => {
    expect(hostAllowed("https://medalis-ecaf7.firebaseapp.com/__/auth/handler", allowed)).toBe(
      true,
    );
  });

  it("blocks an unrelated host", () => {
    expect(hostAllowed("https://evil.example.com/steal", allowed)).toBe(false);
  });

  it("blocks a malformed url", () => {
    expect(hostAllowed("not a url", allowed)).toBe(false);
  });

  it("honors extra allowed hosts", () => {
    expect(hostAllowed("https://mail.proton.me/inbox", ["langwatch.ai", "mail.proton.me"])).toBe(
      true,
    );
  });
});

describe("provision perception guidance", () => {
  it("warns not to restart OAuth when app/test-mode UI is visible behind account overlay", () => {
    const guidance = provisionPerceptionGuidance(
      "Finish creating your account Create account CP Cactus Practice Test mode Products",
    );

    expect(guidance).toContain("Mode marker visible");
    expect(guidance).toContain("account/setup overlay");
    expect(guidance).toContain("authenticated app markers");
    expect(guidance).toContain("Do not restart OAuth");
  });

  it("guards billing creation actions when live mode is visible", () => {
    const reason = shouldBlockUnsafeProvisionAction(
      "Dashboard Products Live mode",
      { kind: "click", target: "Save product" },
    );

    expect(reason).toContain("live/production mode is visible");
  });

  it("allows billing creation actions when test mode is visible", () => {
    expect(
      shouldBlockUnsafeProvisionAction(
        "Dashboard Products Test mode",
        { kind: "click", target: "Save product" },
      ),
    ).toBeNull();
  });

  it("blocks dead-end account overlay actions when authenticated app UI is visible", () => {
    const reason = shouldBlockUnsafeProvisionAction(
      "Finish creating your account Create account CP Cactus Practice Test mode Products",
      { kind: "click", target: "Create account" },
    );

    expect(reason).toContain("Perception guard");
    expect(reason).toContain("authenticated app markers");
  });

  it("does not guard unrelated non-creation clicks", () => {
    expect(
      shouldBlockUnsafeProvisionAction(
        "Dashboard Products Live mode",
        { kind: "click", target: "Products" },
      ),
    ).toBeNull();
  });

  it("does not mistake a single marketing nav word for an authenticated app", () => {
    expect(
      shouldBlockUnsafeProvisionAction(
        "Products Pricing Docs Create account",
        { kind: "click", target: "Create account" },
      ),
    ).toBeNull();
  });
});

describe("buildScreenOutline", () => {
  it("groups elements by DOM region and marks the foreground dialog", () => {
    const outline = buildScreenOutline(
      [
        el({
          visibleText: "Products",
          selector: "#products",
          role: "link",
          href: "/test/products",
          screenPath: "main:dashboard > link:products",
          container: "main:dashboard",
          topmost: false,
          occludedBy: "dialog:finish-account",
        }),
        el({
          visibleText: "Create account",
          selector: "#create",
          role: "button",
          screenPath: "dialog:finish-account > button:create-account",
          container: "dialog:finish-account",
          topmost: true,
        }),
      ],
      "Finish creating your account Test mode Products",
    );

    expect(outline?.foreground).toBe("dialog:finish-account");
    expect(outline?.mode_markers).toEqual(["test/sandbox mode"]);
    expect(outline?.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "main:dashboard",
          occluded_by: "dialog:finish-account",
          children: [
            expect.objectContaining({
              ref: "main:dashboard > link:products",
              occluded_by: "dialog:finish-account",
            }),
          ],
        }),
        expect.objectContaining({
          id: "dialog:finish-account",
          topmost: true,
          children: [
            expect.objectContaining({
              ref: "dialog:finish-account > button:create-account",
              topmost: true,
            }),
          ],
        }),
      ]),
    );
  });
});
