/**
 * Unsaved Notes drafts, kept for the navigation that would otherwise lose
 * them.
 *
 * The Notes route is a single editor with no tab model, so a route change
 * unmounts the draft. React Router is a declarative `HashRouter` here, which
 * rules out `useBlocker` without migrating the whole app to a data router.
 * The editor therefore writes what it has to localStorage before it goes,
 * and offers it back the next time that note is open.
 *
 * One key per note, not one global slot. A single slot let a draft for note
 * A be overwritten by note B, and let saving B clear A's pending text.
 *
 * Access is wrapped rather than assumed: localStorage can throw when the
 * store is full or unavailable, and an editor must not fail open because a
 * recovery aid could not be written.
 */

export interface NoteDraft {
  noteId: string;
  title: string;
  body: string;
  tags: string;
  /** ISO timestamp, so the banner can say when the draft was put away. */
  savedAt: string;
}

export const NOTES_DRAFT_PREFIX = "convo:notes:draft:";

export function notesDraftKey(noteId: string): string {
  return `${NOTES_DRAFT_PREFIX}${noteId}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** A stored value, or nothing. Every field the banner needs is required. */
function parseDraft(raw: string | null): NoteDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof NoteDraft, unknown>>;
    if (typeof value.noteId !== "string" || !value.noteId) return null;
    if (typeof value.body !== "string") return null;
    if (typeof value.savedAt !== "string") return null;
    return {
      noteId: value.noteId,
      title: typeof value.title === "string" ? value.title : "",
      body: value.body,
      tags: typeof value.tags === "string" ? value.tags : "",
      savedAt: value.savedAt,
    };
  } catch {
    // A half-written or older value is not a draft. Returning null keeps the
    // editor usable rather than failing the whole page on one bad key.
    return null;
  }
}

/**
 * Every recoverable draft, newest first.
 *
 * The key is the authority on which note the entry belongs to: a value whose
 * `noteId` disagrees with the key it was found under is ignored rather than
 * restored onto the wrong note.
 */
export function readNoteDrafts(): NoteDraft[] {
  const store = storage();
  if (!store) return [];
  const drafts: NoteDraft[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key || !key.startsWith(NOTES_DRAFT_PREFIX)) continue;
      const draft = parseDraft(store.getItem(key));
      if (draft && notesDraftKey(draft.noteId) === key) drafts.push(draft);
    }
  } catch {
    return drafts;
  }
  return drafts.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** True when the draft was stored. A full or disabled store returns false. */
export function writeNoteDraft(
  draft: NoteDraft,
  store: Pick<Storage, "setItem"> | null = storage(),
): boolean {
  if (!store) return false;
  try {
    store.setItem(notesDraftKey(draft.noteId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearNoteDraft(noteId: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(notesDraftKey(noteId));
  } catch {
    // Removal failing cannot make the draft more recoverable; the next write
    // for this note replaces it anyway.
  }
}
