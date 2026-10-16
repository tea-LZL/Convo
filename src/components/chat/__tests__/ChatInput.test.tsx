import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appendToChatDraft, ChatInput, clearPendingChatDraft } from "../ChatInput";

const attachments = { attachments: [], addFiles: vi.fn() };

describe("ChatInput — sending", () => {
  afterEach(() => {
    clearPendingChatDraft();
    cleanup();
  });

  /**
   * The composer must empty the moment the message is handed off, not when
   * the provider answers. It used to clear after `onSend` resolved, so the
   * text sat in the box for the whole round trip and read as if Send had
   * done nothing.
   */
  it("empties the composer before onSend resolves", async () => {
    let resolveSend: (() => void) | undefined;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const onInputChange = vi.fn();

    render(
      <ChatInput
        disabled={false}
        streaming={false}
        attachments={attachments}
        onSend={onSend}
        onStop={vi.fn()}
        onInputChange={onInputChange}
        slashCtx={{ sessionId: "s-1" }}
      />,
    );

    const textarea = screen.getByLabelText("Message");
    fireEvent.change(textarea, { target: { value: "hello world" } });
    expect(textarea).toHaveValue("hello world");

    // Ctrl+Enter sends regardless of the Enter-to-send preference.
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    expect(onSend).toHaveBeenCalledWith("hello world");
    expect(textarea).toHaveValue("");
    expect(onInputChange).toHaveBeenCalledWith("");

    resolveSend?.();
  });

  it("preserves a draft added from Notes across ChatRoute unmount and remount until sent", async () => {
    appendToChatDraft("Note body from /notes");

    const first = render(
      <ChatInput
        disabled={false}
        streaming={false}
        attachments={attachments}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onInputChange={vi.fn()}
        slashCtx={{ sessionId: "s-1" }}
      />,
    );
    expect(screen.getByLabelText("Message")).toHaveValue("Note body from /notes");

    // Simulate ChatRoute unmounting ChatViewNew for ChatSkeleton during URL sync
    // from /chat to /chat/s-1, then remounting ChatInput.
    first.unmount();

    const onSend = vi.fn();
    render(
      <ChatInput
        disabled={false}
        streaming={false}
        attachments={attachments}
        onSend={onSend}
        onStop={vi.fn()}
        onInputChange={vi.fn()}
        slashCtx={{ sessionId: "s-1" }}
      />,
    );
    const textarea = screen.getByLabelText("Message");
    expect(textarea).toHaveValue("Note body from /notes");

    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(onSend).toHaveBeenCalledWith("Note body from /notes");
    expect(textarea).toHaveValue("");
  });
});
