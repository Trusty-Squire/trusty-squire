// Run-binding hash — ties a Delta to a specific in-flight Run so the
// approval can't be replayed against a different (e.g. costlier) action.
//
// Format is fixed: sha256 of "${run_id}|${service}|${plan}|${cost_cents}"
// UTF-8 bytes, hex-encoded. The signer side (mobile / desktop device)
// computes the same string from the proposed action and includes the
// hash in the Delta payload it signs. The validator recomputes from
// the Delta's action subobject and compares.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Delta } from "./types.js";

export function computeRunBinding(action: Delta["action"]): string {
  const data = `${action.run_id}|${action.service}|${action.plan}|${action.cost_cents}`;
  return createHash("sha256").update(Buffer.from(data, "utf8")).digest("hex");
}
