import { describe, expect, it } from "vitest";
import { useMemoryStore } from "../memory";
import { memoryItems, preferenceItem, factItem, skillItem } from "../../test/fixtures/memory";

describe("useMemoryStore", () => {
  it("starts empty and unloaded", () => {
    expect(useMemoryStore.getState().items).toEqual([]);
    expect(useMemoryStore.getState().loaded).toBe(false);
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
