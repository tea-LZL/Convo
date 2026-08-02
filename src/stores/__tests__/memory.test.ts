import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { useMemoryStore } from "../memory";
import { memoryItems, preferenceItem, factItem, skillItem, extractedFacts } from "../../test/fixtures/memory";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "getEnabledMemory").mockResolvedValue([]);
  useMemoryStore.setState({
    items: [],
    loaded: false,
    loading: false,
    _overrides: {},
    pendingExtracts: [],
  });
});

describe("useMemoryStore", () => {
  it("starts empty and unloaded", () => {
    expect(useMemoryStore.getState().items).toEqual([]);
    expect(useMemoryStore.getState().loaded).toBe(false);
    expect(useMemoryStore.getState().pendingExtracts).toEqual([]);
  });

  it("buildContextBlock returns an empty string when no items", async () => {
    expect(await useMemoryStore.getState().buildContextBlock()).toBe("");
  });

  it("buildContextBlock waits for an in-flight refresh", async () => {
    let resolve!: (items: typeof memoryItems) => void;
    vi.mocked(api.getEnabledMemory).mockReturnValue(
      new Promise((done) => { resolve = done; }),
    );

    const refresh = useMemoryStore.getState().refresh();
    const context = useMemoryStore.getState().buildContextBlock();
    resolve(memoryItems);

    await refresh;
    expect(await context).toContain(preferenceItem.content);
  });

  it("upsert makes enabled memory immediately available to prompts", async () => {
    const nickname = { ...preferenceItem, content: "The user's nickname is Kevin." };
    vi.spyOn(api, "upsertMemory").mockResolvedValue(nickname.id);
    vi.mocked(api.getEnabledMemory).mockResolvedValue([nickname]);

    await useMemoryStore.getState().upsert({
      kind: nickname.kind,
      title: nickname.title,
      content: nickname.content,
      is_enabled: true,
    });

    expect(await useMemoryStore.getState().buildContextBlock()).toContain("Kevin");
  });

  it("upsert reloads after an older refresh finishes", async () => {
    const nickname = { ...preferenceItem, content: "The user's nickname is Kevin." };
    let resolveOld!: (items: typeof memoryItems) => void;
    vi.mocked(api.getEnabledMemory)
      .mockReturnValueOnce(new Promise((done) => { resolveOld = done; }))
      .mockResolvedValueOnce([nickname]);
    vi.spyOn(api, "upsertMemory").mockResolvedValue(nickname.id);

    const oldRefresh = useMemoryStore.getState().refresh();
    const upsert = useMemoryStore.getState().upsert(nickname);
    resolveOld([]);
    await Promise.all([oldRefresh, upsert]);

    expect(useMemoryStore.getState().items).toEqual([nickname]);
  });

  it("toggle refreshes enabled memory", async () => {
    useMemoryStore.setState({ items: [preferenceItem], loaded: true });
    vi.spyOn(api, "toggleMemory").mockResolvedValue();
    vi.mocked(api.getEnabledMemory).mockResolvedValue([]);

    await useMemoryStore.getState().toggle(preferenceItem.id, false);

    expect(useMemoryStore.getState().items).toEqual([]);
  });

  it("remove refreshes enabled memory", async () => {
    useMemoryStore.setState({ items: [preferenceItem], loaded: true });
    vi.spyOn(api, "deleteMemory").mockResolvedValue();
    vi.mocked(api.getEnabledMemory).mockResolvedValue([]);

    await useMemoryStore.getState().remove(preferenceItem.id);

    expect(useMemoryStore.getState().items).toEqual([]);
  });

  it("setSessionOverrides updates the prompt cache", async () => {
    vi.spyOn(api, "setSessionMemoryOverrides").mockResolvedValue();

    await useMemoryStore.getState().setSessionOverrides("session-1", [preferenceItem.id]);

    expect(useMemoryStore.getState()._overrides["session-1"]).toEqual([preferenceItem.id]);
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
