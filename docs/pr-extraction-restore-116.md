# Restore v1.1.6 credential selection

Restore the known-good v1.1.6 masked-value and identifier predicates and named-candidate selection. Preserve the approved DeepInfra reconciliation: a contextually accepted near-copy key survives generic API-key sanitization. Unmasked Client Secret and Client ID leaves remain extractable inside preformatted containers. Persistence excludes truncated metadata and refuses identifier-only bundles, so the Exa masked-only fixture cannot produce a successful vault write. Source-content test guards are removed in favor of executable coverage.

## Accepted limitations

This deliberately retains v1.1.6 behavior for exotic DOM layouts and multi-row masked displays. Split-node masks, substring scans of masked rows, and provider-specific rescans can still lose mask evidence and produce invalid credential storage or a successful outcome. The additional collector, truncation, secondary-token, provider, and value-screening persistence logic introduced during review has been removed under the explicit scope freeze. These pre-existing edge cases are not addressed by this PR.

## Validation

Executable coverage includes the Exa keys-page fixture before and after reveal, both storage callers with a truncated key and Team ID, recovered-key precedence over labeled snippets, labeled and unlabeled DeepInfra near-copy keys, and Client Secret/Client ID leaves inside a pre block.
