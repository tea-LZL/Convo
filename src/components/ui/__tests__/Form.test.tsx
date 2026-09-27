import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Select } from "../Form";

const options = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

describe("Select", () => {
  it("exposes its options, reflects the value, and reports the change", () => {
    // This used to assert four utility classes. They were decoration, and
    // a restyle that kept the same four would have passed a test that says
    // nothing. So it says the thing that actually matters instead: a
    // select is a control that lists choices, shows which one is current,
    // and reports the one the user picked.
    const onChange = vi.fn();
    const { container } = render(<Select value="dark" onChange={onChange} options={options} />);

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(screen.getByRole("option", { name: "Dark" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Light" })).toBeInTheDocument();
    expect(select.value).toBe("dark");

    // `appearance-none` is only meaningful because the component draws its
    // own indicator. Suppress the native arrow and forget the chevron and
    // the control loses both.
    expect(container.querySelector("svg[aria-hidden='true']")).not.toBeNull();

    fireEvent.change(select, { target: { value: "light" } });
    expect(onChange).toHaveBeenCalledWith("light");
  });

  it("preserves disabled state with readable disabled styling", () => {
    // This assertion encodes meaning rather than decoration: a disabled
    // control has to *look* disabled, and `toBeDisabled()` alone would
    // pass on one that looks perfectly enabled. So the visible affordance
    // is asserted by name, whichever class ends up carrying it.
    //
    // `disabled:opacity-100` is load-bearing, not a mistake to fix: the
    // global `select:disabled` rule in globals.css already recolours a
    // disabled select with the muted text and the raised surface, and a
    // further opacity reduction would fight that treatment instead of
    // reinforcing it. `disabled:cursor-not-allowed` is the half that works
    // from the class list alone.
    render(<Select value="dark" onChange={vi.fn()} options={options} disabled />);

    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByRole("combobox")).toHaveClass("disabled:opacity-100", "disabled:cursor-not-allowed");
  });
});
