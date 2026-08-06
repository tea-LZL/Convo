import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { NotesRoute } from "../NotesRoute";

const note = {
  id: "note-1",
  title: "Release notes",
  body: "Provider setup",
  tags: "release",
  source_session_id: null,
  source_message_id: null,
  created_at: "now",
  updated_at: "now",
};

describe("NotesRoute command contract", () => {
  beforeEach(() => {
    vi.spyOn(api, "listNotes").mockResolvedValue([]);
    vi.spyOn(api, "searchNotes").mockResolvedValue([note]);
  });

  it("uses the registered search_notes command for note search", async () => {
    render(
      <MemoryRouter>
        <NotesRoute />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "release" } });
    await waitFor(() => expect(api.searchNotes).toHaveBeenCalledWith("release"));
  });
});
