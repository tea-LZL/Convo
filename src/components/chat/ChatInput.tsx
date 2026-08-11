import { useState, useRef, useEffect } from "react";
import { Send, Square, Paperclip } from "lucide-react";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Form";
import { IconButton } from "../ui/IconButton";
import { useAttachments } from "../../hooks/useAttachments";
import { parseCommand, runCommand, SlashCommandContext } from "../../lib/slashCommands";
import type { ChatStatus } from "../../stores/chatStream";

type ChatInputAttachments = Pick<ReturnType<typeof useAttachments>, "attachments" | "addFiles">;

function fallbackFilePicker(attachments: ChatInputAttachments) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.onchange = () => {
    if (input.files) attachments.addFiles(input.files);
  };
  input.click();
}

function guessMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    pdf: "application/pdf", txt: "text/plain", md: "text/markdown",
    json: "application/json", csv: "text/csv",
  };
  return map[ext] ?? "application/octet-stream";
}

export function ChatInput({
  disabled,
  streaming,
  status = streaming ? "streaming" : "idle",
  attachments,
  onSend,
  onStop,
  onInputChange,
  slashCtx,
}: {
  disabled: boolean;
  streaming: boolean;
  status?: ChatStatus;
  attachments: ChatInputAttachments;
  onSend: (text: string) => Promise<void> | void;
  onStop: () => void;
  onInputChange: (text: string) => void;
  slashCtx: SlashCommandContext;
}) {
  const [input, setInput] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const hasAttachmentError = attachments.attachments.some((attachment) => attachment.status === "error");
  const attachmentsBlocked = attachments.attachments.some((attachment) => attachment.status !== "ready");

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = Math.min(ref.current.scrollHeight, 200) + "px";
    }
  }, [input]);

  useEffect(() => {
    if (!streaming) ref.current?.focus();
  }, [streaming]);

  useEffect(() => {
    const onFocus = () => ref.current?.focus();
    window.addEventListener("convo:focus-input", onFocus);
    return () => window.removeEventListener("convo:focus-input", onFocus);
  }, []);

  // ArrowUp recall (last user message)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" && input === "" && ref.current && document.activeElement === ref.current) {
        e.preventDefault();
        const ev = new CustomEvent("convo:recall-last");
        window.dispatchEvent(ev);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [input]);

  const openPicker = async () => {
    try {
      const dialog = await import("@tauri-apps/plugin-dialog");
      const selected = await dialog.open({
        multiple: true,
        directory: false,
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      // Read file bytes via Tauri fs plugin, then construct File objects.
      try {
        const fs = await import("@tauri-apps/plugin-fs");
        const files: File[] = [];
        for (const p of paths) {
          const bytes = await fs.readFile(p);
          const name = typeof p === "string" ? p.split("/").pop()?.split("\\").pop() ?? "file" : "file";
          const mime = guessMime(name);
          files.push(new File([bytes], name, { type: mime }));
        }
        if (files.length > 0) attachments.addFiles(files);
      } catch {
        // fs.readFile failed (e.g. permission scope) — fall back to <input>
        fallbackFilePicker(attachments);
      }
    } catch {
      // Tauri dialog unavailable — fall back to <input>
      fallbackFilePicker(attachments);
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || streaming || disabled || attachmentsBlocked) return;
    const parsed = parseCommand(text);
    if (parsed) {
      const result = await runCommand(parsed, slashCtx);
      if (result.sent && result.text) {
        setInput("");
        await onSend(result.text);
        return;
      }
      if (result.text !== undefined) {
        setInput(result.text);
        setTimeout(() => ref.current?.focus(), 0);
        return;
      }
      if (result.clear) {
        setInput("");
        return;
      }
    }
    setInput("");
    await onSend(text);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="rounded-lg border border-border bg-surface-1 shadow-panel">
      <textarea
        ref={ref}
        data-chat-input
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          onInputChange(e.target.value);
        }}
        onKeyDown={handleKey}
        placeholder="Type a message, or / for commands… (Enter to send, Shift+Enter for newline)"
        rows={1}
        disabled={disabled}
        className="w-full bg-transparent text-sm text-text placeholder:text-text-subtle focus:outline-none px-4 pt-3 pb-1 resize-none overflow-y-auto"
        style={{ maxHeight: 200 }}
      />
      <div className="flex items-center justify-between px-3 pb-2.5">
        <div className="flex items-center gap-1">
          <Tooltip content="Attach file (or drag & drop)">
            <IconButton icon={<Paperclip size={14} />} label="Attach" size="sm" onClick={openPicker} />
          </Tooltip>
          {hasAttachmentError && (
            <span role="alert" className="text-xs text-error">Remove failed attachments to send</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {streaming ? (
            <Button
              size="sm"
              variant="danger"
              onClick={onStop}
              disabled={status === "stopping"}
              icon={<Square size={12} fill="currentColor" />}
            >
              {status === "stopping" ? "Stopping…" : "Stop"}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              onClick={handleSend}
              disabled={!input.trim() || disabled || attachmentsBlocked}
              icon={<Send size={12} />}
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
