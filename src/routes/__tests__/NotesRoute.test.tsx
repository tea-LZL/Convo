import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, Note, NoteWithLinks } from "../../lib/api";
import { NotesRoute } from "../NotesRoute";

const note: Note = {
  id: "note-1",
  title: "Release notes",
  body: "Provider setup",
  tags: "release",
  source_session_id: null,
  source_message_id: null,
  created_at: "now",
  updated_at: "now",
  pinned: false,
};

// list_notes answers with the note plus the memories it produced; the route
// unwraps the note out of that envelope.
const linked = (n: Note): NoteWithLinks => ({ note: n, linked_memories: [] });

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

  it("preserves the draft when saving fails and supports tag filtering", async () => {
    vi.spyOn(api, "listNotes").mockResolvedValue([linked(note)]);
    vi.spyOn(api, "upsertNote").mockRejectedValue(new Error("disk full"));

    render(
      <MemoryRouter>
        <NotesRoute />
      </MemoryRouter>,
    );
    expect(await screen.findByDisplayValue("Provider setup")).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("Provider setup"), { target: { value: "Draft retained" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByDisplayValue("Draft retained")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("disk full");

    fireEvent.change(screen.getByRole("textbox", { name: "Filter notes by tag" }), { target: { value: "missing" } });
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("shows an explicit retryable load error", async () => {
    vi.spyOn(api, "listNotes").mockRejectedValue(new Error("notes offline"));
    render(
      <MemoryRouter>
        <NotesRoute />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("notes offline");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
