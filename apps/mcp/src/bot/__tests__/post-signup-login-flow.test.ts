import { describe, expect, it } from "vitest";
import { PostSignupLoginFlow } from "../post-signup-login-flow.js";
import type { BrowserState } from "../browser.js";

function state(url: string): BrowserState {
  return {
    url,
    title: "Login",
    html: "<html>login</html>",
    screenshot: "",
  };
}

describe("PostSignupLoginFlow", () => {
  it("skips the first OAuth login request as a transient read", async () => {
    const steps: string[] = [];
    const flow = new PostSignupLoginFlow();

    const result = await flow.handleLoginRequest({
      steps,
      port: {
        getState: async () => state("https://example.test/login"),
        loginWithCredentials: async () => true,
      },
    });

    expect(result).toEqual({ kind: "continue" });
    expect(steps).toEqual([
      "Post-verify: planner asked to log in on an OAuth run — already authenticated via Google; skipping (1st ask, may be a transient read).",
    ]);
  });

  it("classifies the second OAuth login request as session-not-persisted", async () => {
    const steps: string[] = [];
    const flow = new PostSignupLoginFlow();
    const port = {
      getState: async () => state("https://example.test/login"),
      loginWithCredentials: async () => true,
    };

    await flow.handleLoginRequest({ steps, port });
    const result = await flow.handleLoginRequest({ steps, port });

    expect(result).toEqual({
      kind: "oauth_session_not_persisted",
      url: "https://example.test/login",
    });
    expect(steps.at(-1)).toBe(
      "Post-verify: planner hit a login page twice on an OAuth run — the OAuth session didn't persist; bailing.",
    );
  });

  it("bounds email/password login attempts at two", async () => {
    const steps: string[] = [];
    const calls: string[] = [];
    const flow = new PostSignupLoginFlow();
    const port = {
      getState: async () => state("https://example.test/login"),
      loginWithCredentials: async (
        email: string,
        password: string,
        loginSteps: string[],
      ) => {
        calls.push(`${email}:${password}:${loginSteps === steps}`);
        return true;
      },
    };
    const credentials = { email: "bot@example.test", password: "pw" };

    expect(
      await flow.handleLoginRequest({ credentials, steps, port }),
    ).toEqual({ kind: "continue" });
    expect(
      await flow.handleLoginRequest({ credentials, steps, port }),
    ).toEqual({ kind: "continue" });
    expect(
      await flow.handleLoginRequest({ credentials, steps, port }),
    ).toEqual({ kind: "break" });

    expect(calls).toEqual([
      "bot@example.test:pw:true",
      "bot@example.test:pw:true",
    ]);
    expect(steps.at(-1)).toBe(
      "Post-verify: already attempted login twice — stopping.",
    );
  });
});
