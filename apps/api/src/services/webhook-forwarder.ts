// Shared construction for the inbound-mail webhook routes.
//
// Every inbound-mail webhook (ses, resend, postfix, fly-email) needs the
// same EmailForwarder built from the same GMAIL_USER / GMAIL_APP_PASSWORD
// env pair. This block was copy-pasted across four route files and had
// already drifted in style; it lives here now as one helper.

import { Buffer } from "node:buffer";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { EmailForwarder, DEFAULT_ALIASES } from "./email-forwarder.js";

// Build the Gmail-backed EmailForwarder, or fall back to a log-only
// forwarder when GMAIL_USER / GMAIL_APP_PASSWORD aren't configured.
// `override` lets tests inject a stub forwarder.
export function buildEmailForwarder(override?: EmailForwarder): EmailForwarder {
  if (override !== undefined) return override;
  const gmailConfig =
    process.env.GMAIL_USER !== undefined && process.env.GMAIL_APP_PASSWORD !== undefined
      ? {
          gmailUser: process.env.GMAIL_USER,
          gmailAppPassword: process.env.GMAIL_APP_PASSWORD,
        }
      : undefined;
  return new EmailForwarder(DEFAULT_ALIASES, gmailConfig);
}

// Reuse a single S3 client (lazy-init so tests/dev without AWS creds
// still load this module).
let s3Client: S3Client | null = null;
function getS3Client(): S3Client {
  if (s3Client === null) {
    s3Client = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
  }
  return s3Client;
}

// Fetch a raw RFC 822 email from S3. The SES rule writes raw mail to a
// bucket; both the ses-webhook route and the SesHandler fetcher path
// previously re-implemented this stream-drain — it's consolidated here.
export async function fetchRawEmailFromS3(bucket: string, key: string): Promise<Buffer> {
  const res = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (res.Body === undefined) throw new Error("s3_empty_body");
  // Body is a readable stream in Node; AWS SDK v3 typings expose it as an
  // async-iterable StreamingBlobPayloadOutputTypes.
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
