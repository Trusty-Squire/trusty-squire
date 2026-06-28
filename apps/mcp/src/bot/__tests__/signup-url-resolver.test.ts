import { describe, expect, it } from "vitest";
import {
  canonicalGoogleConsoleEntryUrl,
  classifySignupHtml,
  isMarketingAuthDeadEndUrl,
  resolveSignupUrlByProbe,
} from "../agent.js";

// Small inline fixtures — the discriminator is the COPY, not the markup,
// so each fixture carries just enough text + a password field to exercise
// one classification branch.

const PLUNK_LOGIN_HTML = `
  <html><head><title>Plunk</title></head><body>
    <h1>Sign in to your account</h1>
    <form>
      <label>Email</label><input type="email" name="email" />
      <label>Password</label><input type="password" name="password" />
      <button type="submit">Sign in</button>
      <button>Sign in with Google</button>
    </form>
  </body></html>
`;

const PLUNK_SIGNUP_HTML = `
  <html><head><title>Plunk</title></head><body>
    <h1>Create an account</h1>
    <form>
      <input name="email" type="email" placeholder="you@example.com" />
      <input type="password" name="password" />
      <button type="submit">Create account</button>
    </form>
  </body></html>
`;

const NOT_FOUND_HTML = `
  <html><head><title>404 — Page not found</title></head><body>
    <h1>This page doesn't exist</h1>
    <a href="/">Go home</a>
  </body></html>
`;

const MARKETING_HTML = `
  <html><head><title>Acme — the best widgets</title></head><body>
    <h1>Ship faster with Acme</h1>
    <a href="/pricing">Pricing</a><a href="/docs">Docs</a>
  </body></html>
`;

const PARKED_DOMAIN_HTML = `
  <html><head><title>openpipe.com</title></head><body>
    <h1>openpipe.com</h1>
    <p>The domain openpipe.com is for sale! Click here to learn more.</p>
    <form><input id="search-input" /><button>Search</button></form>
    <p>Search for information</p>
  </body></html>
`;

describe("classifySignupHtml", () => {
  it("classifies a login form as login", () => {
    expect(classifySignupHtml(PLUNK_LOGIN_HTML, "Plunk")).toBe("login");
  });

  it("classifies a signup form as signup", () => {
    expect(classifySignupHtml(PLUNK_SIGNUP_HTML, "Plunk")).toBe("signup");
  });

  it("classifies a 404 page as other", () => {
    expect(classifySignupHtml(NOT_FOUND_HTML, "404 — Page not found")).toBe(
      "other",
    );
  });

  it("classifies a marketing page (no form) as other", () => {
    expect(classifySignupHtml(MARKETING_HTML, "Acme")).toBe("other");
  });

  it("classifies parked/domain-for-sale pages as other even with a search form", () => {
    expect(classifySignupHtml(PARKED_DOMAIN_HTML, "openpipe.com")).toBe("other");
  });

  it("is robust to entities and casing in the CTA copy", () => {
    const html = `<html><body><h1>CREATE&nbsp;ACCOUNT</h1>
      <input type="password" name="pw" /></body></html>`;
    expect(classifySignupHtml(html)).toBe("signup");
  });

  it("treats a login-dominant page with a stray signup link as login", () => {
    const html = `<html><body>
      <h1>Welcome back</h1>
      <input type="password" name="password" />
      <button>Log in</button>
      <a href="/signup">Don't have an account? Sign up</a>
    </body></html>`;
    expect(classifySignupHtml(html)).toBe("login");
  });
});

describe("isMarketingAuthDeadEndUrl", () => {
  it("flags marketing routes but not signup routes", () => {
    expect(isMarketingAuthDeadEndUrl("https://acme.com/pricing#plans")).toBe(true);
    expect(isMarketingAuthDeadEndUrl("https://docs.acme.com/guide")).toBe(true);
    expect(isMarketingAuthDeadEndUrl("https://app.acme.com/signup")).toBe(false);
  });
});

// A tiny fake fetcher driven by a URL→response map. Any URL not in the map
// returns null (mirrors a fetch failure / unreachable path).
function fakeFetch(
  table: Record<string, { finalUrl?: string; status?: number; body: string }>,
): (
  url: string,
) => Promise<{ finalUrl: string; status: number; bodyText: string } | null> {
  return async (url: string) => {
    const entry = table[url];
    if (entry === undefined) return null;
    return {
      finalUrl: entry.finalUrl ?? url,
      status: entry.status ?? 200,
      bodyText: entry.body,
    };
  };
}

