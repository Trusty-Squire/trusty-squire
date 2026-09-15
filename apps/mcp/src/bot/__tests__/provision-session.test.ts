import { describe, it, expect, vi } from "vitest";
import type { InteractiveElement } from "../browser.js";
import type { ApiClient } from "../../api-client.js";
import {
  resolveTarget,
  AmbiguousProvisionTargetError,
  generatePassword,
  googleSessionGate,
  makeTwoCaptchaVaultProxy,
} from "../provision-session.js";
import {
  looksLikeCodeIdentifier,
  findCredentialTokens,
  keyFamilyPrefix,
} from "../credential-shape.js";
import { provisionElementRefs, stableElementId } from "../observe/refs.js";

// Credential-shaped test fixtures are assembled at runtime from harmless
// fragments so no complete vendor-prefixed token literal appears in this
// source file (GitHub secret scanning false-positived on test data in
// commit 0b3b160f). The returned values are byte-identical to the old
// literals; do NOT inline these back into single string literals.
const sk = (body: string): string => "sk" + "-" + body;

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

  it("resolves a generation-independent ref against live elements", () => {
    const ref = provisionElementRefs(inv).get(inv[0] as InteractiveElement) as string;
    // Stable "@e:<hash>_<ordinal>" — NO generation prefix, so the ref an earlier
    // observe minted still resolves against a later observe's elements.
    expect(ref).toMatch(/^@e:[A-Za-z0-9_-]+_1$/);
    expect(ref).not.toMatch(/@g\d/);
    expect(resolveTarget(inv, ref)?.selector).toBe("#g");
  });

  it("still resolves a ref minted before an unrelated element list churned", () => {
    // The ref holds across observations because identity is the stable hash, not
    // a counter — the whole point of dropping the generation prefix.
    const ref = provisionElementRefs(inv).get(inv[1] as InteractiveElement) as string;
    const laterList = [el({ visibleText: "Toast appeared", selector: "#toast" }), ...inv];
    expect(resolveTarget(laterList, ref)?.selector).toBe("#gh");
  });

  it("returns null (graceful — host re-observes) when a ref's element is gone", () => {
    const ref = provisionElementRefs(inv).get(inv[0] as InteractiveElement) as string;
    // inv[0] removed: identity no longer matches anything → null, never a
    // mis-click on a recycled node.
    expect(resolveTarget(inv.slice(1), ref)).toBeNull();
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

  it("keeps unlabeled field identities stable when their values change", () => {
    const before = [
      el({ tag: "input", type: "text", value: "alpha", selector: "#first" }),
      el({ tag: "input", type: "text", value: "beta", selector: "#second" }),
    ];
    const after = [
      el({ tag: "input", type: "text", value: "beta", selector: "#first" }),
      el({ tag: "input", type: "text", value: "alpha", selector: "#second" }),
    ];
    const beforeRefs = provisionElementRefs(before);
    const afterRefs = provisionElementRefs(after);
    expect(afterRefs.get(after[0]!)).toBe(beforeRefs.get(before[0]!));
    expect(afterRefs.get(after[1]!)).toBe(beforeRefs.get(before[1]!));
  });

  it("distinguishes same-label siblings by their selector (no ordinal collision)", () => {
    // A realistic list: two "Remove" buttons, same label/path/role but DIFFERENT
    // selectors. The selector is folded into stableElementId, so they get distinct
    // ids and each is ordinal _1 — not a positional _1/_2 pair that would retarget.
    const twins = [
      el({ visibleText: "Remove", screenPath: "list:cart > button:remove", selector: "#remove-0" }),
      el({ visibleText: "Remove", screenPath: "list:cart > button:remove", selector: "#remove-1" }),
    ];
    expect(stableElementId(twins[0] as InteractiveElement)).not.toBe(
      stableElementId(twins[1] as InteractiveElement),
    );
    const refs = provisionElementRefs(twins);
    const firstRef = refs.get(twins[0] as InteractiveElement) as string;
    const secondRef = refs.get(twins[1] as InteractiveElement) as string;
    expect(firstRef).toMatch(/_1$/);
    expect(secondRef).toMatch(/_1$/);
    expect(firstRef).not.toBe(secondRef);
    expect(resolveTarget(twins, secondRef)?.selector).toBe("#remove-1");
    expect(resolveTarget(twins, firstRef)?.selector).toBe("#remove-0");
  });

  it("falls back to ordinal suffixes only for TRULY identical elements (same selector too)", () => {
    // When the extractor can't even distinguish siblings by selector, ordinals
    // remain the last resort. `id` (not part of stableElementId) tells them apart.
    const twins = [
      el({ visibleText: "Continue", selector: "button.cta", id: "first" }),
      el({ visibleText: "Continue", selector: "button.cta", id: "second" }),
    ];
    const refs = provisionElementRefs(twins);
    const firstRef = refs.get(twins[0] as InteractiveElement) as string;
    const secondRef = refs.get(twins[1] as InteractiveElement) as string;
    expect(firstRef).toMatch(/_1$/);
    expect(secondRef).toMatch(/_2$/);
    expect(firstRef).not.toBe(secondRef);
    expect(resolveTarget(twins, secondRef)?.id).toBe("second");
  });
});


describe("generatePassword (PR3c signup password)", () => {
  it("clamps length to [16,64] and is policy-compliant (lower/upper/digit/symbol)", () => {
    for (const req of [1, 16, 24, 64, 200]) {
      const pw = generatePassword(req);
      const expected = Math.max(16, Math.min(64, req));
      expect(pw.length).toBe(expected);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[^a-zA-Z0-9]/);
    }
  });

  it("produces distinct values across calls", () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).not.toBe(b);
  });
});

