import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RankedMemory } from "../../../lib/api";
import { RecallPanel } from "../RecallPanel";

describe("RecallPanel", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("shows an explicit nothing-matched state when recall returns an empty list", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "memory_recall") return [];
      return null;
    });

    render(<RecallPanel />);

    const input = screen.getByRole("textbox", { name: "Test recall query" });
    fireEvent.change(input, { target: { value: "xylophone" } });
    fireEvent.click(screen.getByRole("button", { name: "Test recall" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("memory_recall", {
        query: "xylophone",
        sessionId: null,
        topK: null,
        kinds: null,
      }),
    );
    expect(await screen.findByText(/nothing matched/i)).toBeInTheDocument();
  });

  it("renders each hit with owner type, kind, title, content, score, and Rust's reason verbatim", async () => {
    const hits: RankedMemory[] = [
      {
        ownerType: "memory",
        ownerId: "m-1",
        kind: "project_fact",
        title: "Database choice",
        content: "Convo stores local state in SQLite with FTS5.",
        score: 0.0328,
        reason: 'matched "sqlite" in content · recalled 7× · updated 4 days ago',
      },
      {
        ownerType: "note",
        ownerId: "n-1",
        kind: "note",
        title: "Release runbook",
        content: "Tag, push, and wait for CI.",
        score: 0.0161,
        reason: "semantic similarity 0.84 · updated today",
      },
    ];
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "memory_recall") return hits;
      return null;
    });

    render(<RecallPanel />);

    fireEvent.change(screen.getByRole("textbox", { name: "Test recall query" }), {
      target: { value: "how is data stored" },
    });
    fireEvent.submit(screen.getByRole("textbox", { name: "Test recall query" }).closest("form")!);

    expect(await screen.findByText("Database choice")).toBeInTheDocument();
    expect(screen.getByText("Convo stores local state in SQLite with FTS5.")).toBeInTheDocument();
    expect(
      screen.getByText('matched "sqlite" in content · recalled 7× · updated 4 days ago'),
    ).toBeInTheDocument();
    expect(screen.getByText("Release runbook")).toBeInTheDocument();
    expect(screen.getByText("semantic similarity 0.84 · updated today")).toBeInTheDocument();
    expect(screen.getByText("0.033")).toBeInTheDocument();
  });
});
