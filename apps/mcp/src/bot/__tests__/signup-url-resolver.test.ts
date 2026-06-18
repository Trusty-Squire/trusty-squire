import { describe, expect, it } from "vitest";
import {
  classifySignupHtml,
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
