/**
 * Notes — a two-pane editor, and one of the three pages that keep the
 * *standard* rhythm.
 *
 * ── The rhythm, and which list it governs ────────────────────────────
 * The design has two. The standard one is an 8px step between rows and
 * 12px inside a card; the compact one — Memory's, and Documents' and
 * Tasks' — is 4px and 8px. The split is deliberate and is not a toggle:
 * a page is dense because its content is a pile to scan, and Notes is not
 * a pile. It is one note being read and written, with a list of them
 * beside it for navigation.
 *
 * So the density question only really applies to Notes' *card* list —
 * the memories a note produced, under the editor's tags — and that is
 * the list the test measures. The note list beside the editor is a
 * navigation list: no card, no border, no step, just rows that stack.
 * A test that measured it would be measuring the absence of a rhythm.
 *
 * The numbers are *measured*, not spelled: `NotesRoute.test.tsx` compiles
 * the classes this file renders through the project Tailwind and asserts
 * the resolved gap and padding, and it resolves the compact rhythm the
 * same way and asserts the measurement can tell the two apart. Retuning
 * the scale moves both sides. A test that read `space-y-2` off the DOM
 * would break on the retune and pass on any page that merely said it.
 *
 * ── What is deliberately not here ─────────────────────────────────────
 * No shadow. A card in this design is a surface and a 1px border, and the
 * only `box-shadow` in the app belongs to things that genuinely float —
 * a modal, a dropdown, a tooltip. None of those are on this page except
 * the delete confirmation, which is one of them. Focus rings are the
 * exception to the flatness rule and each one is behind a state:
 * Tailwind builds `ring-*` out of `box-shadow`, so a ring that was not
 * scoped would put a shadow on every row at rest.
 *
 * ── Controls ─────────────────────────────────────────────────────────
 * Every row control is 24px, not the ~19px a bare icon button with 4px
 * of padding gives. WCAG 2.2's target size is a requirement rather than
 * a preference, and the pin and unlink columns cost the row nothing
 * either way — same ruling as the Memory page's four row controls, and
 * the same reason: the density split is about spacing between rows, not
 * about shrinking the one thing a user has to hit.
 *
 * The two search fields are hand-composed rather than `TextInput`, for
 * the reason `MemoryRoute`'s is: `TextInput` hardcodes `text-sm` and
 * `px-3`, which cannot be overridden from `className` without depending
 * on the order Tailwind happens to emit two same-property utilities in.
 * A 30px field in a 240px pane is the right height, so the coupling is
 * paid deliberately rather than by accident.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Trash2, Save, Search, StickyNote, Tag, MessageSquare, Pin, PinOff, Unlink } from "lucide-react";
import { api, Note, NoteLink } from "../lib/api";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { RouteShell } from "../components/ui/RouteShell";
import { ROW_ACTION } from "../components/ui/rowAction";
import { Badge } from "../components/ui/Form";
import { appendToChatDraft } from "../components/chat/ChatInput";
import { toast } from "../stores/toasts";

/**
 * One row in the sidebar. `links` is what `list_notes` attached to the note
 * and `null` when the row came from `search_notes`, which returns plain
 * notes. `null` means "not loaded" and renders nothing; an empty array means
 * "loaded, and this note produced nothing", and those are different claims.
 */
type NoteRow = { note: Note; links: NoteLink[] | null };


/**
 * The 10px tag chip, stated once.
 *
 * `Badge` has the same geometry but is uppercase with wide tracking, and a
 * note's own tags are the note's words rather than a status — so this is
 * the `MemoryRoute` `CHIP` in miniature: one spelling, a theme radius, and
 * no `title` to lose. The note list is a navigation list, so the chip is
 * decoration on a control, not a control.
 */
const TAG_CHIP = "inline-flex items-center rounded-sm border border-border bg-surface-1 text-text-subtle text-[10px] leading-none px-1 py-0.5";

/**
 * One spelling of a note's tags.
 *
 * The filter splits on commas and compares case-insensitively, so
 * `release, Release` is two chips that filter as one tag. Trimming,
 * de-duplicating and joining with `", "` at the write keeps the stored
 * value and the filter's reading of it the same fact.
 */
function normalizeTags(raw: string): string {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags.join(", ");
}

