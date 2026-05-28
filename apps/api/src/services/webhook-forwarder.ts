// Shared construction for the inbound-mail webhook routes.
//
// rc.19 — cut over from Gmail SMTP / SES inbound to Resend for both
// outbound and inbound. The EmailForwarder reads RESEND_API_KEY from
// env; without it, the forwarder runs in log-only mode (dev path).

import { EmailForwarder, DEFAULT_ALIASES } from "./email-forwarder.js";

// Build the Resend-backed EmailForwarder, or fall back to a log-only
// forwarder when RESEND_API_KEY isn't configured. `override` lets
// tests inject a stub forwarder.
export function buildEmailForwarder(override?: EmailForwarder): EmailForwarder {
  if (override !== undefined) return override;
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_ADDRESS;
  const fromName = process.env.RESEND_FROM_NAME;
  return new EmailForwarder(DEFAULT_ALIASES, {
    ...(resendApiKey !== undefined && resendApiKey.length > 0
      ? { resendApiKey }
      : {}),
    ...(fromAddress !== undefined && fromAddress.length > 0
      ? { fromAddress }
      : {}),
    ...(fromName !== undefined && fromName.length > 0
      ? { fromName }
      : {}),
  });
}
