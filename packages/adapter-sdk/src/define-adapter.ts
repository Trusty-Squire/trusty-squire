// Identity builder — returns the manifest unchanged.
//
// Why a function instead of "just write the object literal": authors
// compose manifests with helpers (plan tables, common flows, etc.) and
// `defineAdapter` gives them a single named entry point to type-check
// the assembled result. Validation is deferred to registry publish time
// so authors aren't fighting the type system mid-composition.

import type { AdapterManifest } from "./types.js";

export function defineAdapter(manifest: AdapterManifest): AdapterManifest {
  return manifest;
}
