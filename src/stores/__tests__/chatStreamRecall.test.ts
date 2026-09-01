import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { recallMemories } from "../chatStream";
import { useMemoryStore } from "../memory";
import { preferenceItem, factItem, skillItem } from "../../test/fixtures/memory";
import * as memoryRecall from "../../lib/memoryRecall";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockedInvoke.mockReset();
  useMemoryStore.setState({ items: [], loaded: false, loading: false, _overrides: {} });
});

describe("recallMemories", () => {
  it("returns empty string when memory list is empty", async () => {
    mockedInvoke.mockResolvedValueOnce([] as never);
    expect(await recallMemories("hello world")).toBe("");
  });

  it("formats recalled memories with the shared formatter", async () => {
    mockedInvoke.mockResolvedValueOnce([preferenceItem] as never);
    const formatter = vi.spyOn(memoryRecall, "formatMemoryRecallBlock");

    try {
      await recallMemories("please be concise");
      expect(formatter).toHaveBeenCalledWith([preferenceItem]);
    } finally {
      formatter.mockRestore();
    }
  });

  it("matches an identity title when the user asks what they are called", async () => {
    const nickname = {
      ...preferenceItem,
      id: "nickname",
      title: "User nickname",
      content: "The user's nickname is Kevin.",
    };
    mockedInvoke.mockResolvedValue([nickname, preferenceItem, factItem] as never);

    const block = await recallMemories("what should I be called?");
    expect(block).toMatch(/^<memory-context>/);
    expect(block).toContain("Relevant facts you MUST use");
    expect(block).toContain(nickname.content);

    expect(await recallMemories("xyzzy plover")).toBe("");
    expect(await recallMemories("please be concise")).toContain(preferenceItem.content);
  });

  it("does not recall unrelated memory through stop words", async () => {
    mockedInvoke.mockResolvedValueOnce([
      { ...factItem, content: "This is my project." },
    ] as never);

    expect(await recallMemories("what is my nickname")).toBe("");
  });

  it("does not recall disabled memory", async () => {
    mockedInvoke.mockResolvedValueOnce([
      { ...preferenceItem, title: "Nickname", content: "Nickname is Kevin.", is_enabled: false },
    ] as never);

    expect(await recallMemories("what is my nickname")).toBe("");
  });

  it("keeps relevant items in the recall block", async () => {
    mockedInvoke.mockResolvedValueOnce([
      preferenceItem,
      factItem,
    ] as never);
    const block = await recallMemories("what's the tone like?");

    expect(block).toContain("Relevant facts you MUST use");
    expect(block).toContain(preferenceItem.content);
  });

  it("caps at three items and prefers higher keyword overlap", async () => {
    const A = { ...preferenceItem, id: "a", content: "tea coffee tea" };
    const B = { ...factItem, id: "b", content: "tea and cake" };
    const C = { ...skillItem, id: "c", content: "cake and fork", is_enabled: true };
    const D = { ...preferenceItem, id: "d", content: "unrelated work" };
    mockedInvoke.mockResolvedValueOnce([A, B, C, D] as never);
    const block = await recallMemories("tea cake");
    // All three (A, B, C) match, D does not. Top 3 by overlap.
    expect(block).toContain(A.content);
    expect(block).toContain(B.content);
    expect(block).toContain(C.content);
    expect(block).not.toContain(D.content);
  });

  it("returns empty string on backend error without throwing", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("boom"));
    expect(await recallMemories("anything")).toBe("");
  });

  it("ignores single-letter tokens and pure punctuation", async () => {
    mockedInvoke.mockResolvedValueOnce([preferenceItem] as never);
    // "a e i o u t" — every token is 1 char or non-alpha, all dropped.
    const block = await recallMemories("a e i o u t");
    expect(block).toBe("");
  });
});
