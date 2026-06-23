import type { BrowserState } from "./browser.js";

export interface PostSignupLoginCredentials {
  email: string;
  password: string;
}

export interface PostSignupLoginPort {
  getState(): Promise<BrowserState>;
  loginWithCredentials(
    email: string,
    password: string,
    steps: string[],
  ): Promise<boolean>;
}

export interface PostSignupLoginInput {
  credentials?: PostSignupLoginCredentials | undefined;
  steps: string[];
  port: PostSignupLoginPort;
}

export type PostSignupLoginResult =
  | { kind: "continue" }
  | { kind: "break" }
  | { kind: "oauth_session_not_persisted"; url: string | null };

// Owns post-signup login *policy*: OAuth login requests are evidence the
// callback did not persist; email/password login attempts are bounded. The
// browser-specific credential entry flow stays in SignupAgent for now.
export class PostSignupLoginFlow {
  private oauthLoginRequests = 0;
  private loginAttempts = 0;

  async handleLoginRequest(
    input: PostSignupLoginInput,
  ): Promise<PostSignupLoginResult> {
    if (input.credentials === undefined) {
      // OAuth run — no password to give. A single ask can be a transient
      // mid-render read, but a SECOND ask means the page keeps presenting
      // login: the OAuth session didn't persist.
      this.oauthLoginRequests += 1;
      if (this.oauthLoginRequests >= 2) {
        const state = await input.port.getState().catch(() => null);
        input.steps.push(
          "Post-verify: planner hit a login page twice on an OAuth run — " +
            "the OAuth session didn't persist; bailing.",
        );
        return {
          kind: "oauth_session_not_persisted",
          url: state?.url ?? null,
        };
      }

      input.steps.push(
        "Post-verify: planner asked to log in on an OAuth run — already " +
          "authenticated via Google; skipping (1st ask, may be a transient read).",
      );
      return { kind: "continue" };
    }

    if (this.loginAttempts >= 2) {
      input.steps.push("Post-verify: already attempted login twice — stopping.");
      return { kind: "break" };
    }

    this.loginAttempts += 1;
    await input.port.loginWithCredentials(
      input.credentials.email,
      input.credentials.password,
      input.steps,
    );
    return { kind: "continue" };
  }
}
