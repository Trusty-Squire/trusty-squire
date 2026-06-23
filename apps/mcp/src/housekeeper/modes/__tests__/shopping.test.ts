import { describe, expect, it } from "vitest";
import {
  extractSignupCandidates,
  runShoppingBatch,
  runShoppingForService,
  verifySignupCandidate,
  type ShoppingCandidate,
} from "../shopping.js";
import type { QueueProvider } from "../../queues/index.js";

function htmlResponse(body: string, init: { status?: number; url: string }): Response {
  const res = new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html" },
  });
  Object.defineProperty(res, "url", { value: init.url });
  return res;
}

function fakeFetch(routes: Record<string, { body: string; status?: number; finalUrl?: string }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected fetch: ${url}`);
    return htmlResponse(route.body, {
      ...(route.status !== undefined ? { status: route.status } : {}),
      url: route.finalUrl ?? url,
    });
  }) as typeof fetch;
}

describe("extractSignupCandidates", () => {
  it("extracts signup CTAs from official homepage HTML", () => {
    const candidates = extractSignupCandidates({
      sourceUrl: "https://example.com",
      html: `
        <a href="/docs">Docs</a>
        <a href="/signup">Sign up</a>
        <a href="https://app.example.com/register">Create account</a>
      `,
    });
    expect(candidates).toMatchObject([
      {
        url: "https://example.com/signup",
        sourceUrl: "https://example.com",
        sourceType: "homepage_cta",
        anchorText: "Sign up",
      },
      {
        url: "https://app.example.com/register",
        sourceUrl: "https://example.com",
        sourceType: "homepage_cta",
        anchorText: "Create account",
      },
    ]);
  });

  it("ignores docs/login links that are not signup CTAs", () => {
    const candidates = extractSignupCandidates({
      sourceUrl: "https://example.com",
      html: `
        <a href="/docs">API tokens docs</a>
        <a href="/login">Log in</a>
      `,
    });
    expect(candidates).toEqual([]);
  });
});

describe("verifySignupCandidate", () => {
  const candidate: ShoppingCandidate = {
    url: "https://app.example.com/signup",
    sourceUrl: "https://example.com",
    sourceType: "homepage_cta",
    anchorText: "Sign up",
  };

  it("verifies an OAuth signup page and records evidence", async () => {
    const result = await verifySignupCandidate(
      candidate,
      fakeFetch({
        "https://app.example.com/signup": {
          body: "<h1>Create account</h1><button>Continue with Google</button>",
          finalUrl: "https://app.example.com/signup",
        },
      }),
    );
    expect(result.status).toBe("verified");
    expect(result.entryKind).toBe("oauth_signup");
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.evidence[0]).toMatchObject({
      sourceUrl: "https://example.com",
      anchorText: "Sign up",
      httpStatus: 200,
      finalUrl: "https://app.example.com/signup",
    });
    expect(result.evidence[0]?.pageSignals).toContain("continue_with_google");
  });

  it("rejects a 404 candidate", async () => {
    const result = await verifySignupCandidate(
      candidate,
      fakeFetch({
        "https://app.example.com/signup": {
          status: 404,
          body: "Page not found",
        },
      }),
    );
    expect(result.status).toBe("bad");
    expect(result.reason).toBe("http_404");
    expect(result.signupUrl).toBeNull();
  });

  it("marks non-self-serve pages as blocked when no signup signal exists", async () => {
    const result = await verifySignupCandidate(
      candidate,
      fakeFetch({
        "https://app.example.com/signup": {
          body: "<h1>Contact sales</h1><p>Request demo to create an enterprise account.</p>",
        },
      }),
    );
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("blocked_or_non_self_serve");
  });
});

describe("runShoppingForService", () => {
  it("prefers a curated signup URL and does not need a homepage to exist", async () => {
    const result = await runShoppingForService(
      { service: "ipinfo", signupUrl: "https://ipinfo.io/signup" },
      {
        fetchFn: fakeFetch({
          "https://ipinfo.io/signup": {
            body: '<form><input type="email"><input type="password"><button>Sign up</button></form>',
          },
        }),
      },
    );
    expect(result).toMatchObject({
      service: "ipinfo",
      status: "verified",
      signupUrl: "https://ipinfo.io/signup",
      entryKind: "signup_form",
    });
  });

  it("discovers a signup CTA from the homepage when no curated URL exists", async () => {
    const result = await runShoppingForService(
      { service: "acme" },
      {
        fetchFn: fakeFetch({
          "https://acme.com": {
            body: '<a href="https://app.acme.com/register">Get started</a>',
          },
          "https://www.acme.com": {
            body: "<a href='/login'>Log in</a>",
          },
          "https://app.acme.com/register": {
            body: "<h1>Create account</h1><button>Continue with GitHub</button>",
          },
        }),
      },
    );
    expect(result.status).toBe("verified");
    expect(result.signupUrl).toBe("https://app.acme.com/register");
    expect(result.entryKind).toBe("oauth_signup");
  });
});

describe("runShoppingBatch", () => {
  it("runs shopping over discover-shaped queue tasks", async () => {
    const queue: QueueProvider = {
      name: "test-shopping",
      fetch: async () => [
        {
          kind: "discover",
          service: "resend",
          signupUrl: "https://resend.com/signup",
        },
      ],
    };
    const result = await runShoppingBatch({
      queue,
      config: {
        fetchFn: fakeFetch({
          "https://resend.com/signup": {
            body: "<h1>Sign up</h1><button>Continue with Google</button>",
          },
        }),
      },
    });
    expect(result).toMatchObject({
      attempted: 1,
      verified: 1,
      bad: 0,
      blocked: 0,
    });
  });
});
