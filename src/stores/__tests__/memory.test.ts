import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, AppliedRevision } from "../../lib/api";
import { useMemoryStore } from "../memory";
import { memoryItems, preferenceItem, extractedFacts } from "../../test/fixtures/memory";

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

  // The automatic path is one Rust call, and the frontend no longer decides
  // what is kept. The old code queued a review, asked the model for
  // candidates and stored them for a human — so the assertions that used to
  // live here (queueMemoryReview, then extractFactsFromSession, then
  // finishMemoryReview) described a path the app no longer takes. The
  // revision table is what applies a round now.
  it("applies the revision table in Rust on the automatic path", async () => {
    const applied: AppliedRevision[] = [
      { effect: "added", id: "mem-1" },
      { effect: "sentToReview", reviewId: "review-1" },
    ];
    vi.spyOn(api, "memoryExtractAndRevise").mockResolvedValue(applied);
    vi.spyOn(api, "queueMemoryReview").mockResolvedValue("review-1");
    vi.spyOn(api, "extractFactsFromSession").mockResolvedValue(extractedFacts);
    vi.spyOn(api, "listMemoryReviews").mockResolvedValue([]);

    const result = await useMemoryStore
      .getState()
      .extractAndRevise("session-1", "model-1", "provider-1");

    expect(api.memoryExtractAndRevise).toHaveBeenCalledWith("session-1", "model-1", "provider-1");
    // The model route is the chat's own, so switching from the old call must
    // not quietly change which provider extracts.
    expect(api.queueMemoryReview).not.toHaveBeenCalled();
    expect(api.extractFactsFromSession).not.toHaveBeenCalled();
    // The caller needs the outcome to report it, so the store hands it back
    // rather than swallowing it.
    expect(result).toEqual(applied);
  });

  // A write the user cannot see is a write they will distrust. The list has
  // to be re-read or the Memory tab shows a stale library until the next
  // manual refresh, and the inbox has to be re-read or the `sentToReview`
  // outcomes — rows the revision table just created — are missing.
  it("refreshes the memory list and the inbox after an automatic round", async () => {
    const nickname = { ...preferenceItem, content: "The user's nickname is Kevin." };
    vi.spyOn(api, "memoryExtractAndRevise").mockResolvedValue([
      { effect: "added", id: nickname.id },
      { effect: "sentToReview", reviewId: "review-1" },
    ]);
    vi.mocked(api.getEnabledMemory).mockResolvedValue([nickname]);
    const pending = {
      id: "review-1",
      sessionId: "session-1",
      facts: [{ kind: "user_pref", title: "Tone", content: "Prefers concise replies.", tags: null }],
      status: "pending" as const,
      error: null,
      createdAt: "2026-08-02T00:00:00Z",
    };
    vi.spyOn(api, "listMemoryReviews").mockResolvedValue([pending]);

    await useMemoryStore.getState().extractAndRevise("session-1");

    expect(useMemoryStore.getState().items).toEqual([nickname]);
    await vi.waitFor(() => {
      expect(useMemoryStore.getState().reviews).toEqual([pending]);
    });
  });

  // A round that finds nothing durable returns an empty list, and that is
  // the common case. It must not surface as a "0 remembered" message, or
  // the signal stops being worth reading.
  it("does not fail the round when the inbox refresh fails", async () => {
    vi.spyOn(api, "memoryExtractAndRevise").mockResolvedValue([{ effect: "added", id: "mem-1" }]);
    vi.mocked(api.getEnabledMemory).mockResolvedValue([]);
    vi.spyOn(api, "listMemoryReviews").mockRejectedValue(new Error("inbox unavailable"));

    const result = await useMemoryStore.getState().extractAndRevise("session-1");

    expect(result).toEqual([{ effect: "added", id: "mem-1" }]);
  });

  it("retries a failed persisted review", async () => {
    vi.spyOn(api, "retryMemoryReview").mockResolvedValue("session-1");
    vi.spyOn(api, "extractFactsFromSession").mockResolvedValue(extractedFacts);
    vi.spyOn(api, "finishMemoryReview").mockResolvedValue();
    vi.spyOn(api, "listMemoryReviews").mockResolvedValue([]);

    await useMemoryStore.getState().retryReview("review-1");

    expect(api.extractFactsFromSession).toHaveBeenCalledWith("session-1");
    expect(api.finishMemoryReview).toHaveBeenCalledWith("review-1", extractedFacts);
    expect(useMemoryStore.getState().reviews).toEqual([]);
  });

  // The persisted-failure row, still reachable: a retry of a row left in
  // `failed` by an earlier attempt has to record the new error, or the inbox
  // keeps showing a failure the user already retried. The automatic path
  // cannot fail this way any more — Rust owns the round and swallows its own
  // extraction error — so the assertion moved here rather than being dropped.
  it("persists extraction failures for retry", async () => {
    vi.spyOn(api, "retryMemoryReview").mockResolvedValue("session-1");
    vi.spyOn(api, "extractFactsFromSession").mockRejectedValue(new Error("offline"));
    vi.spyOn(api, "failMemoryReview").mockResolvedValue();
    vi.spyOn(api, "listMemoryReviews").mockResolvedValue([]);

    await useMemoryStore.getState().retryReview("review-1");

    expect(api.failMemoryReview).toHaveBeenCalledWith("review-1", "offline");
  });

  it("upsert makes the new memory immediately available", async () => {
    const nickname = { ...preferenceItem, content: "The user's nickname is Kevin." };
    vi.spyOn(api, "upsertMemory").mockResolvedValue(nickname.id);
    vi.mocked(api.getEnabledMemory).mockResolvedValue([nickname]);

    await useMemoryStore.getState().upsert({
      kind: nickname.kind,
      title: nickname.title,
      content: nickname.content,
      is_enabled: true,
    });

    expect(useMemoryStore.getState().items).toEqual([nickname]);
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

    await useMemoryStore
      .getState()
      .setSessionOverrides("session-1", [preferenceItem.id], true);

    expect(useMemoryStore.getState()._overrides["session-1"]).toEqual([preferenceItem.id]);
  });

  // The cache has to keep the two empty answers apart. A chat scoped to
  // nothing and a chat that was never scoped both cache an empty list, and
  // the first one is the instruction "no memory here" while the second is
  // "everything is eligible" — so the cleared chat is cached as null.
  it("setSessionOverrides caches a cleared chat as unscoped, not as an empty list", async () => {
    vi.spyOn(api, "setSessionMemoryOverrides").mockResolvedValue();

    await useMemoryStore.getState().setSessionOverrides("session-1", [], true);
    expect(useMemoryStore.getState()._overrides["session-1"]).toEqual([]);

    await useMemoryStore.getState().setSessionOverrides("session-1", [], false);
    expect(useMemoryStore.getState()._overrides["session-1"]).toBeNull();
  });
});
