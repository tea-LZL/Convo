/**
 * File attachments — drag/drop, paste, picker.
 *
 * Each attachment is encoded as base64 and sent to the Rust `add_attachment`
 * command, which writes the blob to `data_dir/blobs/<id>/<filename>` and
 * inserts a row in the `attachments` table.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ChatMessage } from "../lib/api";
import { listen } from "@tauri-apps/api/event";

export interface PendingAttachment {
  /** local id for the UI */
  localId: string;
  /** server id after upload (or null while uploading) */
  serverId: string | null;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "document" | "audio" | "unknown";
  previewUrl: string | null;
  status: "uploading" | "ready" | "error";
  error?: string;
}

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_FILES = 6;

function guessKind(mime: string, name: string): PendingAttachment["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || mime.startsWith("text/") || /\.(md|txt|csv|json|ya?ml|toml|rs|py|ts|tsx|js|jsx|go|java|c|cpp|h|hpp|css|html|sh|sql)$/i.test(name)) {
    return "document";
  }
  return "unknown";
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is "data:<mime>;base64,<data>"
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export interface UseAttachments {
  attachments: PendingAttachment[];
  addFiles: (files: File[] | FileList) => void;
  remove: (localId: string) => void;
  clear: () => void;
  /** Build the JSON payload to embed in a chat message's `attachments_json`. */
  serializeForMessage: (ids: string[]) => string;
  isDragging: boolean;
}

export function useAttachments(sessionId: string | null): UseAttachments {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);
  const fileByLocalId = useRef(new Map<string, File>());
  const activeUploads = useRef(new Set<string>());

  const addFiles = useCallback(
    (filesIn: File[] | FileList) => {
      const files = Array.from(filesIn);
      if (files.length === 0) return;
      setAttachments((prev) => {
        const room = MAX_FILES - prev.length;
        const next = [...prev];
        const accepted = files.slice(0, Math.max(0, room));
        for (const f of accepted) {
          if (f.size > MAX_FILE_BYTES) {
            toastOnce(`${f.name} is too large (max 25 MB)`);
            continue;
          }
          const localId = crypto.randomUUID();
          fileByLocalId.current.set(localId, f);
          next.push({
            localId,
            serverId: null,
            name: f.name,
            mime: f.type || "application/octet-stream",
            size: f.size,
            kind: guessKind(f.type || "", f.name),
            previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
            status: "uploading",
          });
        }
        return next;
      });
    },
    []
  );

  // Upload pending files as they appear.
  useEffect(() => {
    const uploading = attachments.filter(
      (a) => a.status === "uploading" && a.serverId === null && !activeUploads.current.has(a.localId)
    );
    if (uploading.length === 0) return;
    for (const attachment of uploading) activeUploads.current.add(attachment.localId);
    (async () => {
      for (const a of uploading) {
        try {
          const f = fileByLocalId.current.get(a.localId);
          if (!f) {
            activeUploads.current.delete(a.localId);
            continue;
          }
          const data = await readAsBase64(f);
          const result = await api.addAttachment({
            name: a.name,
            mime: a.mime,
            dataBase64: data,
            sessionId,
            messageId: null,
          });
          setAttachments((prev) =>
            prev.map((x) =>
              x.localId === a.localId ? { ...x, serverId: result.id, status: "ready" } : x
            )
          );
          fileByLocalId.current.delete(a.localId);
        } catch (e) {
          if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
          setAttachments((prev) =>
            prev.map((x) =>
              x.localId === a.localId
                ? { ...x, previewUrl: null, status: "error", error: String(e) }
                : x
            )
          );
          fileByLocalId.current.delete(a.localId);
        }
        activeUploads.current.delete(a.localId);
      }
    })();
  }, [attachments, sessionId]);

  const remove = useCallback((localId: string) => {
    setAttachments((prev) => {
      const found = prev.find((x) => x.localId === localId);
      if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
      fileByLocalId.current.delete(localId);
      activeUploads.current.delete(localId);
      // Best-effort delete on the server
      if (found?.serverId) api.deleteAttachment(found.serverId).catch(() => {});
      return prev.filter((x) => x.localId !== localId);
    });
  }, []);

  const clear = useCallback(() => {
    setAttachments((prev) => {
      for (const a of prev) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        if (a.serverId) api.deleteAttachment(a.serverId).catch(() => {});
      }
      fileByLocalId.current.clear();
      activeUploads.current.clear();
      return [];
    });
  }, []);

  useEffect(() => () => {
    for (const attachment of attachmentsRef.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    fileByLocalId.current.clear();
    activeUploads.current.clear();
  }, []);

  const serializeForMessage = useCallback((ids: string[]) => {
    return JSON.stringify(
      attachments
        .filter((a) => a.serverId && ids.includes(a.serverId))
        .map((a) => ({
          id: a.serverId,
          name: a.name,
          mime: a.mime,
          size: a.size,
          kind: a.kind,
        }))
    );
  }, [attachments]);

  // Drag/drop wiring on document.
  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      dragCounter.current += 1;
      setIsDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setIsDragging(false);
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragging(false);
      if (e.dataTransfer?.files?.length) {
        addFiles(e.dataTransfer.files);
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const it of items) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return;
      addFiles(files);
    };
    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
      document.removeEventListener("paste", onPaste);
    };
  }, [addFiles]);

  return { attachments, addFiles, remove, clear, serializeForMessage, isDragging };
}

let lastToastKey = "";
function toastOnce(msg: string) {
  if (lastToastKey === msg) return;
  lastToastKey = msg;
  setTimeout(() => { lastToastKey = ""; }, 2000);
  // Lazy import to avoid circular dep
  import("../stores/toasts").then(({ toast }) => toast.warn(msg));
}

export function isImageAttachment(a: PendingAttachment): boolean {
  return a.kind === "image";
}