describe("resolveSignupUrlByProbe", () => {
  it("canonicalizes Google product console roots to account-scoped entries", async () => {
    const hint = "https://console.firebase.google.com/";
    const resolved = await resolveSignupUrlByProbe(
      hint,
      "firebase",
      fakeFetch({
        "https://console.firebase.google.com/u/0/": {
          status: 302,
          body: "<html><body>Redirecting to sign in</body></html>",
        },
      }),
    );
    expect(resolved).toBe("https://console.firebase.google.com/u/0/");
  });

  it("returns the hint's finalUrl when it already serves a signup form", async () => {
    const hint = "https://acme.com/signup";
    const resolved = await resolveSignupUrlByProbe(
      hint,
      "acme",
      fakeFetch({ [hint]: { body: PLUNK_SIGNUP_HTML } }),
    );
    expect(resolved).toBe(hint);
  });

  it("follows a redirect on the hint and returns the redirected signup url", async () => {
    const hint = "https://acme.com/signup";
    const resolved = await resolveSignupUrlByProbe(
      hint,
      "acme",
      fakeFetch({
        [hint]: { finalUrl: "https://app.acme.com/signup", body: PLUNK_SIGNUP_HTML },
      }),
    );
    expect(resolved).toBe("https://app.acme.com/signup");
  });

  it("trusts a signup-shaped redirect even when static HTML is an SPA shell", async () => {
    const hint = "https://app.acme.com/signup";
    const resolved = await resolveSignupUrlByProbe(
      hint,
      "acme",
      fakeFetch({
        [hint]: {
          finalUrl: "https://us.acme.com/signup",
          body: "<html><body>Acme</body></html>",
        },
      }),
    );
    expect(resolved).toBe("https://us.acme.com/signup");
  });

  it("does not trust a signup hint that redirects to a marketing route", async () => {
    const hint = "https://app.acme.com/signup";
    const resolved = await resolveSignupUrlByProbe(
      hint,
      "acme",
      fakeFetch({
        [hint]: {
          finalUrl: "https://acme.com/pricing",
          body: MARKETING_HTML,
        },
      }),
    );
    expect(resolved).toBeNull();
  });

  it("does not replace an auth entry with a 404 page just because the final path is signup", async () => {
    const hint = "https://console.acme.com/login";
    const resolved = await resolveSignupUrlByProbe(
      hint,
      "acme",
      fakeFetch({
        [hint]: { body: PLUNK_LOGIN_HTML },
        "https://console.acme.com/signup": {
          finalUrl: "https://www.acme.com/signup",
          status: 404,
          body: "<html><title>Not Found</title><body>Page not found</body></html>",
        },
        "https://acme.com/signup": {
          finalUrl: "https://www.acme.com/signup",
          status: 404,
          body: "<html><title>Not Found</title><body>Page not found</body></html>",
        },
      }),
    );
    expect(resolved).toBeNull();
  });

  it("recovers the plunk case: stale /signup (login) → /auth/signup (308 → next-app)", async () => {
    // Slug is "plunk" (the real service slug) but the site is useplunk.com,
    // and the conventional path redirects to a DIFFERENT subdomain
    // (next-app.). The domain-safety check must anchor on the HINT's
    // registered domain (useplunk.com), not the slug — else this same-site
    // redirect is wrongly rejected as off-domain (the bug the live
    // self-heal run caught 2026-06-04).
    const hint = "https://app.useplunk.com/signup";
    const resolved = await resolveSignupUrlByProbe(
      hint,
      "plunk",
      fakeFetch({
        // The curated hint silently serves the LOGIN page.
        [hint]: { body: PLUNK_LOGIN_HTML },
        // The conventional /auth/signup path 308-redirects to next-app.
        "https://app.useplunk.com/auth/signup": {
          finalUrl: "https://next-app.useplunk.com/auth/signup",
          body: PLUNK_SIGNUP_HTML,
        },
      }),
    );
    expect(resolved).toBe("https://next-app.useplunk.com/auth/signup");
  });

  it("returns null when the hint is login and no conventional path resolves", async () => {
    const hint = "https://acme.com/signup";
    const resolved = await resolveSignupUrlByProbe(
      hint,
      "acme",
      // Only the hint is reachable, and it's a login page. Every probed
      // path returns null (not in the table).
      fakeFetch({ [hint]: { body: PLUNK_LOGIN_HTML } }),
    );
    expect(resolved).toBeNull();
  });

  it("rejects a conventional candidate that redirects off-domain", async () => {
    const hint = "https://acme.com/signup";
    const resolved = await resolveSignupUrlByProbe(
      hint,
      "acme",
      fakeFetch({
        [hint]: { body: PLUNK_LOGIN_HTML },
        // A signup form, but it lives on someone else's domain — the
        // domain-safety check must reject it.
        "https://acme.com/auth/signup": {
          finalUrl: "https://evil-aggregator.example/signup",
          body: PLUNK_SIGNUP_HTML,
        },
      }),
    );
    expect(resolved).toBeNull();
  });

  it("recovers a stale model host with a reachable service-derived cloud console", async () => {
    const hint = "https://console.cloud.clickhouse.com/signup";
    const resolved = await resolveSignupUrlByProbe(
      hint,
      "clickhouse-cloud",
      fakeFetch({
        // The LLM-provided hint is unreachable (not present in this map).
        "https://console.clickhouse.cloud/signup": {
          body: MARKETING_HTML,
        },
      }),
    );
    expect(resolved).toBe("https://console.clickhouse.cloud/signup");
  });

  it("does not recover an unreachable hint through an off-domain service candidate", async () => {
    const hint = "https://console.cloud.clickhouse.com/signup";
    const resolved = await resolveSignupUrlByProbe(
      hint,
      "clickhouse-cloud",
      fakeFetch({
        "https://console.clickhouse.cloud/signup": {
          finalUrl: "https://evil.example/signup",
          body: PLUNK_SIGNUP_HTML,
        },
      }),
    );
    expect(resolved).toBeNull();
  });
});

describe("canonicalGoogleConsoleEntryUrl", () => {
  it("only rewrites bare Google product console roots", () => {
    expect(canonicalGoogleConsoleEntryUrl("https://console.firebase.google.com/")).toBe(
      "https://console.firebase.google.com/u/0/",
    );
    expect(canonicalGoogleConsoleEntryUrl("https://console.firebase.google.com/u/0/")).toBeNull();
    expect(canonicalGoogleConsoleEntryUrl("https://aistudio.google.com/")).toBeNull();
  });
});
