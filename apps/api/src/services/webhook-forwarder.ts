// Shared construction for the inbound-mail webhook routes.
//
// rc.19 — cut over from Gmail SMTP / SES inbound to Resend for both
// outbound and inbound. The EmailForwarder reads RESEND_API_KEY from
// env; without it, the forwarder runs in log-only mode (dev path).

import { Buffer } from "node:buffer";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
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

// Reuse a single S3 client (lazy-init so tests/dev without AWS creds
// still load this module).
//
// rc.19 — kept in place because the legacy SES inbound route still
// fetches raw mail from S3. Once SES inbound is torn down, this and
// the AWS SDK dep can come out together.
let s3Client: S3Client | null = null;
function getS3Client(): S3Client {
  if (s3Client === null) {
    s3Client = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
  }
  return s3Client;
}

// Fetch a raw RFC 822 email from S3. SES inbound writes raw mail to a
// bucket; the ses-webhook route still uses this. Resend's inbound
// path posts already-parsed bodies and never touches S3.
export async function fetchRawEmailFromS3(bucket: string, key: string): Promise<Buffer> {
  const res = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (res.Body === undefined) throw new Error("s3_empty_body");
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
