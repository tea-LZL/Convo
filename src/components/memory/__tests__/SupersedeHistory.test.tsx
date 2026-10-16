import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MemoryItem } from "../../../lib/api";
import { SupersedeHistory } from "../SupersedeHistory";

function item(id: string, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    kind: "project_fact",
    title: `Title ${id}`,
    content: `Content ${id}`,
    tags: null,
    is_enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    pinned: false,
    superseded_by: null,
    ...overrides,
  };
}

describe("SupersedeHistory", () => {
  it("names the replacement for a superseded row and makes the replacement reachable", () => {
    const oldMem = item("old-1", {
      title: "Deploy window",
      content: "Ships land any time on Fridays.",
      superseded_by: "new-1",
    });
    const newMem = item("new-1", {
      title: "Friday deploy window",
      content: "Ships land after 2pm on Fridays.",
      superseded_by: null,
    });
    const onSelect = vi.fn();

    render(
      <SupersedeHistory
        item={oldMem}
        items={[oldMem, newMem]}
        onSelectReplacement={onSelect}
      />,
    );

    const reachBtn = screen.getByRole("button", { name: "Replaced by Friday deploy window" });
    expect(reachBtn).toBeInTheDocument();
    fireEvent.click(reachBtn);
    expect(onSelect).toHaveBeenCalledWith(newMem);
  });

  it("renders nothing for a live row that has not been superseded", () => {
    const liveMem = item("live-1", {
      title: "Friday deploy window",
      content: "Ships land after 2pm on Fridays.",
      superseded_by: null,
    });

    const { container } = render(<SupersedeHistory item={liveMem} items={[liveMem]} />);
    expect(container.firstChild).toBeNull();
  });
});
