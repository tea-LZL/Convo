import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, type ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAttachments } from "../../../hooks/useAttachments";
import { useChat, type UseChat } from "../../../hooks/useChat";
import { api, ChatMessage } from "../../../lib/api";
import { toast } from "../../../stores/toasts";
import { ChatContextMenu } from "../ChatContextMenu";
import { ChatViewNew } from "../ChatViewNew";
import { MessageRow } from "../MessageRow";
import type { ChatContextMenuState } from "../types";

const resendCapture = vi.hoisted(() => ({
  current: null as ((msgIndex: number, content: string) => Promise<void>) | null,
}));

vi.mock("../../../hooks/useAttachments", () => ({
  useAttachments: vi.fn(),
}));

vi.mock("../../../hooks/useChat", () => ({
  useChat: vi.fn(),
}));

vi.mock("../../../stores/slashCommands", () => {
  const state = {
    commands: [],
    refresh: () => Promise.resolve(),
  };
  return {
    useSlashCommandsStore: (selector: (value: typeof state) => unknown) => selector(state),
  };
});

vi.mock("../ChatHeader", () => ({
  ChatHeader: ({
    contextLength,
    setModelId,
  }: {
    contextLength: number;
    setModelId: (id: string) => void;
  }) => (
    <>
      <span data-testid="context-length">{contextLength}</span>
      <button type="button" onClick={() => setModelId("next-model")}>
        Switch model
      </button>
    </>
  ),
}));

vi.mock("../MessageList", () => ({
  MessageList: ({
    editingMessageId,
    setEditingMessageId,
    onResend,
  }: {
    editingMessageId: string | null;
    setEditingMessageId: (id: string | null) => void;
    onResend: (index: number, content: string) => Promise<void>;
  }) => {
    resendCapture.current ??= onResend;
    return (
      <>
        <span data-testid="editing-message-id">{editingMessageId ?? ""}</span>
        {editingMessageId && <textarea aria-label="Edit draft" value="edited prompt" readOnly />}
        <button type="button" onClick={() => { void onResend(0, "edited prompt"); }}>
          Edit resend
        </button>
        <button type="button" onClick={() => setEditingMessageId("user-1")}>
          Start editing
        </button>
        <button type="button" onClick={() => { void onResend(0, "edited prompt"); }}>
          Save edited resend
        </button>
      </>
    );
  },
}));

vi.mock("../StreamingSection", () => ({
  StreamingSection: () => null,
}));

vi.mock("../ChatInput", async () => {
  const actual = await vi.importActual<typeof import("../ChatInput")>("../ChatInput");
  const WrappedChatInput = (props: ComponentProps<typeof actual.ChatInput>) => (
    <>
      <actual.ChatInput {...props} />
      <button type="button" onClick={() => { void props.slashCtx.resendLast?.(); }}>
        Slash regenerate
      </button>
      <button type="button" onClick={() => { void props.onSend("concurrent composer message"); }}>
        Composer send
      </button>
    </>
  );
  return { ChatInput: WrappedChatInput };
});

const attachmentsJson = JSON.stringify([
  {
    schemaVersion: 1,
    sourceType: "file",
    id: "image-1",
    name: "diagram.png",
    mime: "image/png",
    size: 4,
    kind: "image",
    dataBase64: "aW1hZ2U=",
  },
  {
    schemaVersion: 1,
    sourceType: "note",
    id: "note-1",
    name: "Research note",
    agentText: "The original source snapshot must survive resend.",
  },
]);

const userMessage: ChatMessage = {
  id: "user-1",
  session_id: "session-1",
  role: "user",
  content: "original prompt",
  thinking: null,
  attachments_json: attachmentsJson,
  prompt_tokens: null,
  output_tokens: null,
  created_at: "2026-09-01T00:00:00.000Z",
};

