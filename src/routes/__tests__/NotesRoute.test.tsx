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

describe("NotesRoute pinning and provenance", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, "searchNotes").mockResolvedValue([]);
    vi.spyOn(api, "upsertNote").mockResolvedValue("note-1");
    vi.spyOn(api, "setNotePinned").mockResolvedValue(undefined);
    vi.spyOn(api, "unlinkMemoryFromNote").mockResolvedValue(undefined);
  });

  it("pins through set_note_pinned and shows the new state", async () => {
    let pinned = false;
    vi.spyOn(api, "listNotes").mockImplementation(async () => [
      { note: { ...note, pinned }, linked_memories: [] },
    ]);
    vi.spyOn(api, "setNotePinned").mockImplementation(async (_id, next) => { pinned = next; });

    render(
      <MemoryRouter>
        <NotesRoute />
      </MemoryRouter>,
    );

    const pin = await screen.findByRole("button", { name: "Pin Release notes" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    expect(pin).toHaveAttribute("title", expect.stringContaining("only when it is relevant"));

    fireEvent.click(pin);
    await waitFor(() => expect(api.setNotePinned).toHaveBeenCalledWith("note-1", true));
    // The row follows the result, not the click: state comes from the
    // re-read list, so a pin the backend refused cannot look set.
    expect(await screen.findByRole("button", { name: "Unpin Release notes" })).toHaveAttribute("aria-pressed", "true");

    // The editor's save must not carry the pin back; upsert_note ignores it
    // on update precisely so it cannot unpin what was set here.
    expect(api.upsertNote).not.toHaveBeenCalled();
  });

  it("lists the memories a note produced, marking the replaced one, and unlinks one", async () => {
    const links = [
      { id: "m-1", title: "Friday deploy window", content: "Ships land after 2pm on Fridays.", is_enabled: true, superseded_by: null },
      { id: "m-2", title: "Deploy window", content: "Ships land any time on Fridays.", is_enabled: true, superseded_by: "m-1" },
      { id: "m-3", title: "Release checklist", content: "Tag, changelog, announce.", is_enabled: false, superseded_by: null },
    ];
    vi.spyOn(api, "listNotes").mockResolvedValue([{ note, linked_memories: links }]);

    render(
      <MemoryRouter>
        <NotesRoute />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Produced 3 memories")).toBeInTheDocument();
    // Superseded rows are struck through and labelled, not hidden: the note
    // produced them and the correction history is the point.
    expect(screen.getByText("Deploy window")).toHaveClass("line-through");
    expect(screen.getByText("replaced")).toBeInTheDocument();
    expect(screen.getByText("Friday deploy window")).not.toHaveClass("line-through");
    expect(screen.getByText("disabled")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Unlink Release checklist from this note" }));
    await waitFor(() => expect(api.unlinkMemoryFromNote).toHaveBeenCalledWith("note-1", "m-3"));
  });

  it("claims nothing about provenance when the row came from search", async () => {
    vi.spyOn(api, "searchNotes").mockResolvedValue([note]);
    vi.spyOn(api, "listNotes").mockResolvedValue([]);

    render(
      <MemoryRouter>
        <NotesRoute />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "release" } });
    expect(await screen.findByDisplayValue("Provider setup")).toBeInTheDocument();
    // search_notes returns plain notes, so links are unknown, not empty.
    expect(screen.queryByText(/^Produced/)).not.toBeInTheDocument();
  });
});
