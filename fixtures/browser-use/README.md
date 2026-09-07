# Canonical browser-use oracle

Run `bash scripts/capture-browser-use.sh` from this checkout. The script creates
an isolated Python environment under `.local/browser-use`, installs exactly
`browser-use==0.13.10`, and captures the fixed six-URL corpus with Chrome at
1280 × 800, viewport threshold 0 and cross-origin iframe support enabled. It does not use an LLM.

Each `.txt` is `SerializedDOMState.llm_representation()` written verbatim, with
no trailing newline added. Each matching `.json` records the capture timestamp,
version, URL, viewport, output SHA-256, and enhanced DOM inputs. The JSON records
capture/view properties, not the serializer's inclusion or rendering decisions.
Both files must be committed together. Never hand-edit expected output.

`bash scripts/capture-browser-use.sh --check` compares a fresh live capture to
the stored output and reports **STALE FIXTURES** on drift. `--slug ipinfo` limits
a capture or check to one site. Offline tests feed the recorded input to the
TypeScript serializer: a mismatch there is a **port failure**, not site drift.
Only bracketed element identities immediately followed by a tag are normalized;
whitespace, hierarchy, text, attributes, new markers, order and scroll markers
must match exactly.

Paint-order filtering is explicitly disabled in the canonical captures for this
phase, as authorized by the engineering review. It needs new paint-order CDP
capture/processing and is the named follow-up in `docs/browser-use-serializer-port.md`.
Viewport scoping and 99% containment filtering remain enabled.

Source: [browser-use 0.13.10 on PyPI](https://pypi.org/project/browser-use/0.13.10/).
The port's MIT notice ships in `apps/mcp/assets/licenses/browser-use-MIT.txt`.

Canonical equality is checked **before screening**, normalizing identity only.
The unchanged secret-shape detection rules are tested separately. Corpus-wide
structural-invariance assertions require screening to change only redacted spans,
with identical line counts, indentation and refs. The HN fixture explicitly pins
`usernametaken29` becoming `[redacted]`: redacting this plain lowercase-plus-digits
username is a **redactor false positive** worth tuning in a separate task, not in
this port. This limitation must also be recorded in the PR body.
