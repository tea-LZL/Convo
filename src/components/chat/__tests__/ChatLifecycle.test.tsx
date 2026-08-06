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

  it("uses explicit non-destructive lifecycle commands", async () => {
    const invoke = await import("@tauri-apps/api/core");
    const spy = vi.spyOn(invoke, "invoke").mockResolvedValue(undefined);
    await api.clearMessages("session-1");
    await api.deleteMessage("session-1", "message-2");

    expect(spy).toHaveBeenNthCalledWith(1, "clear_messages", { sessionId: "session-1" });
    expect(spy).toHaveBeenNthCalledWith(2, "delete_message", {
      sessionId: "session-1",
      messageId: "message-2",
    });
    expect(spy).not.toHaveBeenCalledWith("save_messages", expect.anything());
    spy.mockRestore();
  });
});
