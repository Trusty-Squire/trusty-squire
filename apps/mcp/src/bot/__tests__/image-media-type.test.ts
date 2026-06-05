// Regression guard for the planner image media-type bug surfaced by the live
// eval baseline: a PNG screenshot labeled "image/jpeg" makes the Anthropic
// premium fallback 400 ("the image appears to be a image/png image"). The
// label must follow the bytes — base64 of PNG magic (\x89PNG) is "iVBOR",
// JPEG (\xFF\xD8\xFF) is "/9j/".

import { describe, expect, it } from "vitest";
import { imageMediaType } from "../agent.js";

describe("imageMediaType", () => {
  it("detects a PNG payload (eval corpus 1x1 sentinel)", () => {
    const blankPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    expect(imageMediaType(blankPng)).toBe("image/png");
  });

  it("defaults to JPEG for live screenshot bytes (Playwright type:jpeg)", () => {
    expect(imageMediaType("/9j/4AAQSkZJRgABAQAAAQABAAD")).toBe("image/jpeg");
    // anything not PNG-magic → jpeg (the production default)
    expect(imageMediaType("someOtherBase64Payload")).toBe("image/jpeg");
  });
});
