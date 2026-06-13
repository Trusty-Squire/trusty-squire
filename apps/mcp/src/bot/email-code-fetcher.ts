// Shared `fetchEmailCode` builder for `await_email_code` replay steps.
//
// The replay engine (replay-skill.ts) has no inbox transport of its own —
// it takes a `fetchEmailCode` callback. Both callers that drive replays
// against real inboxes (the verifier in housekeeper/modes/verify.ts and the
// live-provision router in tools/provision-any.ts) need the same poll +
// code-extract logic, so it lives here once.
import type { InboxClient } from "./inbox-client.js";
import { extractCodeFromEmailBody } from "./agent.js";

// Subject matcher broad enough to catch the verification mail across
// services (mirrors agent.ts's waitForVerificationEmail pattern).
const VERIFICATION_SUBJECT =
  /verif|confirm|code|one[\s-]?time|otp|sign[\s-]?up|activate|complete/i;

export function makeEmailCodeFetcher(
  inbox: InboxClient,
  timeoutSeconds = 120,
): (input: { alias: string }) => Promise<string | null> {
  return async ({ alias }) => {
    try {
      const email = await inbox.waitForEmail({
        alias,
        matcher: { subject: VERIFICATION_SUBJECT },
        timeout_seconds: timeoutSeconds,
      });
      // Prefer the poller's own parsed code; else scan the body. Either
      // way, reject any candidate that's just the recipient address's
      // digits (a human-looking alias like `ryan.collins761@` would
      // otherwise poison the parse — see inbox-client.humanLocalPart).
      const fromParsed = email.parsed_codes.find((c) => /^\d{4,8}$/.test(c));
      if (fromParsed !== undefined) return fromParsed;
      return extractCodeFromEmailBody(
        {
          subject: email.subject,
          body_text: email.body_text,
          body_html: email.body_html,
        },
        alias,
      );
    } catch {
      // No mail in the window / network fault — replay's await_email_code
      // step fails cleanly with "no code arrived".
      return null;
    }
  };
}
