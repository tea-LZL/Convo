import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Select } from "../Form";

const options = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

describe("Select", () => {
  it("uses theme-safe styling and forwards value changes", () => {
    const onChange = vi.fn();
    const { container } = render(<Select value="dark" onChange={onChange} options={options} />);

    const select = screen.getByRole("combobox");
    expect(select).toHaveClass("appearance-none", "bg-surface-2", "text-text", "pr-8");
    expect(screen.getByRole("option", { name: "Dark" })).toBeInTheDocument();
    expect(container.querySelector("svg[aria-hidden='true']")).not.toBeNull();

    fireEvent.change(select, { target: { value: "light" } });
    expect(onChange).toHaveBeenCalledWith("light");
  });

  it("preserves disabled state with readable disabled styling", () => {
    render(<Select value="dark" onChange={vi.fn()} options={options} disabled />);

    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByRole("combobox")).toHaveClass("disabled:opacity-100", "disabled:cursor-not-allowed");
  });
});