const assistantMessage: ChatMessage = {
  id: "assistant-1",
  session_id: "session-1",
  role: "assistant",
  content: "original answer",
  thinking: null,
  attachments_json: null,
  prompt_tokens: null,
  output_tokens: null,
  created_at: "2026-09-01T00:00:01.000Z",
};

const chatSend = vi.fn().mockResolvedValue(undefined);
const chatReload = vi.fn().mockResolvedValue(undefined);
const chatRetryLast = vi.fn().mockResolvedValue(undefined);

function setupChatView({ streaming = false }: { streaming?: boolean } = {}) {
  resendCapture.current = null;
  chatSend.mockResolvedValue(undefined);
  chatReload.mockResolvedValue(undefined);
  chatRetryLast.mockResolvedValue(undefined);
  const chatState: UseChat = {
    messages: [userMessage],
    status: "idle",
    streaming,
    totalTokens: 0,
    error: null,
    loadingMessages: false,
    send: chatSend,
    stop: vi.fn().mockResolvedValue(undefined),
    reload: chatReload,
    clear: vi.fn().mockResolvedValue(undefined),
    retryLast: chatRetryLast,
  };
  vi.mocked(useChat).mockReturnValue(chatState);
  vi.mocked(useAttachments).mockReturnValue({
    attachments: [],
    addFiles: vi.fn(),
    remove: vi.fn(),
    retry: vi.fn(),
    commit: vi.fn(),
    releaseCommitted: vi.fn(),
    clear: vi.fn(),
    discard: vi.fn(),
    serializeForMessage: vi.fn(() => "[]"),
    isDragging: false,
  });
  vi.spyOn(api, "listModelsForProvider").mockResolvedValue([]);
  vi.spyOn(api, "refreshModels").mockResolvedValue([]);
  vi.spyOn(api, "updateSessionModel").mockResolvedValue(undefined);
  vi.spyOn(api, "truncateMessages").mockResolvedValue(undefined);
  return chatState;
}

function chatViewElement({
  providerKind = "openai_compat",
  modelId,
}: {
  providerKind?: "ollama" | "openai_compat";
  modelId?: string;
} = {}) {
  return (
    <MemoryRouter>
      <ChatViewNew
        sessionId="session-1"
        providers={[{
          id: "provider-1",
          kind: providerKind,
          name: "Test provider",
          base_url: null,
          is_default: true,
          created_at: "2026-09-01T00:00:00.000Z",
        }]}
        session={modelId ? {
          id: "session-1",
          title: "Test session",
          model_id: modelId,
          provider_id: "provider-1",
          group_id: null,
          is_pinned: false,
          is_archived: false,
          created_at: "2026-09-01T00:00:00.000Z",
          updated_at: "2026-09-01T00:00:00.000Z",
        } : undefined}
      />
    </MemoryRouter>
  );
}

