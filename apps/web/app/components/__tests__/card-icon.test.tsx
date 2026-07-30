// @vitest-environment happy-dom
// The wallet tile: network mark for recognized brands (inline SVG, no
// external fetches), monogram for named-but-unknown brands, generic card
// glyph for legacy/null.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { CardIcon } from "../CardIcon";

afterEach(() => cleanup());

describe("CardIcon", () => {
  it("renders the network mark for a recognized brand", () => {
    const { container } = render(<CardIcon brand="Visa" />);
    expect(container.querySelector('[data-network="visa"]')).not.toBeNull();
    expect(container.querySelector(".lm")).toBeNull();
  });

  it("maps a bank co-brand to its network mark", () => {
    const { container } = render(<CardIcon brand="Mastercard DBS" />);
    expect(container.querySelector('[data-network="mastercard"]')).not.toBeNull();
  });

  it("falls back to the monogram for a named-but-unrecognized brand", () => {
    const { container } = render(<CardIcon brand="Zeta" />);
    expect(container.querySelector("[data-network]")).toBeNull();
    expect(container.querySelector(".lm")?.textContent).toBe("Z");
  });

  it("shows the generic card glyph when there is no brand at all", () => {
    const { container } = render(<CardIcon brand={null} />);
    expect(container.querySelector("[data-network]")).toBeNull();
    expect(container.querySelector(".lm")).toBeNull();
    expect(container.querySelector("svg rect")).not.toBeNull();
  });
});
