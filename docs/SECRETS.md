# Secrets: sealing, masking, and steering

**Status: updated 2026-09-12. Do not relitigate without new evidence.**

## Decision

There is no general masking, sealing, redaction, or read refusal on the
operator's read path. Observation, screenshot, extract, and observe-query
return what is on the page except for one exact-value boundary: after a card is
released, its complete PAN and security code are masked from normal
model-facing output. No secret-shape detector runs on any read.

Removed in PR #663 after the seals blocked the product's core job: signing up
for a service and coming away with the key. On the BrowserStack settings page,
the screenshot fence fired ("a live secret is here, you may not look") while the
extractor on the same page at the same moment reported "nothing is revealed, I
won't fetch it." Two detectors, opposite answers, and the operator was boxed out
of a key the page was plainly displaying.

## Why read-side masking cannot be made correct

Not the code — the classification. Credentials have no reliable shape.

Peer-reviewed evidence (Basak et al., NCSU, 2023, arXiv:2307.00714 — 9 tools,
97,479 labeled secrets, 818 repos):

| Tool | Precision | Recall |
|---|---|---|
| GitHub Secret Scanner | 75% | 6% |
| Gitleaks | 46% | 88% |
| Commercial X | 25% | 48% |
| ggshield (GitGuardian) | 19% | 26% |
| TruffleHog | 6% | 52% |
| four others | ≤5% | — |

- Best precision catches 6% of secrets. Best recall is wrong more than half the
  time. No tool has both. Five of nine are wrong >93% of the time.
- Entropy does not discriminate: a real key scored 4.08, the string
  `ThisIsAReallyLongString` scored 4.11.
- Git commit IDs, coupon codes, order numbers, build hashes, and 20-char
  alphanumeric keys are indistinguishable by shape.
- Those numbers are on *source code*, where a false positive costs a human two
  seconds. On an operator read path a false positive is a failed task.

So a read-side detector delivers both failure modes at once: it blocks
legitimate work (false positives) and still leaks (false negatives). You pay the
cost without getting the guarantee.

The only technique that actually works is **verification** — call the provider
to test whether a candidate is live. That requires a known provider and endpoint,
so it cannot run on an arbitrary page. It is useless for masking on read.

## What guards secrets instead

The vault remains the boundary for provider credentials: `use_credential` and
egress grants inject them server-side without returning their values. Payment
cards use the existing single human purchase approval, and `inject_card` opens
the selected card only inside the operator.

Before the first card write, the operator registers that released complete PAN
and CVV/CVC/CID in a session-persistent output mask. Normal DOM, AX, network,
error, log, and screenshot output masks only those values; it does not refuse a
read or browser action. This is deliberately not a Luhn-wide or general secret
scanner, and it does not claim containment against hostile pages that split,
encode, or draw the value.

## The rule

A refusal is never a safety mechanism. If a guard's failure mode is blocking
the operator, it is the wrong guard.

## Steering agents vault-first

The remaining goal is not to hide keys from agents but to make the vault path
the *shorter* path, so agents take it by default:

- `extract` vaults a revealed credential and returns a reference. It must
  never reject a candidate on shape.
- `use_credential` and egress grants deploy a vaulted credential to its
  destination without the value ever reaching the model. Common destinations
  (GitHub Actions secrets, `.env`, Fly/Vercel env) need first-class targets;
  without them the agent has no choice but to read plaintext.
- Reading a key in plaintext is legitimate when no egress target exists. The
  agent should say so.

Steer by making the vault path shorter, never by making the plaintext path
longer.
