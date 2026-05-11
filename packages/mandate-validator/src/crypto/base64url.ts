// Base64url codec — RFC 4648 §5 (URL-safe alphabet, no padding).
// Node has no built-in base64url decoder for binary buffers; we route
// via the standard "base64url" buffer encoding which handles missing
// padding and the URL alphabet correctly.

import { Buffer } from "node:buffer";

export function base64UrlDecode(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, "base64url"));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
