import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field } from "@/components/ui/Field";

describe("Field", () => {
  it("links label and input via id", () => {
    render(<Field label="Email" name="email" type="email" />);
    const input = screen.getByLabelText("Email");
    expect(input.id).toBe("email");
  });

  it("renders error in place of hint when both present", () => {
    render(<Field label="Email" name="email" hint="optional" error="required" />);
    expect(screen.getByRole("alert")).toHaveTextContent("required");
    expect(screen.queryByText("optional")).not.toBeInTheDocument();
  });

  it("sets aria-invalid when an error is shown", () => {
    render(<Field label="Email" name="email" error="bad" />);
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
  });
});