function renderChatView(options?: Parameters<typeof chatViewElement>[0]) {
  return render(chatViewElement(options));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("chat resend attachment preservation", () => {
  beforeEach(() => {
    setupChatView();
  });

  it("passes the original attachment JSON through edit and resend", async () => {
    renderChatView();

    fireEvent.click(screen.getByRole("button", { name: "Edit resend" }));

    await waitFor(() => expect(chatSend).toHaveBeenCalledWith("edited prompt", expect.objectContaining({
      attachmentsJson,
      resendSnapshot: [userMessage],
    })));
  });

  it("keeps edit mode until the resend send resolves", async () => {
    const send = deferred<void>();
    chatSend.mockReturnValueOnce(send.promise);
    renderChatView();

    fireEvent.click(screen.getByRole("button", { name: "Start editing" }));
    fireEvent.click(screen.getByRole("button", { name: "Save edited resend" }));

    await waitFor(() => expect(chatSend).toHaveBeenCalled());
    expect(screen.getByTestId("editing-message-id")).toHaveTextContent("user-1");

    await act(async () => {
      send.resolve(undefined);
      await send.promise;
    });
    await waitFor(() => expect(screen.getByTestId("editing-message-id")).toHaveTextContent(""));
  });

  it("restores the original history when edit reload fails after truncation", async () => {
    const toastError = vi.spyOn(toast, "error");
    const saveMessages = vi.spyOn(api, "saveMessages").mockResolvedValue(undefined);
    chatReload.mockRejectedValueOnce(new Error("reload failed")).mockResolvedValueOnce(undefined);
    renderChatView();

    fireEvent.click(screen.getByRole("button", { name: "Start editing" }));
    fireEvent.click(screen.getByRole("button", { name: "Save edited resend" }));

    await waitFor(() => expect(saveMessages).toHaveBeenCalledWith("session-1", [userMessage]));
    expect(chatReload).toHaveBeenCalledTimes(2);
    expect(chatSend).not.toHaveBeenCalled();
    expect(screen.getByTestId("editing-message-id")).toHaveTextContent("user-1");
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Unable to resend"));
  });

  it("does not restore locally when edit send fails after send starts", async () => {
    const saveMessages = vi.spyOn(api, "saveMessages").mockResolvedValue(undefined);
    chatReload.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    chatSend.mockRejectedValueOnce(new Error("upsert failed"));
    renderChatView();

    fireEvent.click(screen.getByRole("button", { name: "Start editing" }));
    fireEvent.click(screen.getByRole("button", { name: "Save edited resend" }));

    await waitFor(() => expect(chatSend).toHaveBeenCalled());
    expect(saveMessages).not.toHaveBeenCalled();
    expect(chatReload).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("editing-message-id")).toHaveTextContent("user-1");
  });

  it("keeps the edit draft and does not send when truncation fails", async () => {
    const toastError = vi.spyOn(toast, "error");
    vi.mocked(api.truncateMessages).mockRejectedValueOnce(new Error("history is unavailable"));
    renderChatView();

    fireEvent.click(screen.getByRole("button", { name: "Start editing" }));
    expect(screen.getByTestId("editing-message-id")).toHaveTextContent("user-1");
    expect(screen.getByRole("textbox", { name: "Edit draft" })).toHaveValue("edited prompt");

    fireEvent.click(screen.getByRole("button", { name: "Save edited resend" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Unable to resend")));
    expect(chatReload).not.toHaveBeenCalled();
    expect(chatSend).not.toHaveBeenCalled();
    expect(screen.getByTestId("editing-message-id")).toHaveTextContent("user-1");
    expect(screen.getByRole("textbox", { name: "Edit draft" })).toHaveValue("edited prompt");
  });

  it("does not truncate or send while a response is streaming", async () => {
    const toastWarn = vi.spyOn(toast, "warn");
    setupChatView({ streaming: true });
    renderChatView();

    fireEvent.click(screen.getByRole("button", { name: "Edit resend" }));

    await waitFor(() => expect(toastWarn).toHaveBeenCalledWith(expect.stringContaining("Stop the current response")));
    expect(api.truncateMessages).not.toHaveBeenCalled();
    expect(chatReload).not.toHaveBeenCalled();
    expect(chatSend).not.toHaveBeenCalled();
  });

  it("blocks a composer send while edit resend is in the pre-send gap", async () => {
    const toastWarn = vi.spyOn(toast, "warn");
    const truncate = deferred<void>();
    vi.mocked(api.truncateMessages).mockImplementationOnce(() => truncate.promise);
    renderChatView();

    fireEvent.click(screen.getByRole("button", { name: "Edit resend" }));
    await waitFor(() => expect(api.truncateMessages).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Composer send" }));

    await waitFor(() => expect(toastWarn).toHaveBeenCalledWith(
      expect.stringContaining("resend"),
    ));
    expect(chatSend).not.toHaveBeenCalled();

    await act(async () => {
      truncate.resolve(undefined);
      await truncate.promise;
    });
    await waitFor(() => expect(chatSend).toHaveBeenCalledWith("edited prompt", expect.objectContaining({
      attachmentsJson,
      resendSnapshot: [userMessage],
    })));
  });

  it("keeps composer text and attachments when ChatView blocks a send during resend recovery", async () => {
    const toastWarn = vi.spyOn(toast, "warn");
    const truncate = deferred<void>();
    const commit = vi.fn();
    const serializeForMessage = vi.fn(() => attachmentsJson);
    vi.mocked(useAttachments).mockReturnValue({
      attachments: [{
        localId: "composer-attachment-local",
        serverId: "composer-attachment-server",
        name: "diagram.png",
        mime: "image/png",
        size: 4,
        kind: "image",
        previewUrl: null,
        status: "ready",
      }],
      addFiles: vi.fn(),
      remove: vi.fn(),
      retry: vi.fn(),
      commit,
      releaseCommitted: vi.fn(),
      clear: vi.fn(),
      discard: vi.fn(),
      serializeForMessage,
      isDragging: false,
    });
    vi.mocked(api.truncateMessages).mockImplementationOnce(() => truncate.promise);
    renderChatView({ modelId: "provider-1::model-1" });

    fireEvent.click(screen.getByRole("button", { name: "Edit resend" }));
    await waitFor(() => expect(api.truncateMessages).toHaveBeenCalledTimes(1));

    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "concurrent composer message" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Send$/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));

    await waitFor(() => expect(toastWarn).toHaveBeenCalledWith(expect.stringContaining("resend")));
    expect(composer).toHaveValue("concurrent composer message");
    expect(commit).not.toHaveBeenCalled();
    expect(serializeForMessage).not.toHaveBeenCalled();
    expect(chatSend).not.toHaveBeenCalled();

    await act(async () => {
      truncate.resolve(undefined);
      await truncate.promise;
    });
    await waitFor(() => expect(chatSend).toHaveBeenCalledWith("edited prompt", expect.objectContaining({
      attachmentsJson,
      resendSnapshot: [userMessage],
    })));
  });

  it("keeps the normal composer draft and attachments when the store reports send failure", async () => {
    const commit = vi.fn();
    const releaseCommitted = vi.fn();
    const serializeForMessage = vi.fn(() => attachmentsJson);
    vi.mocked(useAttachments).mockReturnValue({
      attachments: [{
        localId: "normal-failure-attachment-local",
        serverId: "normal-failure-attachment-server",
        name: "diagram.png",
        mime: "image/png",
        size: 4,
        kind: "image",
        previewUrl: null,
        status: "ready",
      }],
      addFiles: vi.fn(),
      remove: vi.fn(),
      retry: vi.fn(),
      commit,
      releaseCommitted,
      clear: vi.fn(),
      discard: vi.fn(),
      serializeForMessage,
      isDragging: false,
    });
    chatSend.mockResolvedValueOnce(false);
    renderChatView({ modelId: "provider-1::model-1" });

    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));

    await waitFor(() => expect(chatSend).toHaveBeenCalledWith("keep this draft", expect.objectContaining({
      attachmentsJson,
    })));
    expect(composer).toHaveValue("keep this draft");
    expect(commit).not.toHaveBeenCalled();
    expect(releaseCommitted).not.toHaveBeenCalled();
  });

  it("uses retryLast for slash regenerate without sending a duplicate user turn", async () => {
    renderChatView();

    fireEvent.click(screen.getByRole("button", { name: "Slash regenerate" }));

    await waitFor(() => expect(chatRetryLast).toHaveBeenCalledTimes(1));
    expect(chatSend).not.toHaveBeenCalled();
  });

  it("rejects a resend callback captured before streaming starts", async () => {
    const toastWarn = vi.spyOn(toast, "warn");
    const initialChat = setupChatView();
    const view = renderChatView();
    const staleResend = resendCapture.current;
    expect(staleResend).toBeTypeOf("function");

    vi.mocked(useChat).mockReturnValue({ ...initialChat, streaming: true });
    await act(async () => {
      view.rerender(chatViewElement());
    });

    await act(async () => {
      await staleResend!(0, "edited prompt");
    });
    expect(toastWarn).toHaveBeenCalledWith(expect.stringContaining("Stop the current response"));
    expect(api.truncateMessages).not.toHaveBeenCalled();
    expect(chatReload).not.toHaveBeenCalled();
    expect(chatSend).not.toHaveBeenCalled();
  });

  it("uses current messages and actions from a retained resend callback", async () => {
    const initialChat = setupChatView();
    const nextUserMessage = { ...userMessage, id: "user-2", content: "newer prompt" };
    const nextSend = vi.fn().mockResolvedValue(undefined);
    const nextReload = vi.fn().mockResolvedValue(undefined);
    const view = renderChatView();
    const staleResend = resendCapture.current;
    expect(staleResend).toBeTypeOf("function");

    vi.mocked(useChat).mockReturnValue({
      ...initialChat,
      messages: [nextUserMessage],
      send: nextSend,
      reload: nextReload,
    });
    await act(async () => {
      view.rerender(chatViewElement());
    });

    await act(async () => {
      await staleResend!(0, "edited newer prompt");
    });

    expect(api.truncateMessages).toHaveBeenCalledWith("session-1", "user-2");
    expect(nextReload).toHaveBeenCalledTimes(1);
    expect(nextSend).toHaveBeenCalledWith("edited newer prompt", expect.objectContaining({
      attachmentsJson: nextUserMessage.attachments_json,
      resendSnapshot: [nextUserMessage],
    }));
    expect(chatSend).not.toHaveBeenCalled();
  });

  it("passes the selected user attachment JSON through context-menu regenerate", async () => {
    const setContextMenu = vi.fn();
    const contextMenu: ChatContextMenuState = {
      x: 20,
      y: 20,
      content: assistantMessage.content,
      role: "assistant",
      msgIndex: 1,
      isThinking: false,
    };
    const send = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(api, "truncateMessages").mockResolvedValue(undefined);

    render(
      <ChatContextMenu
        contextMenu={contextMenu}
        contextMenuRef={createRef<HTMLDivElement>()}
        setContextMenu={setContextMenu}
        chatMessages={[userMessage, assistantMessage]}
        sessionId="session-1"
        collapsedThinking={new Set()}
        setCollapsedThinking={vi.fn()}
        setEditingMessageId={vi.fn()}
        chatReload={reload}
        chatSend={send}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Regenerate" }));

    await waitFor(() => expect(send).toHaveBeenCalledWith("original prompt", expect.objectContaining({
      attachmentsJson,
      resendSnapshot: [userMessage, assistantMessage],
    })));
  });

  it("surfaces context-menu regenerate errors instead of sending after a failed truncate", async () => {
    const toastError = vi.spyOn(toast, "error");
    const setContextMenu = vi.fn();
    const send = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn().mockResolvedValue(undefined);
    vi.mocked(api.truncateMessages).mockRejectedValueOnce(new Error("history is unavailable"));
    const contextMenu: ChatContextMenuState = {
      x: 20,
      y: 20,
      content: assistantMessage.content,
      role: "assistant",
      msgIndex: 1,
      isThinking: false,
    };

    render(
      <ChatContextMenu
        contextMenu={contextMenu}
        contextMenuRef={createRef<HTMLDivElement>()}
        setContextMenu={setContextMenu}
        chatMessages={[userMessage, assistantMessage]}
        sessionId="session-1"
        collapsedThinking={new Set()}
        setCollapsedThinking={vi.fn()}
        setEditingMessageId={vi.fn()}
        chatReload={reload}
        chatSend={send}
        canRegenerate
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Regenerate" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Regenerate failed")));
    expect(reload).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("restores the original history when context-menu reload fails after truncation", async () => {
    const toastError = vi.spyOn(toast, "error");
    const saveMessages = vi.spyOn(api, "saveMessages").mockResolvedValue(undefined);
    const setContextMenu = vi.fn();
    const send = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn().mockRejectedValueOnce(new Error("reload failed")).mockResolvedValueOnce(undefined);
    const contextMenu: ChatContextMenuState = {
      x: 20,
      y: 20,
      content: assistantMessage.content,
      role: "assistant",
      msgIndex: 1,
      isThinking: false,
    };

    render(
      <ChatContextMenu
        contextMenu={contextMenu}
        contextMenuRef={createRef<HTMLDivElement>()}
        setContextMenu={setContextMenu}
        chatMessages={[userMessage, assistantMessage]}
        sessionId="session-1"
        collapsedThinking={new Set()}
        setCollapsedThinking={vi.fn()}
        setEditingMessageId={vi.fn()}
        chatReload={reload}
        chatSend={send}
        canRegenerate
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Regenerate" }));

    await waitFor(() => expect(saveMessages).toHaveBeenCalledWith("session-1", [userMessage, assistantMessage]));
    expect(reload).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Regenerate failed"));
  });

  it("does not restore locally when context-menu send fails after send starts", async () => {
    const saveMessages = vi.spyOn(api, "saveMessages").mockResolvedValue(undefined);
    const setContextMenu = vi.fn();
    const send = vi.fn().mockRejectedValue(new Error("provider failed"));
    const reload = vi.fn().mockResolvedValue(undefined);
    const contextMenu: ChatContextMenuState = {
      x: 20,
      y: 20,
      content: assistantMessage.content,
      role: "assistant",
      msgIndex: 1,
      isThinking: false,
    };

    render(
      <ChatContextMenu
        contextMenu={contextMenu}
        contextMenuRef={createRef<HTMLDivElement>()}
        setContextMenu={setContextMenu}
        chatMessages={[userMessage, assistantMessage]}
        sessionId="session-1"
        collapsedThinking={new Set()}
        setCollapsedThinking={vi.fn()}
        setEditingMessageId={vi.fn()}
        chatReload={reload}
        chatSend={send}
        canRegenerate
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Regenerate" }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(saveMessages).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("disables context-menu regenerate while a response is streaming", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn().mockResolvedValue(undefined);
    const contextMenu: ChatContextMenuState = {
      x: 20,
      y: 20,
      content: assistantMessage.content,
      role: "assistant",
      msgIndex: 1,
      isThinking: false,
    };

    render(
      <ChatContextMenu
        contextMenu={contextMenu}
        contextMenuRef={createRef<HTMLDivElement>()}
        setContextMenu={vi.fn()}
        chatMessages={[userMessage, assistantMessage]}
        sessionId="session-1"
        collapsedThinking={new Set()}
        setCollapsedThinking={vi.fn()}
        setEditingMessageId={vi.fn()}
        chatReload={reload}
        chatSend={send}
        canRegenerate={false}
      />,
    );

    const regenerate = screen.getByRole("menuitem", { name: "Regenerate" });
    expect(regenerate).toBeDisabled();
    fireEvent.click(regenerate);
    expect(api.truncateMessages).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("surfaces context-menu delete errors instead of logging them only", async () => {
    const toastError = vi.spyOn(toast, "error");
    const reload = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(api, "deleteMessage").mockRejectedValueOnce(new Error("delete failed"));
    const contextMenu: ChatContextMenuState = {
      x: 20,
      y: 20,
      content: userMessage.content,
      role: "user",
      msgIndex: 0,
      isThinking: false,
    };

    render(
      <ChatContextMenu
        contextMenu={contextMenu}
        contextMenuRef={createRef<HTMLDivElement>()}
        setContextMenu={vi.fn()}
        chatMessages={[userMessage, assistantMessage]}
        sessionId="session-1"
        collapsedThinking={new Set()}
        setCollapsedThinking={vi.fn()}
        setEditingMessageId={vi.fn()}
        chatReload={reload}
        chatSend={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete message" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Delete failed")));
    expect(reload).not.toHaveBeenCalled();
  });

  it("retains an edited draft when a message row is remounted during resend", async () => {
    const message = { ...userMessage, id: "draft-remount-user", attachments_json: null };
    const onResend = vi.fn().mockResolvedValue(undefined);
    const rowProps = {
      msg: message,
      i: 0,
      sessionId: "session-1",
      editingMessageId: message.id,
      setEditingMessageId: vi.fn(),
      collapsedThinking: new Set<number>(),
      setCollapsedThinking: vi.fn(),
      setContextMenu: vi.fn(),
      onResend,
    };

    const first = render(<MessageRow {...rowProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "edited draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save & resend" }));
    await waitFor(() => expect(onResend).toHaveBeenCalledWith(0, "edited draft"));
    first.unmount();

    render(<MessageRow {...rowProps} />);

    expect(screen.getByRole("textbox")).toHaveValue("edited draft");
  });

  it("rerenders displayed token usage when an assistant message receives usage", () => {
    const initialMessage = { ...assistantMessage, prompt_tokens: null, output_tokens: null };
    const rowProps = {
      msg: initialMessage,
      i: 1,
      sessionId: "session-1",
      editingMessageId: null,
      setEditingMessageId: vi.fn(),
      collapsedThinking: new Set<number>(),
      setCollapsedThinking: vi.fn(),
      setContextMenu: vi.fn(),
      onResend: vi.fn().mockResolvedValue(undefined),
    };
    const view = render(<MessageRow {...rowProps} />);

    expect(screen.queryByText("5 tokens")).not.toBeInTheDocument();
    view.rerender(
      <MessageRow
        {...rowProps}
        msg={{ ...initialMessage, prompt_tokens: 2, output_tokens: 3 }}
      />,
    );

    expect(screen.getByText("5 tokens")).toBeInTheDocument();
  });

  it("lets a retained MessageRow callback read the current streaming guard", async () => {
    const toastWarn = vi.spyOn(toast, "warn");
    const message = { ...userMessage, id: "stale-row-user", attachments_json: null };
    const current = { streaming: false };
    const onResend = vi.fn(async () => {
      if (current.streaming) {
        toast.warn("Stop the current response before editing or regenerating.");
      }
    });
    const rowProps = {
      msg: message,
      i: 0,
      sessionId: "session-1",
      editingMessageId: message.id,
      setEditingMessageId: vi.fn(),
      collapsedThinking: new Set<number>(),
      setCollapsedThinking: vi.fn(),
      setContextMenu: vi.fn(),
      onResend,
    };
    const view = render(<MessageRow {...rowProps} />);

    current.streaming = true;
    view.rerender(<MessageRow {...rowProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Save & resend" }));

    await waitFor(() => expect(toastWarn).toHaveBeenCalledWith(expect.stringContaining("Stop the current response")));
    expect(onResend).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale context-length result after switching models", async () => {
    const initial = deferred<number>();
    const next = deferred<number>();
    vi.spyOn(api, "getModelContextLength").mockImplementation((modelId) =>
      modelId === "initial-model" ? initial.promise : next.promise
    );

    renderChatView({ providerKind: "ollama", modelId: "initial-model" });
    await waitFor(() => expect(api.getModelContextLength).toHaveBeenCalledWith("initial-model"));

    fireEvent.click(screen.getByRole("button", { name: "Switch model" }));
    await waitFor(() => expect(api.getModelContextLength).toHaveBeenCalledWith("next-model"));

    await act(async () => {
      initial.resolve(12345);
      await initial.promise;
    });

    expect(screen.getByTestId("context-length")).toHaveTextContent("8192");
  });
});
