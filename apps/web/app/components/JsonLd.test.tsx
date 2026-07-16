import { describe, expect, it } from "vitest";
import { serializeJsonLd } from "./JsonLd";

describe("JSON-LD serialization", () => {
  it("escapes opening angle brackets so injected markup cannot terminate the script", () => {
    expect(serializeJsonLd({ answer: "</script><script>alert(1)</script>" })).toBe(
      '{"answer":"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"}',
    );
  });
});
