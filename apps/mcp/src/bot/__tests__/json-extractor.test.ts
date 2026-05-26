// 0.6.15-rc.11 — extractJsonObject's stack-based first-balanced-object
// extraction. The previous greedy regex `\{[\s\S]*\}` couldn't handle
// LLM replies that emit multiple JSON objects (it spanned from the
// first `{` to the LAST `}`, swallowing everything in between).
//
// extractJsonObject is module-private, so we exercise it through its
// public caller parsePostVerifyStep — pass a multi-object payload,
// assert the first object's fields land on the parsed step.

import { describe, expect, it } from "vitest";
import { parsePostVerifyStep } from "../agent.js";

describe("extractJsonObject (post-verify planner) — multi-object tolerance", () => {
  it("parses the first object when the model emits two in sequence", () => {
    // Real failure case observed mid-OpenRouter signup: planner returned
    // a fill step, then on a new line a follow-up click step. The old
    // greedy match spanned both and JSON.parse rejected with "Unexpected
    // non-whitespace character after JSON at position N".
    const raw =
      '{"kind":"fill","selector":"#name","value":"my-key","reason":"Fill the name field"}\n' +
      '{"kind":"click","selector":"button.create","reason":"Click create"}';
    const step = parsePostVerifyStep(raw);
    expect(step.kind).toBe("fill");
    if (step.kind === "fill") {
      expect(step.selector).toBe("#name");
      expect(step.value).toBe("my-key");
    }
  });

  it("tolerates a trailing prose explanation after the JSON", () => {
    const raw =
      '{"kind":"done","reason":"signup complete"}\n' +
      "And then the bot extracts the credential from the modal.";
    const step = parsePostVerifyStep(raw);
    expect(step.kind).toBe("done");
  });

  it("handles a markdown-fenced single object correctly (no regression)", () => {
    const raw = "```json\n{\"kind\":\"done\",\"reason\":\"all done\"}\n```";
    const step = parsePostVerifyStep(raw);
    expect(step.kind).toBe("done");
  });

  it("respects string-literal braces inside the value", () => {
    // A JSON object whose value contains `}` inside a string. The
    // stack walker must not treat the in-string `}` as a closer.
    const raw =
      '{"kind":"fill","selector":"#name","value":"a value with } brace inside","reason":"x"}';
    const step = parsePostVerifyStep(raw);
    expect(step.kind).toBe("fill");
    if (step.kind === "fill") {
      expect(step.value).toBe("a value with } brace inside");
    }
  });

  it("throws cleanly on no-object input", () => {
    expect(() => parsePostVerifyStep("just prose, no JSON here")).toThrow(
      /no JSON object in reply/,
    );
  });
});
