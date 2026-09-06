import { describe, expect, it } from "vitest";
import { experimentalMultiSessionEnabled } from "../multisession-flag.js";

describe("experimentalMultiSessionEnabled", () => {
  it("is off when the env var is unset", () => {
    expect(experimentalMultiSessionEnabled({})).toBe(false);
  });

  it.each(["0", "false", "off", "no", "", "  ", "nonsense"])("is off for %j", (value) => {
    expect(
      experimentalMultiSessionEnabled({ TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION: value }),
    ).toBe(false);
  });

  it.each(["1", "true", "yes", "on", "TRUE", " 1 "])("is on for %j", (value) => {
    expect(
      experimentalMultiSessionEnabled({ TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION: value }),
    ).toBe(true);
  });
});
