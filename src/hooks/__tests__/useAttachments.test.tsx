import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { useAttachments } from "../useAttachments";
import { ChatInput } from "../../components/chat/ChatInput";

function attachmentResult(id: string) {
  return {
    id,
    name: "file.txt",
    mime: "text/plain",
    size: 0,
    kind: "document",
    blob_path: null,
    width: null,
    height: null,
    extracted_text: null,
    created_at: "2026-08-02T00:00:00Z",
  };
}

describe("useAttachments", () => {
  beforeEach(() => {
    vi.spyOn(api, "addAttachment").mockResolvedValue(attachmentResult("server-1"));
    delete (window as typeof window & { __pendingFileByLocalId?: unknown }).__pendingFileByLocalId;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads the exact file passed by the picker", async () => {
    const { result } = renderHook(() => useAttachments("session-1"));
    const file = new File(["picker"], "picker.txt", { type: "text/plain" });

    act(() => result.current.addFiles([file]));

    expect(result.current.attachments[0]?.status).toBe("uploading");
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("ready"));
    expect(api.addAttachment).toHaveBeenCalledWith({
      name: "picker.txt",
      mime: "text/plain",
      dataBase64: "cGlja2Vy",
      sessionId: "session-1",
      messageId: null,
    });
  });

  it("uploads each queued file once", async () => {
    const { result } = renderHook(() => useAttachments("session-1"));

    act(() => result.current.addFiles([
      new File(["one"], "one.txt", { type: "text/plain" }),
      new File(["two"], "two.txt", { type: "text/plain" }),
    ]));

    await waitFor(() => expect(result.current.attachments.every((attachment) => attachment.status === "ready")).toBe(true));
    expect(api.addAttachment).toHaveBeenCalledTimes(2);
  });

  it("uploads a dropped file without a global cache", async () => {
    const { result } = renderHook(() => useAttachments("session-1"));
    const file = new File(["drop"], "drop.txt", { type: "text/plain" });
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { files: [file], types: ["Files"] },
    });

    act(() => document.dispatchEvent(event));

    expect(result.current.attachments[0]?.name).toBe("drop.txt");
    expect(result.current.attachments[0]?.status).toBe("uploading");
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("ready"));
    expect(api.addAttachment).toHaveBeenCalledWith(expect.objectContaining({
      name: "drop.txt",
      dataBase64: "ZHJvcA==",
    }));
    expect((window as typeof window & { __pendingFileByLocalId?: unknown }).__pendingFileByLocalId).toBeUndefined();
  });

  it("uploads a pasted file without a global cache", async () => {
    const { result } = renderHook(() => useAttachments("session-1"));
    const file = new File(["paste"], "paste.txt", { type: "text/plain" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { items: [{ kind: "file", getAsFile: () => file }] },
    });

    act(() => document.dispatchEvent(event));

    expect(result.current.attachments[0]?.name).toBe("paste.txt");
    expect(result.current.attachments[0]?.status).toBe("uploading");
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("ready"));
    expect(api.addAttachment).toHaveBeenCalledWith(expect.objectContaining({
      name: "paste.txt",
      dataBase64: "cGFzdGU=",
    }));
    expect((window as typeof window & { __pendingFileByLocalId?: unknown }).__pendingFileByLocalId).toBeUndefined();
  });

  it("releases an image preview after upload failure", async () => {
    vi.mocked(api.addAttachment).mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useAttachments("session-1"));

    act(() => result.current.addFiles([
      new File(["image"], "image.png", { type: "image/png" }),
    ]));

    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("error"));
    expect(result.current.attachments[0]?.previewUrl).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob://mock-object-url");
  });

  it("retries a failed upload with the original File", async () => {
    vi.mocked(api.addAttachment)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(attachmentResult("server-retry"));
    const { result } = renderHook(() => useAttachments("session-1"));
    const file = new File(["retry"], "retry.txt", { type: "text/plain" });

    act(() => result.current.addFiles([file]));
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("error"));
    act(() => result.current.retry(result.current.attachments[0].localId));
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("ready"));

    expect(api.addAttachment).toHaveBeenCalledTimes(2);
    expect(api.addAttachment).toHaveBeenLastCalledWith(expect.objectContaining({
      name: "retry.txt",
      dataBase64: "cmV0cnk=",
    }));
  });

  it("does not delete blobs committed to a sent message", async () => {
    const deleteSpy = vi.spyOn(api, "deleteAttachment").mockResolvedValue(undefined);
    const { result } = renderHook(() => useAttachments("session-1"));
    act(() => result.current.addFiles([new File(["sent"], "sent.txt", { type: "text/plain" })]));
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("ready"));

    act(() => result.current.clear());

    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("deletes a late server upload after local removal", async () => {
    let resolveUpload!: (value: ReturnType<typeof attachmentResult>) => void;
    vi.mocked(api.addAttachment).mockImplementationOnce(() => new Promise((resolve) => {
      resolveUpload = resolve;
    }));
    const deleteSpy = vi.spyOn(api, "deleteAttachment").mockResolvedValue(undefined);
    const { result } = renderHook(() => useAttachments("session-1"));
    act(() => result.current.addFiles([new File(["late"], "late.txt", { type: "text/plain" })]));
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("uploading"));
    await waitFor(() => expect(api.addAttachment).toHaveBeenCalled());
    const localId = result.current.attachments[0].localId;
    act(() => result.current.remove(localId));
    resolveUpload(attachmentResult("late-server"));

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith("late-server"));
  });

  it("revokes previews when the hook unmounts", async () => {
    const { result, unmount } = renderHook(() => useAttachments("session-1"));
    const file = new File(["image"], "image.png", { type: "image/png" });

    act(() => result.current.addFiles([file]));
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob://mock-object-url");
  });

  it("removes the dragover listener on unmount", () => {
    const { unmount } = renderHook(() => useAttachments("session-1"));
    unmount();

    const event = new Event("dragover", { cancelable: true });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});

describe("ChatInput attachments", () => {
  it("blocks send while an attachment is uploading", () => {
    const attachments = {
      attachments: [{
        localId: "local-1",
        serverId: null,
        name: "upload.txt",
        mime: "text/plain",
        size: 1,
        kind: "document" as const,
        previewUrl: null,
        status: "uploading" as const,
      }],
      addFiles: vi.fn(),
      remove: vi.fn(),
      clear: vi.fn(),
      serializeForMessage: vi.fn(),
      isDragging: false,
    };

    render(
      <ChatInput
        disabled={false}
        streaming={false}
        attachments={attachments}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onInputChange={vi.fn()}
        slashCtx={{ sessionId: "session-1" }}
      />
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello" } });

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("blocks send and explains a failed attachment", () => {
    const attachments = {
      attachments: [{
        localId: "local-1",
        serverId: null,
        name: "failed.txt",
        mime: "text/plain",
        size: 1,
        kind: "document" as const,
        previewUrl: null,
        status: "error" as const,
        error: "offline",
      }],
      addFiles: vi.fn(),
      remove: vi.fn(),
      clear: vi.fn(),
      serializeForMessage: vi.fn(),
      isDragging: false,
    };

    render(
      <ChatInput
        disabled={false}
        streaming={false}
        attachments={attachments}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onInputChange={vi.fn()}
        slashCtx={{ sessionId: "session-1" }}
      />
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello" } });

    expect(screen.getByRole("alert")).toHaveTextContent("Remove failed attachments to send");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});
