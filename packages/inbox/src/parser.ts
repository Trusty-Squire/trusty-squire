// MIME parsing + link/OTP extraction.
//
// We call `mailparser` for the heavy lifting (header decoding,
// multipart unwrap, charset normalisation) and then run our own
// extraction passes over the parsed bodies. The OTP regex set runs in
// priority order — the first pattern that matches wins. Adapters may
// pass a custom regex which always takes precedence.

import { simpleParser, type ParsedMail } from "mailparser";
import { EncryptedEmailError } from "./types.js";

// Priority-ordered. The 6-digit standalone match is intentionally
// first — most modern providers send a bare 6-digit code. Lower-
// priority patterns handle older "Code: 1234" / "<strong>123456</strong>"
// formats. Order matters: each pattern is tried in turn against the
// FULL content, not regex-disjoined into one big alternation, so the
// caller can see which pattern fired (handy for triage).
const OTP_PATTERNS: ReadonlyArray<{ regex: RegExp; description: string }> = [
  { regex: /\b(\d{6})\b/, description: "6 digits standalone" },
  { regex: /code[:\s]+(\d{4,8})/i, description: "labeled 'code:'" },
  { regex: /verification[:\s]+(\d{4,8})/i, description: "labeled 'verification:'" },
  { regex: /<strong[^>]*>(\d{4,8})<\/strong>/i, description: "HTML strong" },
  { regex: /enter[:\s]+(\d{4,8})/i, description: "labeled 'enter:'" },
  { regex: /(\d{3})[-\s](\d{3})/, description: "3-3 split" },
];

const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;

export interface ParsedEmail {
  message_id: string;
  from_address: string;
  from_domain: string;
  subject: string;
  body_text: string | null;
  body_html: string | null;
  links: string[];
  codes: string[];
  to_addresses: string[];
}

export async function parseRfc822(raw: Buffer | string): Promise<ParsedEmail> {
  const parsed = await simpleParser(raw);

  // Reject PGP / S/MIME wrapped payloads. Detection is intentionally
  // liberal: any of the encryption-content headers triggers a hard
  // reject. Adapters that need encrypted email can revisit later.
  if (looksEncrypted(parsed)) throw new EncryptedEmailError();

  const fromAddress = primaryFromAddress(parsed);
  const fromDomain = fromAddress.includes("@")
    ? fromAddress.split("@")[1]?.toLowerCase() ?? ""
    : "";
  const messageId = parsed.messageId ?? `synthetic:${Date.now()}-${Math.random()}`;

  const bodyText = parsed.text ?? null;
  const bodyHtml = typeof parsed.html === "string" ? parsed.html : null;

  return {
    message_id: messageId,
    from_address: fromAddress,
    from_domain: fromDomain,
    subject: parsed.subject ?? "",
    body_text: bodyText,
    body_html: bodyHtml,
    links: extractLinks((bodyText ?? "") + " " + (bodyHtml ?? "")),
    codes: collectAllCodes((bodyText ?? "") + " " + (bodyHtml ?? "")),
    to_addresses: collectToAddresses(parsed),
  };
}

function looksEncrypted(parsed: ParsedMail): boolean {
  // mailparser parses Content-Type into a structured object
  // { value, params }, not a raw string — `String(...)` would emit
  // "[object Object]". Pull `.value` and also scan headerLines as a
  // fallback in case the shape changes across mailparser versions.
  const ct = parsed.headers.get("content-type");
  let contentType = "";
  if (typeof ct === "string") {
    contentType = ct.toLowerCase();
  } else if (ct !== null && typeof ct === "object") {
    const value = (ct as { value?: unknown }).value;
    if (typeof value === "string") contentType = value.toLowerCase();
  }
  if (contentType.includes("application/pgp-encrypted")) return true;
  if (contentType.includes("multipart/encrypted")) return true;
  if (contentType.includes("application/pkcs7-mime")) return true;
  for (const line of parsed.headerLines ?? []) {
    const lower = line.line.toLowerCase();
    if (lower.includes("multipart/encrypted")) return true;
    if (lower.includes("application/pgp-encrypted")) return true;
    if (lower.includes("application/pkcs7-mime")) return true;
  }
  return false;
}

function primaryFromAddress(parsed: ParsedMail): string {
  const from = parsed.from;
  if (from === undefined) return "";
  // mailparser's AddressObject normalises to either a single object
  // with a `value` array, or an array of those.
  const value = Array.isArray(from) ? from[0]?.value : from.value;
  if (value === undefined) return "";
  const first = value[0];
  return first?.address ?? "";
}

function collectToAddresses(parsed: ParsedMail): string[] {
  const to = parsed.to;
  if (to === undefined) return [];
  const arr = Array.isArray(to) ? to : [to];
  const out: string[] = [];
  for (const block of arr) {
    for (const entry of block.value ?? []) {
      if (entry.address !== undefined) out.push(entry.address);
    }
  }
  return out;
}

export function extractLinks(content: string): string[] {
  const matches = content.match(URL_REGEX);
  if (matches === null) return [];
  // Strip trailing punctuation that often clings to URLs in plain text
  // ("Visit https://x.com/foo." → drop the dot).
  const cleaned = matches.map((u) => u.replace(/[.,;:!?)\]]+$/, ""));
  return Array.from(new Set(cleaned));
}

// Single OTP — tried by priority order. Matches the spec API.
export function extractOtp(content: string, customPattern?: RegExp): string | null {
  if (customPattern !== undefined) {
    const m = content.match(customPattern);
    if (m !== null && m[1] !== undefined) return m[1];
    return null;
  }
  for (const { regex } of OTP_PATTERNS) {
    const m = content.match(regex);
    if (m !== null) return m.slice(1).join("");
  }
  return null;
}

// All OTPs in priority-pattern order — used when populating the
// ReceivedEmail.parsed_codes column at ingest time.
function collectAllCodes(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { regex } of OTP_PATTERNS) {
    // Global match per pattern so a single email with two codes
    // (e.g. "Code: 1234, backup: 5678") yields both.
    const globalRe = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = globalRe.exec(content)) !== null) {
      const code = m.slice(1).join("");
      if (code.length > 0 && !seen.has(code)) {
        seen.add(code);
        out.push(code);
      }
    }
  }
  return out;
}

// Substring-or-regex match used by the matcher. Strings are case-insensitive
// substring contains; RegExp uses .test() as-is.
export function matchString(value: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
  return pattern.test(value);
}
