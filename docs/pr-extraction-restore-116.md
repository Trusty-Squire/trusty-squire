# Restore v1.1.6 credential selection

Restore v1.1.6 credential selection with the approved DeepInfra compatibility
exception, and reject identifier-only or truncated-only storage bundles. The
[credential capture contract](operator-tool-surface.md#credential-capture-and-retrieval)
owns the resulting behavior. Source-content test guards are replaced by
executable coverage.

## Accepted limitations

The accepted v1.1.6 exotic-DOM and multi-row masking limitations remain;
see the authoritative [credential capture contract](operator-tool-surface.md#credential-capture-and-retrieval).
This PR does not retune the broader selection or masking approach.

## Validation

Executable coverage includes the Exa keys-page fixture before and after reveal, both storage callers with a truncated key and Team ID, recovered-key precedence over labeled snippets, labeled and unlabeled DeepInfra near-copy keys, and Client Secret/Client ID leaves inside a pre block.
