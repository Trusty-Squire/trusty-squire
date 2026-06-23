// parseGoogleProjectId — pulls the GCP/Firebase projectId out of a console URL
// so the deterministic Browser-key extractor only fires once a project exists.
import { describe, expect, it } from "vitest";
import { isAuthenticatedGoogleConsoleUrl, parseGoogleProjectId } from "../agent.js";

describe("parseGoogleProjectId", () => {
  it("reads the projectId from a firebase console post-creation URL", () => {
    expect(
      parseGoogleProjectId(
        "https://console.firebase.google.com/u/0/project/ts-firebase-project/overview",
      ),
    ).toBe("ts-firebase-project");
  });

  it("reads the projectId from a ?project= query param (GCP console)", () => {
    expect(
      parseGoogleProjectId(
        "https://console.cloud.google.com/apis/credentials?project=my-app-12345",
      ),
    ).toBe("my-app-12345");
  });

  it("prefers the query param when both are present", () => {
    expect(
      parseGoogleProjectId(
        "https://console.cloud.google.com/apis/credentials?authuser=0&project=q-proj",
      ),
    ).toBe("q-proj");
  });

  it("returns null at the console root (no project yet)", () => {
    expect(parseGoogleProjectId("https://console.firebase.google.com/u/0/")).toBeNull();
    expect(parseGoogleProjectId("https://console.cloud.google.com/")).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(parseGoogleProjectId("not a url")).toBeNull();
  });
});

describe("isAuthenticatedGoogleConsoleUrl", () => {
  it("is true for the firebase + gcp console hosts (logged-out would redirect away)", () => {
    expect(isAuthenticatedGoogleConsoleUrl("https://console.firebase.google.com/u/0/")).toBe(true);
    expect(
      isAuthenticatedGoogleConsoleUrl("https://console.cloud.google.com/apis/credentials?project=x"),
    ).toBe(true);
  });

  it("is false for the OAuth sign-in host and unrelated sites", () => {
    expect(isAuthenticatedGoogleConsoleUrl("https://accounts.google.com/signin")).toBe(false);
    expect(isAuthenticatedGoogleConsoleUrl("https://meilisearch.com/login")).toBe(false);
    expect(isAuthenticatedGoogleConsoleUrl("not a url")).toBe(false);
  });
});
