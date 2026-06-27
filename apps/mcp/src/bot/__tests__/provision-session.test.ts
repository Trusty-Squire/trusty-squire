import { describe, it, expect } from "vitest";
import type { InteractiveElement } from "../browser.js";
import {
  resolveTarget,
  provisionElementRef,
  provisionElementRefs,
  stableElementId,
  StaleProvisionRefError,
  AmbiguousProvisionTargetError,
  hostAllowed,
  elementRef,
  buildAccessibilitySnapshot,
  parseVerification,
  buildVerificationResult,
  looksLikeCodeIdentifier,
  findCredentialTokens,
  classifyVouchflowCredentials,
  detectExtractionBlock,
  sanitizeExtractedCredentials,
  buildScreenOutline,
  provisionPerceptionGuidance,
  shouldBlockUnsafeProvisionAction,
  validateAllowHost,
  maskSecretValue,
  googleSessionGate,
  isOnboardingOrOrgForm,
  hasOneTimeSecretModal,
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

  it("resolves a fresh generated ref against live elements", () => {
    const ref = provisionElementRef(inv[0] as InteractiveElement, 7);
    expect(ref).toMatch(/^@g7:/);
    expect(resolveTarget(inv, ref, 7)?.selector).toBe("#g");
  });

  it("rejects generated refs from an older observation generation", () => {
    const ref = provisionElementRef(inv[1] as InteractiveElement, 2);
    expect(() => resolveTarget(inv, ref, 3)).toThrow(StaleProvisionRefError);
  });

  it("returns null when a fresh ref no longer maps to a live element", () => {
    const ref = provisionElementRef(inv[0] as InteractiveElement, 4);
    expect(resolveTarget(inv.slice(1), ref, 4)).toBeNull();
  });

  it("fails loudly on ambiguous repeated labels instead of guessing", () => {
    const two = [
      el({ visibleText: "Email", selector: "#modal-email" }),
      el({ visibleText: "Email", selector: "#footer-email" }),
    ];
    expect(() => resolveTarget(two, "Email")).toThrow(AmbiguousProvisionTargetError);
  });

  it("stableElementId uses structure beyond the visible label", () => {
    const modal = el({
      visibleText: "Create account",
      screenPath: "dialog:finish-account > button:create-account",
    });
    const background = el({
      visibleText: "Create account",
      screenPath: "main:dashboard > button:create-account",
    });
    expect(stableElementId(modal)).not.toBe(stableElementId(background));
  });

  it("adds ordinal suffixes so identical elements still get distinct refs", () => {
    const twins = [
      el({ visibleText: "Continue", selector: "#first" }),
      el({ visibleText: "Continue", selector: "#second" }),
    ];
    const refs = provisionElementRefs(twins, 9);
    const firstRef = refs.get(twins[0] as InteractiveElement);
    const secondRef = refs.get(twins[1] as InteractiveElement);
    expect(firstRef).toMatch(/_1$/);
    expect(secondRef).toMatch(/_2$/);
    expect(firstRef).not.toBe(secondRef);
    expect(resolveTarget(twins, secondRef as string, 9)?.selector).toBe("#second");
  });
});

