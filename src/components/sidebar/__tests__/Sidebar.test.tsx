import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../lib/api";
import { useSessionsStore } from "../../../stores/sessions";
import { Sidebar } from "../Sidebar";

// Spec section 9. NAV is the only ordered list of sections in the app,
// so the rendered order of the nav is asserted as one sequence: five
// independent lookups would pass in any order and catch nothing.
const NAV_ORDER = ["Chat", "Notes", "Memory", "Compare", "Documents", "Tasks"];

const NAV_PATHS: Array<[string, string]> = [
  ["Chat", "/chat"],
  ["Notes", "/notes"],
  ["Memory", "/memory"],
  ["Compare", "/compare"],
  ["Documents", "/documents"],
  ["Tasks", "/tasks"],
];

function LocationProbe() {
  const { pathname } = useLocation();
  return <span data-testid="path">{pathname}</span>;
}

// The sidebar resolves appInfo on mount, so the first assertions have to
// wait for that state update rather than race it.
async function renderSidebar(collapsed = false) {
  vi.spyOn(api, "appInfo").mockResolvedValue({
    version: "0.7.0",
    data_dir: "/tmp",
    db_path: "/tmp/convo.db",
    os: "linux",
    arch: "x86_64",
  });
  vi.spyOn(api, "listSessions").mockResolvedValue([]);
  render(
    <MemoryRouter initialEntries={["/chat"]}>
      <Sidebar collapsed={collapsed} onToggle={() => {}} />
      <LocationProbe />
    </MemoryRouter>,
  );
  await act(async () => {});
}

describe("Sidebar nav", () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeId: null, loading: false, error: null });
  });

  it("renders the spec order in the expanded nav", async () => {
    await renderSidebar();
    const nav = within(screen.getByRole("navigation"));
    const names = nav
      .getAllByRole("button")
      .map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "");
    expect(names).toEqual(NAV_ORDER);
  });

  it("renders the same order when collapsed to icons", async () => {
    await renderSidebar(true);
    const names = screen
      .getAllByRole("button", { name: new RegExp(`^(${NAV_ORDER.join("|")})$`) })
      .map((el) => el.getAttribute("aria-label") ?? "");
    expect(names).toEqual(NAV_ORDER);
  });

  it("keeps every label bound to the path it had before the reorder", async () => {
    await renderSidebar();
    const nav = within(screen.getByRole("navigation"));
    for (const [label, path] of NAV_PATHS) {
      fireEvent.click(nav.getByRole("button", { name: label }));
      expect(screen.getByTestId("path")).toHaveTextContent(path);
    }
  });
});
