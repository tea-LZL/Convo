import { X } from "lucide-react";
import { Spinner } from "../ui/Form";
import { PendingAttachment } from "../../hooks/useAttachments";
import type { AttachmentData } from "./types";

export function parseAttachments(json: string | null | undefined): AttachmentData[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function AttachmentChip({ att }: { att: AttachmentData }) {
  const isImage = att.kind === "image" || att.mime.startsWith("image/");
  return (
    <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-surface-2 border border-border rounded-md text-[10px] text-text-muted">
      <span className="text-text-subtle">{isImage ? "🖼" : att.mime === "application/pdf" ? "📕" : "📄"}</span>
      <span className="truncate max-w-[160px]">{att.name}</span>
    </div>
  );
}

export function AttachmentStripItem({ a, onRemove }: { a: PendingAttachment; onRemove: () => void }) {
  return (
    <div className="relative group">
      {a.previewUrl ? (
        <div className="w-16 h-16 rounded-md border border-border overflow-hidden bg-surface-2">
          <img src={a.previewUrl} alt={a.name} className="w-full h-full object-cover" />
        </div>
      ) : (
        <div className="px-2 py-1.5 bg-surface-2 border border-border rounded-md text-xs text-text-muted max-w-[180px] truncate">
          {a.name}
        </div>
      )}
      <button
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-surface-3 border border-border rounded-full flex items-center justify-center text-text-muted hover:text-error"
        aria-label="Remove attachment"
      >
        <X size={9} />
      </button>
      {a.status === "uploading" && (
        <div className="absolute inset-0 bg-black/30 rounded-md flex items-center justify-center">
          <Spinner size={12} />
        </div>
      )}
    </div>
  );
}