describe("buildAccessibilitySnapshot", () => {
  it("renders an AXI-style action tree with generated refs and regions", () => {
    const elements = [
      el({
        visibleText: "Create account",
        role: "button",
        container: "dialog:finish-account",
        screenPath: "dialog:finish-account > button:create-account",
        selector: "#create",
      }),
      el({
        tag: "input",
        placeholder: "Email",
        value: "",
        container: "form:signup",
        screenPath: "form:signup > textbox:email",
        selector: "#email",
      }),
    ];
    const snap = buildAccessibilitySnapshot(elements, 5);
    expect(snap?.source).toBe("interactive_dom");
    expect(snap?.refs).toBe(2);
    expect(snap?.tree).toContain('region "dialog:finish-account"');
    expect(snap?.tree).toContain('button "Create account" ref=@g5:');
    expect(snap?.tree).toContain('textbox "Email" ref=@g5:');
  });

  it("truncates large trees at a line boundary", () => {
    const elements = Array.from({ length: 40 }, (_, i) =>
      el({
        visibleText: `Button ${i}`,
        container: "main:dashboard",
        screenPath: `main:dashboard > button:${i}`,
      }),
    );
    const snap = buildAccessibilitySnapshot(elements, 1, 160);
    expect(snap?.truncated).toBe(true);
    expect(snap?.total_chars).toBeGreaterThan(160);
    expect(snap?.tree.endsWith("\n")).toBe(false);
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

describe("buildVerificationResult (Flow A — code-wall hand-back)", () => {
  it("returns the code with no needs_user when a code was found", () => {
    const r = buildVerificationResult("sk_1", "492013", null);
    expect(r).toMatchObject({ session_id: "sk_1", found: true, code: "492013" });
    expect(r.needs_user).toBeUndefined();
  });

  it("returns found=true with no needs_user when only a link was found", () => {
    const r = buildVerificationResult("sk_1", null, "https://x.example/confirm");
    expect(r.found).toBe(true);
    expect(r.needs_user).toBeUndefined();
  });

  it("hands back to the user (resumable) when neither code nor link was found", () => {
    const r = buildVerificationResult("sk_1", null, null);
    expect(r.found).toBe(false);
    expect(r.needs_user).toEqual({
      wall: "verification_code",
      message: expect.stringContaining("Ask the user for the code"),
      resume: "code",
    });
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

  it("recognizes a hyphen-prefixed vendor key whose prefix isn't hardcoded (Tally tly-)", () => {
    const toks = findCredentialTokens("Your API key: tly-a1b2c3d4e5f6g7h8i9j0k1l2");
    expect(toks).toContain("tly-a1b2c3d4e5f6g7h8i9j0k1l2");
  });

  it("still ignores hyphenated English prose (no digit, or whitespace)", () => {
    expect(findCredentialTokens("this-is-a-well-known-phrase-here")).toEqual([]);
  });

  it("recognizes a MULTI-segment vendor key via its high-entropy run (Luma luma-api-…)", () => {
    const toks = findCredentialTokens("Your key: luma-api-4Y7FDyM7kQ2bX9wZ1aL3pR");
    expect(toks).toContain("luma-api-4Y7FDyM7kQ2bX9wZ1aL3pR");
  });

  it("still rejects a word-word-word-date slug (no high-entropy segment)", () => {
    expect(findCredentialTokens("trusty-squire-dogfood-20260625")).toEqual([]);
  });

  it("ignores prose and short/digitless tokens", () => {
    expect(findCredentialTokens("Welcome to your dashboard. Get started now.")).toEqual([]);
    // has a separator but no digit → not a key
    expect(findCredentialTokens("user_account_settings_panel")).toEqual([]);
  });

  it("does NOT pick up ordinary slug identifiers with dates", () => {
    expect(findCredentialTokens("trusty-squire-dogfood-20260625")).toEqual([]);
  });

  it("classifies Vouchflow sandbox and live keys by capability", () => {
    const page =
      "SANDBOX WRITE vsk_sandbox_ad92ab8bc32c9bd7737105958f6b34465631cace " +
      "READ vsk_sandbox_read_b0ce17bcfd375a450da2fd1ceeebf3199a89cd73 " +
      "LIVE WRITE vsk_live_1536ea69786f3d176afde8d0d93cab852070245c " +
      "LIVE READ vsk_live_read_3cd42451654aac8db0263d13de871f3741dd513e";
    expect(classifyVouchflowCredentials(page)).toEqual({
      sandbox_write_key: "vsk_sandbox_ad92ab8bc32c9bd7737105958f6b34465631cace",
      sandbox_read_key: "vsk_sandbox_read_b0ce17bcfd375a450da2fd1ceeebf3199a89cd73",
      live_write_key: "vsk_live_1536ea69786f3d176afde8d0d93cab852070245c",
      live_read_key: "vsk_live_read_3cd42451654aac8db0263d13de871f3741dd513e",
    });
  });
});

describe("detectExtractionBlock (fail-closed on a login wall)", () => {
  it("flags X's anti-bot tombstone (the Grok false-green source)", () => {
    const tombstone =
      "JavaScript is not available.\nWe've detected that JavaScript is disabled in this browser.";
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

  it("allows tenant sibling hosts once they are added after organic redirect", () => {
    expect(hostAllowed("https://tsagent.kinde.com/admin", ["app.kinde.com"])).toBe(false);
    expect(hostAllowed("https://tsagent.kinde.com/admin", ["app.kinde.com", "tsagent.kinde.com"])).toBe(
      true,
    );
  });
});

describe("sanitizeExtractedCredentials", () => {
  it("keeps Langfuse one-time keys and drops version/date/noise fields", () => {
    const creds = sanitizeExtractedCredentials(
      {
        langfuse_secret_key: "sk-lf-...",
        langfuse_public_key: "pk-lf-...",
        api_key: "v3.198.0",
        secret_key: "6/11/2026",
        key: "pk-lf-d20a6e55-f210-4548-9ea0-10c3b0f136aa",
        api_key_2: "sk-lf-6ec811e4-4339-46cf-956a-d156cd6356de",
        api_key_3: "pk-lf-7e6848fa-3ac4-4ea1-8dba-86c4701d4d1d",
      },
      "https://cloud.langfuse.com/project/x/settings/api-keys",
      'LANGFUSE_SECRET_KEY="sk-lf-6ec811e4-4339-46cf-956a-d156cd6356de"\nLANGFUSE_PUBLIC_KEY="pk-lf-7e6848fa-3ac4-4ea1-8dba-86c4701d4d1d"',
    );

    expect(creds).toEqual({
      langfuse_secret_key: "sk-lf-6ec811e4-4339-46cf-956a-d156cd6356de",
      api_key: "sk-lf-6ec811e4-4339-46cf-956a-d156cd6356de",
      langfuse_public_key: "pk-lf-7e6848fa-3ac4-4ea1-8dba-86c4701d4d1d",
    });
  });

  it("drops page-noise the vault was storing as junk keys (date/email/greeting/label)", () => {
    const creds = sanitizeExtractedCredentials(
      {
        tally: "2026-06-23", // ISO date
        gitlab: "jessicalopez889@trustysquire.ai", // email
        replit: "Hi Lunchboxfortwo, what do you want to make?", // greeting (whitespace)
        growthbook: "Owner:", // UI label fragment
        api_key: "sk_live_realkey1234567890abcdef", // the one real key
      },
      "https://example.com/settings/api",
    );
    expect(creds).toEqual({ api_key: "sk_live_realkey1234567890abcdef" });
  });

  it("keeps a Neon napi token and drops referral/key-name clutter", () => {
    const creds = sanitizeExtractedCredentials(
      {
        refcode: "4SBR8T8L",
        key: "trusty-squire-dogfood-20260625",
        api_token: "napi_5kvwlmqcwdeo360t4bt4vnqdwqvand8fvja3g7wv6ofb51948l26cs2rhri3bx7b",
        api_key: "napi_5kvwlmqcwdeo360t4bt4vnqdwqvand8fvja3g7wv6ofb51948l26cs2rhri3bx7b",
      },
      "https://console.neon.tech/app/settings",
    );

    expect(creds).toEqual({
      api_token: "napi_5kvwlmqcwdeo360t4bt4vnqdwqvand8fvja3g7wv6ofb51948l26cs2rhri3bx7b",
      api_key: "napi_5kvwlmqcwdeo360t4bt4vnqdwqvand8fvja3g7wv6ofb51948l26cs2rhri3bx7b",
    });
  });

  it("rejects Together key ids when no real secret is visible", () => {
    const creds = sanitizeExtractedCredentials(
      {
        key: "key_CbQV1aVEkPobSKtY48w4W",
        api_key: "key_CbQV1aVEkPobSKtY48w4W",
      },
      "https://api.together.ai/settings/projects/proj/api-keys",
    );

    expect(creds).toEqual({});
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
    const reason = shouldBlockUnsafeProvisionAction("Dashboard Products Live mode", {
      kind: "click",
      target: "Save product",
    });

    expect(reason).toContain("live/production mode is visible");
  });

  it("allows billing creation actions when test mode is visible", () => {
    expect(
      shouldBlockUnsafeProvisionAction("Dashboard Products Test mode", {
        kind: "click",
        target: "Save product",
      }),
    ).toBeNull();
  });

  it("treats sandbox usage controls as a visible test/sandbox mode marker", () => {
    const text = "Settings Apps Sandbox usage Production usage";
    const guidance = provisionPerceptionGuidance(text);

    expect(guidance).toContain("Mode marker visible");
    expect(
      shouldBlockUnsafeProvisionAction(text, {
        kind: "click",
        target: "Save product",
      }),
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
      shouldBlockUnsafeProvisionAction("Dashboard Products Live mode", {
        kind: "click",
        target: "Products",
      }),
    ).toBeNull();
  });

  it("does not mistake a single marketing nav word for an authenticated app", () => {
    expect(
      shouldBlockUnsafeProvisionAction("Products Pricing Docs Create account", {
        kind: "click",
        target: "Create account",
      }),
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

describe("isOnboardingOrOrgForm (setup forms are not walls)", () => {
  it("detects the instant-db / 'tell us about yourself' onboarding", () => {
    expect(isOnboardingOrOrgForm("Tell us about yourself to finish setup")).toBe(true);
  });
  it("detects growthbook's 'you aren't part of an organization yet'", () => {
    expect(isOnboardingOrOrgForm("You aren't part of an organization yet. Create one to continue.")).toBe(true);
  });
  it("detects an anyscale-style create-org/workspace form", () => {
    expect(isOnboardingOrOrgForm("Create your organization Name your team")).toBe(true);
  });
  it("does NOT fire on an ordinary keys page", () => {
    expect(isOnboardingOrOrgForm("API Keys — create a new key for your project")).toBe(false);
  });
});

describe("hasOneTimeSecretModal (Luma one-time reveal)", () => {
  it("detects 'you won't be able to see this again'", () => {
    expect(hasOneTimeSecretModal("Copy your API key. You won't be able to view it again.")).toBe(true);
  });
  it("detects 'make sure to copy your secret now'", () => {
    expect(hasOneTimeSecretModal("Make sure to copy your secret key now and store it securely.")).toBe(true);
  });
  it("does NOT fire on an ordinary always-visible key field", () => {
    expect(hasOneTimeSecretModal("Your API key: sk-live-abc123 (always available here)")).toBe(false);
  });
});

describe("validateAllowHost (operator allow_host hardening)", () => {
  it("accepts a normal bare hostname and lowercases it", () => {
    expect(validateAllowHost("Console.Cloud.Google.com")).toEqual({
      host: "console.cloud.google.com",
    });
  });
  it("accepts a two-label app domain", () => {
    expect(validateAllowHost("myapp.com")).toEqual({ host: "myapp.com" });
  });
  it("rejects a wildcard", () => {
    expect(validateAllowHost("*.google.com")).toHaveProperty("error");
  });
  it("rejects a scheme/port/path", () => {
    expect(validateAllowHost("https://x.com")).toHaveProperty("error");
    expect(validateAllowHost("x.com:443")).toHaveProperty("error");
    expect(validateAllowHost("x.com/login")).toHaveProperty("error");
  });
  it("rejects punycode (homograph spoof)", () => {
    expect(validateAllowHost("xn--80ak6aa92e.com")).toHaveProperty("error");
  });
  it("rejects non-ASCII unicode lookalikes", () => {
    expect(validateAllowHost("gооgle.com")).toHaveProperty("error"); // cyrillic о
  });
  it("rejects an IPv4 literal", () => {
    expect(validateAllowHost("10.0.0.1")).toHaveProperty("error");
  });
  it("rejects an IPv6 literal (via the colon guard)", () => {
    expect(validateAllowHost("::1")).toHaveProperty("error");
    expect(validateAllowHost("[fe80::1]")).toHaveProperty("error");
  });
  it("rejects localhost", () => {
    expect(validateAllowHost("localhost")).toHaveProperty("error");
    expect(validateAllowHost("api.localhost")).toHaveProperty("error");
  });
  it("rejects a bare TLD / single label", () => {
    expect(validateAllowHost("com")).toHaveProperty("error");
  });
  it("rejects a two-label public suffix (would allow every subdomain)", () => {
    expect(validateAllowHost("co.uk")).toHaveProperty("error");
    expect(validateAllowHost("vercel.app")).toHaveProperty("error");
  });
  it("rejects malformed dots", () => {
    expect(validateAllowHost(".x.com")).toHaveProperty("error");
    expect(validateAllowHost("x..com")).toHaveProperty("error");
    expect(validateAllowHost("x.com.")).toHaveProperty("error");
  });
});

describe("maskSecretValue (sealed transfer preview)", () => {
  it("masks the middle of a long secret, keeping a short head + tail", () => {
    const masked = maskSecretValue("GOCSPX-abcdef1234567890xyz");
    expect(masked).toContain("••••");
    expect(masked).not.toContain("abcdef1234567890");
    expect(masked.startsWith("GOCSPX")).toBe(true);
  });
  it("fully redacts a short value (no reconstructable prefix)", () => {
    expect(maskSecretValue("short")).toBe("••••");
  });
});

describe("googleSessionGate (Change 5 — fail-closed precondition gate)", () => {
  it("passes when a live Google session exists", () => {
    expect(googleSessionGate(["google"])).toEqual({ ok: true });
    expect(googleSessionGate(["github", "google"])).toEqual({ ok: true });
  });
  it("fails closed to a connect hand-back when Google is absent", () => {
    const r = googleSessionGate([]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.needs_user.wall).toBe("google_session");
      expect(r.needs_user.resume).toBe("connect");
      expect(r.needs_user.message).toMatch(/has NOT started/i);
    }
  });
  it("fails closed when only a non-Google provider is live (no autonomous login)", () => {
    expect(googleSessionGate(["github"]).ok).toBe(false);
  });
});
