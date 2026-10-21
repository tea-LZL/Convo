import { beforeEach, describe, expect, it } from "vitest";
import {
  clearNoteDraft,
  notesDraftKey,
  readNoteDrafts,
  writeNoteDraft,
} from "../notesDraft";

const draft = (noteId: string, over: Record<string, unknown> = {}) => ({
  noteId,
  title: `Title ${noteId}`,
  body: `Body ${noteId}`,
  tags: "ops",
  savedAt: "2026-10-21T10:00:00.000Z",
  ...over,
});

describe("notesDraft", () => {
  beforeEach(() => localStorage.clear());

  it("keeps one draft per note, newest first", () => {
    expect(writeNoteDraft(draft("a", { savedAt: "2026-10-21T10:00:00.000Z" }))).toBe(true);
    expect(writeNoteDraft(draft("b", { savedAt: "2026-10-21T11:00:00.000Z" }))).toBe(true);

    const drafts = readNoteDrafts();
    expect(drafts.map((d) => d.noteId)).toEqual(["b", "a"]);
    // Independent keys: clearing one leaves the other, so saving note B
    // cannot erase a pending draft for note A.
    clearNoteDraft("b");
    expect(readNoteDrafts().map((d) => d.noteId)).toEqual(["a"]);
  });

  it("ignores malformed values and a key whose id disagrees with it", () => {
    localStorage.setItem(notesDraftKey("broken"), "{not json");
    localStorage.setItem(
      notesDraftKey("wrong"),
      JSON.stringify(draft("someone-else")),
    );
    localStorage.setItem(
      notesDraftKey("no-body"),
      JSON.stringify({ noteId: "no-body", title: "t", tags: "", savedAt: "now" }),
    );
    localStorage.setItem("convo:something-else", JSON.stringify(draft("other")));

    expect(readNoteDrafts()).toEqual([]);
  });

  it("does not throw when the store refuses a write", () => {
    const failing = {
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(writeNoteDraft(draft("a"), failing)).toBe(false);
    expect(readNoteDrafts()).toEqual([]);
  });
});
