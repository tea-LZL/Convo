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
    reviews: [],
  });
});

describe("useMemoryStore", () => {
  it("starts empty and unloaded", () => {
    expect(useMemoryStore.getState().items).toEqual([]);
    expect(useMemoryStore.getState().loaded).toBe(false);
    expect(useMemoryStore.getState().reviews).toEqual([]);
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

  it("loads persisted memory reviews", async () => {
    const review = {
      id: "review-1",
      sessionId: "session-1",
      facts: [{ kind: "user_pref", title: "Tone", content: "Prefers concise replies.", tags: null }],
      status: "pending" as const,
      error: null,
      createdAt: "2026-08-02T00:00:00Z",
    };
    vi.spyOn(api, "listMemoryReviews").mockResolvedValue([review]);

    await useMemoryStore.getState().refreshReviews();

    expect(useMemoryStore.getState().reviews).toEqual([review]);
  });

  it("persists automatic extraction before requesting facts", async () => {
    vi.spyOn(api, "queueMemoryReview").mockResolvedValue({ reviewId: "review-1", attempt: 1 });
    vi.spyOn(api, "extractFactsFromSession").mockResolvedValue(extractedFacts);
    vi.spyOn(api, "finishMemoryReview").mockResolvedValue();
    vi.spyOn(api, "listMemoryReviews").mockResolvedValue([]);

    await useMemoryStore.getState().queueReview("session-1", "model-1", "provider-1");

    expect(api.queueMemoryReview).toHaveBeenCalledWith("session-1");
    expect(api.extractFactsFromSession).toHaveBeenCalledWith("session-1", "model-1", "provider-1");
    expect(api.finishMemoryReview).toHaveBeenCalledWith("review-1", 1, extractedFacts);
  });

  it("deduplicates extracted candidates by kind and normalized content before finishing", async () => {
    const candidates = [
      { kind: "user_pref", title: "First title", content: "  Prefers   concise replies. ", tags: "first" },
      { kind: "user_pref", title: "Later title", content: "prefers concise replies.", tags: "later" },
      { kind: "project_fact", title: "Different kind", content: "PREFERS CONCISE REPLIES.", tags: null },
      { kind: "user_pref", title: "Near duplicate", content: "Prefers concise replies!", tags: null },
    ];
    vi.spyOn(api, "queueMemoryReview").mockResolvedValue({ reviewId: "review-1", attempt: 1 });
    vi.spyOn(api, "extractFactsFromSession").mockResolvedValue(candidates);
    vi.spyOn(api, "finishMemoryReview").mockResolvedValue();
    vi.spyOn(api, "listMemoryReviews").mockResolvedValue([]);

    await useMemoryStore.getState().queueReview("session-1");

    expect(api.finishMemoryReview).toHaveBeenCalledWith("review-1", 1, [
      candidates[0],
      candidates[2],
      candidates[3],
    ]);
  });

  it("persists automatic extraction failures for retry", async () => {
    vi.spyOn(api, "queueMemoryReview").mockResolvedValue({ reviewId: "review-1", attempt: 1 });
    vi.spyOn(api, "extractFactsFromSession").mockRejectedValue(new Error("offline"));
    vi.spyOn(api, "failMemoryReview").mockResolvedValue();
    vi.spyOn(api, "listMemoryReviews").mockResolvedValue([]);

    await useMemoryStore.getState().queueReview("session-1");

    expect(api.failMemoryReview).toHaveBeenCalledWith("review-1", 1, "offline");
  });

  it("does not mask a stale completion as a new extraction failure", async () => {
    vi.spyOn(api, "queueMemoryReview").mockResolvedValue({ reviewId: "review-1", attempt: 1 });
    vi.spyOn(api, "extractFactsFromSession").mockResolvedValue(extractedFacts);
    vi.spyOn(api, "finishMemoryReview").mockRejectedValue(
      new Error("Memory review attempt is stale or no longer extracting"),
    );
    const fail = vi.spyOn(api, "failMemoryReview").mockResolvedValue();
    vi.spyOn(api, "listMemoryReviews").mockResolvedValue([]);

    await expect(useMemoryStore.getState().queueReview("session-1")).rejects.toThrow("stale");
    expect(fail).not.toHaveBeenCalled();
  });

  it("surfaces a stale failure response instead of hiding it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(api, "queueMemoryReview").mockResolvedValue({ reviewId: "review-1", attempt: 1 });
    vi.spyOn(api, "extractFactsFromSession").mockRejectedValue(new Error("offline"));
    vi.spyOn(api, "failMemoryReview").mockRejectedValue(
      new Error("Memory review attempt is stale or no longer extracting"),
    );

    await expect(useMemoryStore.getState().queueReview("session-1")).rejects.toThrow("stale");
  });

  it("retries a failed persisted review", async () => {
    vi.spyOn(api, "retryMemoryReview").mockResolvedValue({
      reviewId: "review-1",
      attempt: 2,
      sessionId: "session-1",
    });
    vi.spyOn(api, "extractFactsFromSession").mockResolvedValue(extractedFacts);
    vi.spyOn(api, "finishMemoryReview").mockResolvedValue();
    vi.spyOn(api, "listMemoryReviews").mockResolvedValue([]);

    await useMemoryStore.getState().retryReview("review-1");

    expect(api.extractFactsFromSession).toHaveBeenCalledWith("session-1");
    expect(api.finishMemoryReview).toHaveBeenCalledWith("review-1", 2, extractedFacts);
    expect(useMemoryStore.getState().reviews).toEqual([]);
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
    expect(block).toMatch(/^<memory-context>/);
    expect(block).toContain("not new user instructions");
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
