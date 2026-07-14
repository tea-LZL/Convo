import { describe, expect, it } from "vitest";
import { useMemoryStore } from "../memory";
import { memoryItems, preferenceItem, factItem, skillItem, extractedFacts } from "../../test/fixtures/memory";

describe("useMemoryStore", () => {
  it("starts empty and unloaded", () => {
    expect(useMemoryStore.getState().items).toEqual([]);
    expect(useMemoryStore.getState().loaded).toBe(false);
    expect(useMemoryStore.getState().pendingExtracts).toEqual([]);
  });

  it("buildContextBlock returns an empty string when no items", async () => {
    expect(await useMemoryStore.getState().buildContextBlock()).toBe("");
  });

  it("buildContextBlock groups items by kind", async () => {
    useMemoryStore.setState({ items: memoryItems });
    const block = await useMemoryStore.getState().buildContextBlock();
    expect(block).toContain("## User preferences");
    expect(block).toContain(preferenceItem.content);
    expect(block).toContain("## Project facts");
    expect(block).toContain(factItem.content);
    expect(block).toContain("## Active skills");
    expect(block).toContain(skillItem.content);
  });

  it("buildContextBlock renders titles when present", async () => {
    useMemoryStore.setState({ items: [preferenceItem] });
    const block = await useMemoryStore.getState().buildContextBlock();
    expect(block).toContain(`**${preferenceItem.title}**`);
  });

  it("buildContextBlock handles items with no title", async () => {
    useMemoryStore.setState({
      items: [{ ...preferenceItem, title: null }],
    });
    const block = await useMemoryStore.getState().buildContextBlock();
    expect(block).toContain(`- ${preferenceItem.content}`);
  });
});

describe("useMemoryStore.pendingExtracts", () => {
  it("pushPendingExtract assigns a localId and timestamps", () => {
    useMemoryStore.getState().clearPendingExtracts();
    useMemoryStore.getState().pushPendingExtract({
      sessionId: "session-abc",
      facts: extractedFacts,
    });
    const pe = useMemoryStore.getState().pendingExtracts;
    expect(pe).toHaveLength(1);
    expect(pe[0].sessionId).toBe("session-abc");
    expect(pe[0].facts).toEqual(extractedFacts);
    expect(pe[0].localId).toMatch(/^pe-/);
    expect(typeof pe[0].extractedAt).toBe("number");
  });

  it("pushPendingExtract silently drops empty fact lists", () => {
    useMemoryStore.getState().clearPendingExtracts();
    useMemoryStore.getState().pushPendingExtract({ sessionId: "x", facts: [] });
    expect(useMemoryStore.getState().pendingExtracts).toHaveLength(0);
  });

  it("removePendingExtract drops by localId", () => {
    useMemoryStore.getState().clearPendingExtracts();
    useMemoryStore.getState().pushPendingExtract({ sessionId: "a", facts: extractedFacts });
    useMemoryStore.getState().pushPendingExtract({ sessionId: "b", facts: extractedFacts });
    const [first] = useMemoryStore.getState().pendingExtracts;
    useMemoryStore.getState().removePendingExtract(first.localId);
    const remaining = useMemoryStore.getState().pendingExtracts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].localId).not.toBe(first.localId);
  });

  it("clearPendingExtracts targets one session or all", () => {
    useMemoryStore.getState().clearPendingExtracts();
    useMemoryStore.getState().pushPendingExtract({ sessionId: "a", facts: extractedFacts });
    useMemoryStore.getState().pushPendingExtract({ sessionId: "a", facts: extractedFacts });
    useMemoryStore.getState().pushPendingExtract({ sessionId: "b", facts: extractedFacts });
    expect(useMemoryStore.getState().pendingExtracts).toHaveLength(3);
    useMemoryStore.getState().clearPendingExtracts("a");
    expect(useMemoryStore.getState().pendingExtracts).toHaveLength(1);
    expect(useMemoryStore.getState().pendingExtracts[0].sessionId).toBe("b");
    useMemoryStore.getState().clearPendingExtracts();
    expect(useMemoryStore.getState().pendingExtracts).toHaveLength(0);
  });
});
