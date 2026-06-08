// Open the BOT's Chrome session (via noVNC, through the gost proxy — same IP
// the bot uses) landed on replicate's GitHub sign-in, so the operator can
// complete GitHub's forced "Verify your 2FA settings → Verify 2FA now" wall
// IN the flagged session. The wall is pinned to the bot's Seoul-IP session and
// only appears on an app-authorize page, so it can't be cleared from the
// operator's own browser or the plain `mcp login` flow.
//
// Run (proxy comes from UNIVERSAL_BOT_PROXY_URL in harvester.env):
//   set -a; . ~/.config/trusty-squire/harvester.env; set +a
//   node tools/github-2fa-clear.mjs
//
// A noVNC URL + VNC password print to stderr. Open it, click "Sign in with
// GitHub", complete "Verify 2FA now" (enter your authenticator code). Once
// replicate finishes the round-trip, this exits automatically.
import { runInBotChrome } from "../apps/mcp/dist/bot/google-login.js";
import { homedir } from "node:os";
import { join } from "node:path";

const profileDir = join(homedir(), ".trusty-squire", "chrome-profile");

const result = await runInBotChrome({
  profileDir,
  url: "https://replicate.com/signin",
  deadline: Date.now() + 12 * 60 * 1000, // 12 min for the human to finish
  bannerLabel:
    "Click 'Sign in with GitHub', then complete GitHub's 'Verify 2FA now' (enter your authenticator code).",
  // Done once the GitHub round-trip completes and replicate redirects off the
  // sign-in page (i.e., the 2FA wall was cleared and authorization succeeded).
  pollUntilDone: async (context) => {
    for (const p of context.pages()) {
      try {
        const u = new URL(p.url());
        if (
          u.hostname.endsWith("replicate.com") &&
          u.pathname !== "/signin" &&
          u.pathname !== "/"
        ) {
          return true;
        }
      } catch {
        // page mid-navigation
      }
    }
    return false;
  },
});

console.error(`[2fa-clear] result: ${result.status}`);
