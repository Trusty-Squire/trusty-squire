// Local copy of the RFC 8785 JCS canonicalizer. We import it from the
// Vouchflow SDK rather than pulling in the `canonicalize` npm package
// again — the SDK already canonicalizes inputs before signing, and
// re-exports the function so customers can pre-compute the canonical
// form for display/debugging.

export { canonicalize as canonicalString } from "@vouchflow/web";
