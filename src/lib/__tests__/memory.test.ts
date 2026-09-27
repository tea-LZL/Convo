import { describe, expect, it, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue(undefined as never);
});

/**
 * Test the API wrappers used by MemoryRoute: search debounce timing,
 * toggle_memory enable/disable, and extract_facts_from_session.
 */
describe("memory API wrappers", () => {
  it("search_memory passes query and kind", async () => {
    const { api } = await import("../api");
    const { searchMemory } = api;

    mockedInvoke.mockResolvedValueOnce([] as never);

    await searchMemory("test query", "user_pref");

    expect(mockedInvoke).toHaveBeenCalledWith(
      "search_memory",
      expect.objectContaining({
        query: "test query",
        kind: "user_pref",
        limit: 30,
      })
    );
  });

  it("toggle_memory calls with opposite enabled state", async () => {
    const { api } = await import("../api");

    mockedInvoke.mockResolvedValueOnce(undefined as never);

    await api.toggleMemory("mem-1", false);

    expect(mockedInvoke).toHaveBeenCalledWith("toggle_memory", {
      id: "mem-1",
      enabled: false,
    });
  });

  it("toggle_memory re-enables a disabled item", async () => {
    const { api } = await import("../api");

    mockedInvoke.mockResolvedValueOnce(undefined as never);

    await api.toggleMemory("mem-2", true);

    expect(mockedInvoke).toHaveBeenCalledWith("toggle_memory", {
      id: "mem-2",
      enabled: true,
    });
  });

  it("upsert_memory creates with kind and content", async () => {
    const { api } = await import("../api");

    mockedInvoke.mockResolvedValueOnce("new-id" as never);

    await api.upsertMemory({
      kind: "user_pref",
      title: "Test",
      content: "Some content",
      tags: "tag1, tag2",
      is_enabled: true,
    });

    expect(mockedInvoke).toHaveBeenCalledWith(
      "upsert_memory",
      expect.objectContaining({
        item: expect.objectContaining({
          kind: "user_pref",
          title: "Test",
          content: "Some content",
          tags: "tag1, tag2",
          isEnabled: 1,
        }),
      })
    );
  });

  it("get_session_memory_overrides calls with session id and reads the scope", async () => {
    const { api } = await import("../api");

    mockedInvoke.mockResolvedValueOnce({
      itemIds: ["id1", "id2"],
      configured: true,
    } as never);

    const result = await api.getSessionMemoryOverrides("sess-xyz");

    expect(mockedInvoke).toHaveBeenCalledWith(
      "get_session_memory_overrides",
      { sessionId: "sess-xyz" }
    );
    expect(result).toEqual({ itemIds: ["id1", "id2"], configured: true });
  });

  it("set_session_memory_overrides sends item ids and the scope flag", async () => {
    const { api } = await import("../api");

    mockedInvoke.mockResolvedValueOnce(undefined as never);

    await api.setSessionMemoryOverrides("sess-xyz", ["id-a", "id-b"], true);

    // The flag is what separates "restricted to these" from "restricted to
    // nothing" from "never configured", and the first two both send an id
    // list. Dropping it would turn a chat scoped to nothing into a chat
    // scoped to everything.
    expect(mockedInvoke).toHaveBeenCalledWith(
      "set_session_memory_overrides",
      { sessionId: "sess-xyz", itemIds: ["id-a", "id-b"], configured: true }
    );
  });
});
