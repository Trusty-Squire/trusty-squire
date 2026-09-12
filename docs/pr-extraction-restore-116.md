# Restore v1.1.6 credential selection

Restore the known-good v1.1.6 candidate selection and preserve the approved DeepInfra reconciliation. Identifier-labeled values such as Team ID remain named identifier fields and are never promoted to `api_key`. Values selected from the actual credential field are captured verbatim after the normal reveal pass. Client Secret and Client ID leaves remain extractable inside preformatted containers. Source-content test guards are removed in favor of executable coverage.

## Accepted limitations

Credential values are not screened, masked, redacted, or classified as truncated. The operator returns and stores the value rendered by the selected credential field. This follows the repository's settled observation and extraction policy; identifier exclusion is based on the field label, not on guessing from the value's shape.

## Validation

Executable coverage includes an Exa-style keys-page fixture with distinct Team ID and API Key fields, the same fixture after its reveal control surfaces a real key, labeled and unlabeled DeepInfra near-copy keys, and Client Secret/Client ID leaves inside a pre block.