export function NotesRoute() {
  const [rows, setRows] = useState<NoteRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // The open note itself, not only its id. A search result list may not
  // contain the note being edited, and the editor must not disappear just
  // because the list that navigates to it has been narrowed.
  const [activeNote, setActiveNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs for the event handlers that outlive a render: the keyboard
  // shortcut and the unload guard must read the current draft, not the one
  // that was on screen when their listener was attached.
  const activeIdRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const queryRef = useRef("");
  const requestRef = useRef(0);
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  queryRef.current = query;
  dirtyRef.current = dirty;

  const openNote = (note: Note) => {
    activeIdRef.current = note.id;
    setActiveId(note.id);
    setActiveNote(note);
    setTitle(note.title ?? "");
    setBody(note.body);
    setTags(note.tags ?? "");
    setDirty(false);
  };

  const closeNote = () => {
    activeIdRef.current = null;
    setActiveId(null);
    setActiveNote(null);
    setTitle("");
    setBody("");
    setTags("");
    setDirty(false);
  };

  const fetchRows = async (): Promise<NoteRow[]> => {
    const q = queryRef.current.trim();
    // list_notes returns each note with the memories it produced; search
    // returns plain notes. The list is what the editor works on, so the
    // links ride along here rather than through every read — a second
    // fetch per open note would be a query per row for data this call
    // already delivered.
    if (q) return (await api.searchNotes(q)).map((note) => ({ note, links: null }));
    return (await api.listNotes()).map((linked) => ({
      note: linked.note,
      links: linked.linked_memories,
    }));
  };

  /**
   * Load the list, and let only the newest request land.
   *
   * Search fires on every settled keystroke, and a pin or a save also
   * refreshes. Without a sequence number a slow response to an older query
   * can arrive last and put the list back to what the user already
   * replaced — including its note selection.
   */
  const refresh = async (): Promise<NoteRow[]> => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchRows();
      if (request !== requestRef.current) return [];
      setRows(next);
      setHasLoaded(true);
      const currentId = activeIdRef.current;
      if (currentId) {
        // The open note is not always in this list (a search can exclude
        // it), but when it is, the row is the newer copy: pin state, title
        // and links all follow the backend.
        const found = next.find((row) => row.note.id === currentId)?.note;
        if (found) setActiveNote(found);
      } else if (next.length > 0) {
        openNote(next[0].note);
      }
      return next;
    } catch (e) {
      if (request !== requestRef.current) return [];
      setError(String(e));
      toast.error(String(e), "Notes could not be loaded");
      return [];
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  };

  // Debounced: a search field should not fire a query per keystroke, and
  // the list should not flash "Loading…" between every two letters. The
  // first (empty-query) load is immediate.
  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, query.trim() ? 200 : 0);
    return () => window.clearTimeout(timer);
    // The latest query is read through `queryRef`; re-running on every
    // render would restart the timer and never settle.
  }, [query]);

  const createNew = async () => {
    if (creating || savingRef.current) return;
    // A new note must not be the way an unsaved draft disappears. Save it
    // first, and if that fails, leave the editor exactly where it was.
    if (dirtyRef.current && !(await saveRef.current())) return;
    setCreating(true);
    try {
      queryRef.current = "";
      setQuery("");
      setTagFilter("");
      const id = await api.upsertNote({ body: "" });
      const next = await refresh();
      const created = next.find((row) => row.note.id === id)?.note;
      if (created) {
        openNote(created);
      } else {
        // A query cleared a moment ago may still have been in flight when
        // this note was created. The record is known-good even when the
        // list has not caught up, so open it rather than showing nothing.
        const ts = new Date().toISOString();
        openNote({
          id,
          title: null,
          body: "",
          tags: null,
          source_session_id: null,
          source_message_id: null,
          created_at: ts,
          updated_at: ts,
          pinned: false,
        });
      }
      requestAnimationFrame(() => titleInputRef.current?.focus());
    } catch (e) {
      setError(String(e));
      toast.error(String(e), "Note could not be created");
    } finally {
      setCreating(false);
    }
  };

  const save = async (): Promise<boolean> => {
    if (!activeIdRef.current || savingRef.current) return false;
    const noteId = activeIdRef.current;
    savingRef.current = true;
    setSaving(true);
    try {
      const normalizedTags = normalizeTags(tags);
      await api.upsertNote({
        id: noteId,
        title: title || null,
        body,
        tags: normalizedTags || null,
        // The editor owns the text, not the provenance. Omitting these
        // mapped to `null` in `api.upsertNote` and the UPDATE wrote both
        // columns away, so saving a note created from a message quietly
        // erased its "from chat" link.
        source_session_id: activeNote?.source_session_id ?? null,
        source_message_id: activeNote?.source_message_id ?? null,
      });
      if (normalizedTags !== tags) setTags(normalizedTags);
      setDirty(false);
      dirtyRef.current = false;
      await refresh();
      return true;
    } catch (e) {
      setError(String(e));
      toast.error(String(e), "Note could not be saved");
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  saveRef.current = save;

  const remove = async (id: string) => {
    try {
      await api.deleteNote(id);
      // Closing first lets `refresh` open the next note, the same way it
      // opens the first one on an empty editor.
      if (activeIdRef.current === id) closeNote();
      await refresh();
      return true;
    } catch (e) {
      setError(String(e));
      toast.error(String(e), "Note could not be deleted");
      return false;
    }
  };

  // Deliberate path, not the editor's save: `upsert_note` ignores `pinned`
  // on update, so writing it back from a save would unpin a note the user
  // pinned here. `set_note_pinned` also errors for an id that is not there
  // rather than reporting a pin that never took.
  const setPinned = async (note: Note, pinned: boolean) => {
    try {
      await api.setNotePinned(note.id, pinned);
      // Show the accepted state even when the note is not in the current
      // search results and `refresh` therefore cannot return a newer copy
      // of it.
      setActiveNote((current) => (current && current.id === note.id ? { ...current, pinned } : current));
      setRows((current) =>
        current.map((row) => (row.note.id === note.id ? { ...row, note: { ...row.note, pinned } } : row)),
      );
      await refresh();
    } catch (e) {
      setError(String(e));
      toast.error(String(e), "Pin could not be changed");
    }
  };

  const unlinkMemory = async (noteId: string, memoryId: string) => {
    try {
      await api.unlinkMemoryFromNote(noteId, memoryId);
      await refresh();
    } catch (e) {
      setError(String(e));
      toast.error(String(e), "Memory could not be unlinked");
    }
  };

  const addToChat = () => {
    if (!body.trim()) return;
    appendToChatDraft(body);
    toast.info("Added to chat draft");
  };

  // Ctrl/Cmd+S, and the browser's own close prompt. The listener is bound
  // once: `saveRef` and `dirtyRef` carry the current editor into it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (dirtyRef.current && activeIdRef.current) void saveRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      // Required by older webviews; Chromium shows its own prompt.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const notes = rows.map((r) => r.note);
  const activeRow = rows.find((r) => r.note.id === activeId);
  const active = activeRow?.note ?? activeNote;
  // One lookup while rendering, not a scan per linked row. `null` means
  // "this read did not carry links" (a search result) and renders nothing;
  // the retained note above is only for the editor itself.
  const activeLinks = activeRow?.links ?? null;
  const visibleNotes = notes.filter((note) => {
    if (!tagFilter.trim()) return true;
    return (note.tags ?? "").split(",").map((tag) => tag.trim().toLowerCase()).includes(tagFilter.trim().toLowerCase());
  });

  return (
    <RouteShell
      title="Notes"
      description="Capture durable notes with tags and links back to source chats."
      contentClassName="overflow-hidden"
      actions={<Button size="sm" variant="primary" onClick={() => void createNew()} loading={creating} icon={<Plus size={12} />}>New</Button>}
    >
    <div className="flex h-full min-h-0 flex-col sm:flex-row">
      <aside className="w-full sm:w-60 max-h-[42%] sm:max-h-none bg-surface-1 border-b sm:border-b-0 sm:border-r border-border flex flex-col shrink-0">
        <div className="px-3 py-2.5 border-b border-border flex items-center justify-between">
          {/* A group header, not a heading. It was an `h2` reading
              "Notes", the page's own title word for word, so a
              screen-reader user heard "Notes" twice and the nav list was
              a sibling of the editor it navigates rather than a label
              above it. This is the identical defect and the identical
              treatment `SettingsRoute`'s "Sections" label got, and it is
              the two spellings — same `text-group-header uppercase
              tracking-wider` on both — that prove the two routes were
              written to one rule and only one of them followed it.
              `NotesRoute.test.tsx` walks the outline in all three
              states the page can be in. */}
          <div className="text-[10px] uppercase tracking-wider text-group-header font-semibold">Notes</div>
        </div>
        <div className="p-2 border-b border-border space-y-1.5">
          <div className="relative">
            <Search size={12} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
            {/* Hand-composed, and the coupling is named in the file header:
                `TextInput`'s `text-sm` and `px-3` cannot be overridden from
                `className` without depending on the order Tailwind emits two
                same-property utilities in. Everything that does not fight the
                primitive — surface, radius, border, the focus ring — is
                `TextInput`'s, copied, so the two do not read as different
                controls. */}
            <input
              aria-label="Search notes"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="w-full bg-surface-2 border border-border rounded-md pl-7 pr-2 py-1 text-xs text-text placeholder:text-text-subtle focus:outline-none focus:border-accent focus:ring-2 focus:ring-text focus:ring-offset-2 focus:ring-offset-bg"
            />
          </div>
          <div className="relative">
            <Tag size={12} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
            <input
              aria-label="Filter notes by tag"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              placeholder="Filter tags…"
              className="w-full bg-surface-2 border border-border rounded-md pl-7 pr-2 py-1 text-xs text-text placeholder:text-text-subtle focus:outline-none focus:border-accent focus:ring-2 focus:ring-text focus:ring-offset-2 focus:ring-offset-bg"
            />
          </div>
        </div>
        {error && (
          <div role="alert" className="mx-2 mt-2 rounded-md border border-error/30 bg-error/10 px-2 py-1.5 text-xs text-error flex items-start gap-1">
            <span className="min-w-0 break-words">{error}</span>
            <button type="button" className="ml-auto shrink-0 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded" onClick={() => void refresh()}>Retry</button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto py-1">
          {loading && !hasLoaded ? (
            <div className="p-4 text-xs text-text-muted text-center">Loading notes…</div>
          ) : visibleNotes.length === 0 ? (
            <div className="p-4 text-xs text-text-muted text-center">{query || tagFilter ? "No matches" : "No notes"}</div>
          ) : (
            <ul>
              {visibleNotes.map((n) => {
                const nt = (n.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
                const isActive = n.id === activeId;
                return (
                  <li key={n.id}>
                    <button
                      onClick={async () => {
                        // `dirty` here is the render-time value, so it stays
                        // true after a successful save and `if (dirty) return`
                        // would abort every first switch. The save's own
                        // result is the thing to branch on.
                        if (savingRef.current) return;
                        if (n.id === activeIdRef.current) {
                          if (dirty) await save();
                          return;
                        }
                        if (dirty && !(await save())) return;
                        // Saving the open note cannot change the text of
                        // the note being opened, so the row's snapshot is
                        // still the right content to populate from.
                        openNote(n);
                      }}
                      // `aria-pressed` rather than a colour alone: the rows
                      // are a one-of-a-many selection, and this is the same
                      // vocabulary the Tasks filter uses for the same shape.
                      aria-pressed={isActive}
                      // The selected note is a 2px accent rule plus a faint
                      // accent wash, not a second surface: the row sits on
                      // `surface-1` and `bg-surface-2` alone read as "a
                      // slightly different grey" rather than as a selection.
                      // The rule is on every row at rest as a transparent
                      // border, so the open note does not shift sideways.
                      className={`w-full text-left px-3 py-2 text-xs flex flex-col gap-0.5 border-l-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text ${
                        isActive ? "bg-accent/10 border-l-accent" : "border-l-transparent hover:bg-surface-2"
                      }`}
                    >
                      <span className="flex items-center gap-1">
                        {n.pinned && <Pin size={9} aria-hidden="true" className="text-accent shrink-0" />}
                        <span className={`font-medium truncate ${isActive ? "text-accent" : "text-text"}`}>{n.title || "Untitled"}</span>
                      </span>
                      <span className="text-text-subtle text-[10px] truncate">{n.body.slice(0, 60) || "(empty)"}</span>
                      {(nt.length > 0 || n.source_session_id) && (
                        <span className="flex flex-wrap items-center gap-1 mt-1">
                          {n.source_session_id && <MessageSquare size={9} aria-hidden="true" className="text-text-subtle" />}
                          {nt.slice(0, 3).map((t, j) => (
                            <span key={j} className={TAG_CHIP}>{t}</span>
                          ))}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {active ? (
          <>
             <div className="flex items-center gap-2 px-4 h-11 border-b border-border bg-surface-1">
              <input
                ref={titleInputRef}
                aria-label="Note title"
                value={title}
                onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
                placeholder="Title"
                className="bg-transparent text-sm font-medium text-text placeholder:text-text-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-text focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded flex-1 min-w-0"
              />
              {dirty && (
                <span role="status" className="text-[10px] text-warn" title="Unsaved changes">
                  <span aria-hidden="true">●</span>
                  <span className="sr-only">Unsaved changes</span>
                </span>
              )}
              <button
                type="button"
                onClick={() => void setPinned(active, !active.pinned)}
                aria-pressed={active.pinned}
                aria-label={active.pinned ? `Unpin ${active.title || "Untitled"}` : `Pin ${active.title || "Untitled"}`}
                title={active.pinned
                  ? "Pinned — this note is included in every chat, budget permitting. Unpin to make it recall-only."
                  : "Unpinned — this note is included only when it is relevant to what you are asking. Pin it to always include it."}
                className={`${ROW_ACTION} ${active.pinned ? "text-accent" : "text-text-subtle hover:text-text"}`}
              >
                {active.pinned ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}
              </button>
              <Button size="sm" variant="secondary" onClick={addToChat} disabled={!body.trim()} icon={<MessageSquare size={12} />}>Add to chat</Button>
              <Button size="sm" variant="ghost" onClick={() => setDeleteTargetId(activeId)} icon={<Trash2 size={12} />}>Delete</Button>
              <Button size="sm" variant="primary" onClick={save} loading={saving} disabled={!dirty} icon={<Save size={12} />}>Save</Button>
            </div>
            <div className="px-4 py-2 border-b border-border bg-surface-1/40 flex items-center gap-2">
              <Tag size={12} aria-hidden="true" className="text-text-subtle shrink-0" />
              <input
                aria-label="Note tags"
                value={tags}
                onChange={(e) => { setTags(e.target.value); setDirty(true); }}
                placeholder="tags (comma-separated)"
                className="flex-1 min-w-0 bg-transparent text-xs text-text placeholder:text-text-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-text focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded"
              />
              {active.source_session_id && (
                <Link
                  to={`/chat/${active.source_session_id}`}
                  className="text-[10px] text-accent hover:underline flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text focus-visible:ring-offset-2 focus-visible:ring-offset-bg shrink-0"
                  title="Open source chat"
                >
                  <MessageSquare size={10} aria-hidden="true" /> from chat
                </Link>
              )}
            </div>
            {activeLinks !== null && activeLinks.length > 0 && (
              <div className="border-b border-border bg-surface-1/40 px-4 py-3 shrink-0 max-h-48 overflow-y-auto">
                <div className="text-[10px] uppercase tracking-wider text-group-header font-semibold mb-2">
                  Produced {activeLinks.length === 1 ? "1 memory" : `${activeLinks.length} memories`}
                </div>
                {/* The page's card list, and the one the standard rhythm
                    governs: 8px between rows, 12px inside a card. The
                    spacing is asserted as resolved pixels in the test, not
                    as the class names used here. */}
                <ul className="space-y-2">
                  {activeLinks.map((link) => {
                    const replaced = link.superseded_by !== null;
                    return (
                      <li
                        key={link.id}
                        className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 p-3"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {link.title && (
                              <span className={`text-xs font-medium truncate ${replaced ? "text-text-subtle line-through" : "text-text"}`}>
                                {link.title}
                              </span>
                            )}
                            {/* Two `Badge`s rather than a hand-written pill:
                                the geometry, the radius and the 10px size are
                                the primitive's, and the tone is deliberately
                                the same for both — a chip's *text* is the
                                semantic channel here, exactly as it is on the
                                Memory page, and the strike-through beside it
                                is the second signal. */}
                            {replaced && <Badge variant="default">replaced</Badge>}
                            {!link.is_enabled && <Badge variant="default">disabled</Badge>}
                          </div>
                          <div className={`text-[11px] leading-relaxed text-text-muted mt-1 line-clamp-2 break-words ${replaced ? "line-through" : ""}`}>
                            {link.content}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void unlinkMemory(active.id, link.id)}
                          aria-label={`Unlink ${link.title || "memory"} from this note`}
                          title="Unlink — this memory is kept, only the claim that this note produced it is cleared."
                          className={`${ROW_ACTION} text-text-subtle hover:text-error`}
                        >
                          <Unlink size={12} aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            <textarea
              aria-label="Note body"
              value={body}
              onChange={(e) => { setBody(e.target.value); setDirty(true); }}
              placeholder="Write something…"
              className="flex-1 min-h-0 bg-bg text-sm text-text placeholder:text-text-subtle p-6 focus:outline-none resize-none"
            />
          </>
        ) : (
          <EmptyState
            // `RouteShell` owns this page's h1, so the title underneath
            // it is an h2 — an h3 here would be a skipped level.
            headingLevel={2}
            icon={<StickyNote size={28} />}
            title="No note open"
            description="Create a note to capture ideas. Pin one to include it in every chat, or add it to the composer when it belongs in the conversation."
            action={<Button onClick={createNew} variant="primary" icon={<Plus size={14} />}>New note</Button>}
          />
        )}
      </div>
      <ConfirmDialog
        open={deleteTargetId !== null}
        onClose={() => setDeleteTargetId(null)}
        onConfirm={async () => {
          if (deleteTargetId && await remove(deleteTargetId)) setDeleteTargetId(null);
        }}
        title="Delete note"
        message="Delete this note? This cannot be undone."
        confirmLabel="Delete"
        confirmVariant="danger"
      />
    </div>
    </RouteShell>
  );
}
