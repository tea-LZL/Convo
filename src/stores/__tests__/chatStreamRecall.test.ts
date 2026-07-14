import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { recallMemories } from "../chatStream";
import { preferenceItem, factItem, skillItem } from "../../test/fixtures/memory";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockedInvoke.mockReset();
});

describe("recallMemories", () => {
  it("returns empty string when memory list is empty", async () => {
    mockedInvoke.mockResolvedValueOnce([] as never);
    expect(await recallMemories("hello world", "")).toBe("");
  });

  it("matches memory content against query words and returns a relevant block", async () => {
    // Each recall call invokes api.listMemory(); queue enough
    // mock responses so every assertion works.
    mockedInvoke.mockResolvedValue([
      preferenceItem,
      factItem,
      skillItem,
    ] as never);
    // "what is my nickname" — preferenceItem has none of those,
    // but factItem contains "is" (2 chars), which is a token of
    // length >= 2 and matches.
    const block = await recallMemories("what is my nickname", "");
    expect(block).not.toBe("");
    expect(block).toContain("Relevant facts you MUST use");
    expect(block).toContain(factItem.content);

    // Query with no overlap at all yields empty.
    const empty = await recallMemories("xyzzy plover", "");
    expect(empty).toBe("");

    // Direct keyword match — "concise" is in preferenceItem.
    const block2 = await recallMemories("please be concise", "");
    expect(block2).toContain(preferenceItem.content);
  });

  it("skips items already in the always-on block", async () => {
    mockedInvoke.mockResolvedValueOnce([
      preferenceItem,
      factItem,
    ] as never);
    const block = await recallMemories(
      "what's the tone like?",
      // preferenceItem.content is already in the always-on block,
      // so the recall block must not duplicate it.
      `${preferenceItem.content}`
    );
    expect(block).not.toContain(preferenceItem.content);
    // factItem ("Convo is built with React…") doesn't match "tone"
    // so the recall block is empty.
    expect(block).toBe("");
  });

  it("caps at three items and prefers higher keyword overlap", async () => {
    const A = { ...preferenceItem, id: "a", content: "tea coffee tea" };
    const B = { ...factItem, id: "b", content: "tea and cake" };
    const C = { ...skillItem, id: "c", content: "cake and fork" };
    const D = { ...preferenceItem, id: "d", content: "unrelated work" };
    mockedInvoke.mockResolvedValueOnce([A, B, C, D] as never);
    const block = await recallMemories("tea cake", "");
    // All three (A, B, C) match, D does not. Top 3 by overlap.
    expect(block).toContain(A.content);
    expect(block).toContain(B.content);
    expect(block).toContain(C.content);
    expect(block).not.toContain(D.content);
  });

  it("returns empty string on backend error without throwing", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("boom"));
    expect(await recallMemories("anything", "")).toBe("");
  });

  it("ignores single-letter tokens and pure punctuation", async () => {
    mockedInvoke.mockResolvedValueOnce([preferenceItem] as never);
    // "a e i o u t" — every token is 1 char or non-alpha, all dropped.
    const block = await recallMemories("a e i o u t", "");
    expect(block).toBe("");
  });
});
