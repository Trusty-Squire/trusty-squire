// The secret-slot surface: raw values stay in the Session, the host only ever
// sees a handle + masked preview.
import { describe, it, expect } from "vitest";
import { maskSecretValue } from "../slots.js";

describe("maskSecretValue (sealed transfer preview)", () => {
  it("masks the middle of a long secret, keeping a short head + tail", () => {
    const masked = maskSecretValue("GOCSPX-abcdef1234567890xyz");
    expect(masked).toContain("••••");
    expect(masked).not.toContain("abcdef1234567890");
    expect(masked.startsWith("GOCSPX")).toBe(true);
  });
  it("fully redacts a short value (no reconstructable prefix)", () => {
    expect(maskSecretValue("short")).toBe("••••");
  });
});
