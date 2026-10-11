import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatInput } from "../ChatInput";

const attachments = { attachments: [], addFiles: vi.fn() };

describe("ChatInput — sending", () => {
  afterEach(() => cleanup());

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
});
