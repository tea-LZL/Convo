import { describe, expect, it, vi } from "vitest";
import { api } from "../../../lib/api";

describe("chat lifecycle persistence", () => {
  it("exposes atomic truncation for edit and regenerate", async () => {
    const invoke = await import("@tauri-apps/api/core");
    const spy = vi.spyOn(invoke, "invoke").mockResolvedValue(undefined);
    await api.truncateMessages("session-1", "message-2");
    expect(spy).toHaveBeenCalledWith("truncate_messages", {
      sessionId: "session-1",
      fromMessageId: "message-2",
    });
    spy.mockRestore();
  });
});
