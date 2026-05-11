import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PolicyEditor } from "@/components/policy/PolicyEditor";
import { defaultPolicy } from "@/lib/mandate";

describe("PolicyEditor", () => {
  it("renders the current spend limit", () => {
    render(<PolicyEditor value={defaultPolicy()} onChange={() => {}} />);
    expect(screen.getByText(/Current: \$500\.00/)).toBeInTheDocument();
  });

  it("toggles a category off when its checkbox is clicked", () => {
    const onChange = vi.fn();
    render(<PolicyEditor value={defaultPolicy()} onChange={onChange} />);
    const hosting = screen.getByRole("checkbox", { name: /Hosting and deployment/i });
    expect(hosting).toBeChecked();
    fireEvent.click(hosting);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as { allowed_categories: string[] };
    expect(next.allowed_categories).not.toContain("hosting");
  });

  it("updates the silent-signup ceiling on number input change", () => {
    const onChange = vi.fn();
    render(<PolicyEditor value={defaultPolicy()} onChange={onChange} />);
    const input = screen.getByLabelText(/Silent signup ceiling/i);
    fireEvent.change(input, { target: { value: "2500" } });
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0]![0] as { silent_signup: { max_monthly_cost_cents: number } };
    expect(next.silent_signup.max_monthly_cost_cents).toBe(2500);
  });
});