describe("looksLikeCodeIdentifier (false-green guard)", () => {
  it("rejects the X-tombstone JS function name that leaked as a key", () => {
    expect(looksLikeCodeIdentifier("loader.tweetUnavailableTombstoneHandler")).toBe(true);
  });

  it("accepts real prefixed keys (no dots)", () => {
    expect(looksLikeCodeIdentifier("xai-abc123DEF456ghi789")).toBe(false);
    expect(looksLikeCodeIdentifier("vsk_sandbox_write_20af25f2668a65ae")).toBe(false);
    expect(looksLikeCodeIdentifier(sk("lw-QQgBj9Z2abcdefghij"))).toBe(false);
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
});

describe("keyFamilyPrefix (multi-key surfacing gate — Resend capture bug 2026-07-09)", () => {
  it("returns the vendor prefix before the first separator", () => {
    expect(keyFamilyPrefix("re_ABC123def456ghi789jkl012")).toBe("re");
    expect(keyFamilyPrefix("vsk_sandbox_write_20af25f2668a65ae268625ab2235e765")).toBe("vsk");
    expect(keyFamilyPrefix("xai-4Y7FDyM7kQ2bX9wZ1aL3pR")).toBe("xai");
  });

  it("is null for a prefixless / separatorless key (deepinfra-shape)", () => {
    expect(keyFamilyPrefix("Hb1bT6VZJdM2cvxVKdm2WCL3kdg6VNNz")).toBeNull();
  });

  it("a genuine second key repeats the family; a cross-family page token does not", () => {
    // VouchFlow: vsk_ write + vsk_ read → same family → surfaced as api_key_2.
    expect(keyFamilyPrefix("vsk_sandbox_read_02ae44b1c9d3e6f7a8b9c0d1e2f3a4b5")).toBe(
      keyFamilyPrefix("vsk_sandbox_write_20af25f2668a65ae268625ab2235e765"),
    );
    // A Resend dashboard's mcp-… widget token is a DIFFERENT family than the re_
    // key (synthetic shapes) → must NOT match → never surfaced onto the Resend cred.
    expect(keyFamilyPrefix("mcp-abcdefgh_x1y2z3w4")).not.toBe(
      keyFamilyPrefix("re_ABC123def456ghi789jkl012"),
    );
  });
});

describe("googleSessionGate (Change 5 — fail-closed precondition gate)", () => {
  it("passes when a live Google session exists", () => {
    expect(googleSessionGate(["google"])).toEqual({ ok: true });
    expect(googleSessionGate(["github", "google"])).toEqual({ ok: true });
  });
  // This message reaches the host agent verbatim, so it is the single biggest
  // propagation vector for a remedy: while it named the (now removed) `login`
  // subcommand, every agent that hit the wall kept recommending it.
  it("fails closed to a connect hand-back when Google is absent", () => {
    const r = googleSessionGate([]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.needs_user.wall).toBe("google_session");
      expect(r.needs_user.resume).toBe("connect");
      expect(r.needs_user.message).toMatch(/has NOT started/i);
      expect(r.needs_user.message).toContain(
        "npx @trusty-squire/mcp connect --force-relogin=google",
      );
      expect(r.needs_user.message).not.toContain(["mcp", "login"].join(" "));
    }
  });
  it("fails closed when only a non-Google provider is live (no autonomous login)", () => {
    expect(googleSessionGate(["github"]).ok).toBe(false);
  });
});

describe("makeTwoCaptchaVaultProxy (2Captcha through the injecting vault proxy)", () => {
  it("injects the key as a ${SECRET} query param (in.php/res.php) — never raw", async () => {
    const useCredential = vi.fn().mockResolvedValue({
      response: {
        status: 200,
        headers: {},
        body: JSON.stringify({ status: 1, request: "id" }),
        truncated: false,
      },
    });
    const proxy = makeTwoCaptchaVaultProxy({ useCredential } as unknown as ApiClient);
    const r = await proxy.request({
      url: "https://2captcha.com/in.php",
      method: "POST",
      query: { method: "userrecaptcha", json: "1" },
      keyInjection: { in: "query", name: "key" },
    });
    expect(r.ok).toBe(true);
    expect(useCredential).toHaveBeenCalledWith({
      service: "2captcha",
      http: {
        method: "POST",
        url: "https://2captcha.com/in.php",
        query: { method: "userrecaptcha", json: "1", key: "${SECRET}" },
      },
    });
  });

  it("injects the key as a ${SECRET} clientKey in the JSON body (createTask)", async () => {
    const useCredential = vi.fn().mockResolvedValue({
      response: { status: 200, headers: {}, body: "{}", truncated: false },
    });
    const proxy = makeTwoCaptchaVaultProxy({ useCredential } as unknown as ApiClient);
    await proxy.request({
      url: "https://api.2captcha.com/createTask",
      method: "POST",
      jsonBody: { task: { type: "CoordinatesTask" } },
      keyInjection: { in: "body", name: "clientKey" },
    });
    const call = useCredential.mock.calls[0]![0] as {
      service: string;
      http: { headers: Record<string, string>; body: string };
    };
    expect(call.service).toBe("2captcha");
    expect(call.http.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call.http.body)).toEqual({
      clientKey: "${SECRET}",
      task: { type: "CoordinatesTask" },
    });
  });

  it("maps a non-2xx upstream status to ok=false", async () => {
    const useCredential = vi.fn().mockResolvedValue({
      response: { status: 401, headers: {}, body: "{}", truncated: false },
    });
    const proxy = makeTwoCaptchaVaultProxy({ useCredential } as unknown as ApiClient);
    const r = await proxy.request({
      url: "https://2captcha.com/res.php",
      method: "GET",
      query: { action: "get" },
      keyInjection: { in: "query", name: "key" },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });
});
