import { useState } from "react";
import { ChevronDown, MoreHorizontal, RefreshCw } from "lucide-react";
import { Dropdown } from "../ui/Dropdown";
import { api, Provider, Model } from "../../lib/api";
import { toast } from "../../stores/toasts";
import { formatModelLabel } from "./format";
import { ConfirmDialog } from "../ui/ConfirmDialog";

export function ChatHeader({
  providers,
  models,
  providerId,
  modelId,
  setProviderId,
  setModelId,
  setModels,
  setContextLength,
  sessionId,
  contextLength,
  totalTokens,
}: {
  providers: Provider[];
  models: Model[];
  providerId: string;
  modelId: string;
  setProviderId: (id: string) => void;
  setModelId: (id: string) => void;
  setModels: (m: Model[]) => void;
  setContextLength: (n: number) => void;
  sessionId: string;
  contextLength: number;
  totalTokens: number;
}) {
  const [confirmClear, setConfirmClear] = useState(false);
  return (
    <div className="flex items-center gap-2 px-3 sm:px-4 h-12 border-b border-border bg-surface-1/40 backdrop-blur">
      <Dropdown
        align="left"
        menuClassName="min-w-[280px]"
        trigger={
          <button className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-2 hover:bg-surface-3 border border-border rounded-md text-sm transition-colors">
            <span className="text-text-muted text-xs">Model</span>
            <span className="text-text font-medium">{modelId ? formatModelLabel(modelId) : "Loading…"}</span>
            <ChevronDown size={12} className="text-text-subtle" />
          </button>
        }
      >
        {() => (
          <div className="py-1 max-h-80 overflow-y-auto">
            {providers.length > 1 && (
              <>
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-text-subtle">Provider</div>
                {providers.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => { setProviderId(p.id); setModelId(""); }}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between hover:bg-surface-2 ${p.id === providerId ? "text-accent" : "text-text"}`}
                  >
                    <span>{p.name}</span>
                    <span className="text-text-subtle text-[10px]">{p.kind}</span>
                  </button>
                ))}
                <div className="my-1 border-t border-border" />
              </>
            )}
            {models.length === 0 ? (
              <div className="px-3 py-3 text-xs text-text-muted">No models — refresh in Settings</div>
            ) : (
              models.map((m) => (
                <button
                  key={m.id}
                  onClick={() => { setModelId(m.name); if (m.context_length) setContextLength(m.context_length); }}
                  className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between hover:bg-surface-2 ${m.name === modelId ? "bg-accent/10 text-accent" : "text-text"}`}
                >
                  <span className="truncate">{formatModelLabel(m.name)}</span>
                  {m.size_bytes !== null && <span className="text-text-subtle text-[10px] ml-2">{(m.size_bytes / 1e9).toFixed(1)}GB</span>}
                </button>
              ))
            )}
            <div className="my-1 border-t border-border" />
            <button
              onClick={async () => {
                const list = await api.refreshModels(providerId);
                setModels(list);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 flex items-center gap-1.5"
            >
              <RefreshCw size={11} /> Refresh models
            </button>
          </div>
        )}
      </Dropdown>

      <div className="flex-1" />

      <Dropdown
        align="right"
        menuClassName="w-48"
        trigger={
          <button className="text-text-subtle hover:text-text p-1.5 rounded-md hover:bg-surface-2" aria-label="Session actions">
            <MoreHorizontal size={16} />
          </button>
        }
      >
        {() => (
          <div className="py-1">
            <button
              onClick={async () => {
                const md = await api.exportSessionMarkdown(sessionId);
                const blob = new Blob([md], { type: "text/markdown" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `convo-${sessionId.slice(0, 8)}.md`;
                a.click();
                URL.revokeObjectURL(url);
                toast.success("Exported");
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
            >
              Export as Markdown
            </button>
            <button
              onClick={() => setConfirmClear(true)}
              className="w-full text-left px-3 py-1.5 text-xs text-error hover:bg-surface-2"
            >
              Clear session
            </button>
          </div>
        )}
      </Dropdown>

      <div className="hidden sm:flex text-xs text-text-muted tabular-nums">
        {totalTokens.toLocaleString()} / {contextLength.toLocaleString()}
        <span className="text-text-subtle ml-1">({Math.min(100, Math.round((totalTokens / contextLength) * 100))}%)</span>
      </div>
      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={async () => {
          await api.saveMessages(sessionId, []);
          window.location.reload();
        }}
        title="Clear session"
        message="Clear all messages in this session? This cannot be undone."
        confirmLabel="Clear"
        confirmVariant="danger"
      />
    </div>
  );
}