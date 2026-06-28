// looksLike404 — abort the hardcoded keys-URL walk early when guessed paths
// keep 404ing. MEASURED 2026-06-09: axiom/fathom/loops each walked the full
// ~25-path list with every path a 404 and blew the 600s run budget. The
// three real shells exercised below are the exact ones observed.

import { describe, expect, it } from "vitest";
import { looksLike404, shouldAbortOAuthFirstOnDeadPage, titleFromHtml } from "../agent.js";

describe("looksLike404", () => {
  it("fathom: title 'Not Found' + 'could not be found' body", () => {
    expect(
      looksLike404(
        "Not Found",
        "Not Found 404 The route settings/api-keys could not be found. Go back to the page you were on.",
      ),
    ).toBe(true);
  });

  it("loops: empty title + \"page you're looking for doesn't exist\" body", () => {
    expect(
      looksLike404("", "404 L'oops! The page you're looking for doesn't exist. Home"),
    ).toBe(true);
  });

  it("axiom: empty title + '404 page not found' body", () => {
    expect(looksLike404("", "404 page not found")).toBe(true);
  });

  it("temporal: app-rendered route-not-found shell", () => {
    expect(
      looksLike404(
        "Temporal",
        "404 Uh oh. There's an error. Not found: /settings/api_keys Try a refresh",
      ),
    ).toBe(true);
  });

  it("meilisearch: SPA client-rendered /signup 404 ('cute baby seal sleeping')", () => {
    // MEASURED 2026-06-23: cloud.meilisearch.com/signup serves a 200 SPA
    // shell, then renders this 404 once React mounts. The static HTTP probe
    // can't see it, so the signup-url resolver "upgrades" a working /login to
    // this dead /signup; the live 404 fallback keys off this exact copy.
    expect(
      looksLike404(
        "Meilisearch Cloud",
        "Meilisearch Cloud You need to enable JavaScript to run this app. " +
          "Sorry, the page you are looking for does not exist Unless you were " +
          "specifically looking for a page with a cute baby seal sleeping, in " +
          "that case, well done. Bring me home, please",
      ),
    ).toBe(true);
  });

  it("does NOT flag a real keys page", () => {
    expect(
      looksLike404(
        "API Keys — Settings",
        "Create API Key Your API keys Name Created Default key sk_live_… Revoke",
      ),
    ).toBe(false);
  });

  it("does NOT flag a dashboard with no not-found copy", () => {
    expect(looksLike404("Dashboard", "Welcome back Projects Usage Billing")).toBe(false);
  });
});

describe("shouldAbortOAuthFirstOnDeadPage", () => {
  it("flags a rendered 404 before OAuth-first waits for async provider buttons", () => {
    expect(
      shouldAbortOAuthFirstOnDeadPage(
        "404: This page could not be found.",
        "404: This page could not be found. OpenPipe: Fine-tuning for production apps",
      ),
    ).toBe(true);
  });

  it("flags browser network error pages before treating them as loading shells", () => {
    expect(
      shouldAbortOAuthFirstOnDeadPage(
        "Luma AI - Transform Ideas into Videos Instantly with AI",
        "This site can't be reached Check if there is a typo in luma.ai. DNS_PROBE_FINISHED_NXDOMAIN Reload",
      ),
    ).toBe(true);
  });

  it("flags Cartesia-style rendered dead signup pages before OAuth-first waits", () => {
    expect(
      shouldAbortOAuthFirstOnDeadPage(
        "Playground | Cartesia",
        "404 This page could not be found. Cartesia Playground Sign in Sign up",
      ),
    ).toBe(true);
  });
});

describe("titleFromHtml", () => {
  it("extracts and trims the <title>", () => {
    expect(titleFromHtml("<html><head><title>  Not Found </title></head></html>")).toBe(
      "Not Found",
    );
  });

  it("returns empty string when absent", () => {
    expect(titleFromHtml("<html><body>no title here</body></html>")).toBe("");
  });
});
