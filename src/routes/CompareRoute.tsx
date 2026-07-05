/**
 * Compare route — side-by-side model comparison with blind mode, per-column
 * stop, save winner as chat, history.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, CompareConfig, CompareRunSummary, CompareRunResult } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Dropdown } from "../components/ui/Dropdown";
import { EmptyState } from "../components/ui/EmptyState";
import { Modal } from "../components/ui/Modal";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";
import { MarkdownRenderer } from "../components/chat/MarkdownRenderer";
import { escapeThinkTags } from "../components/chat/MessageRow";
import { GitCompareArrows, Play, Square, Trophy, Eye, EyeOff, History, Save, ExternalLink, Sparkles } from "lucide-react";
import { diffLines, diffStats } from "../lib/diff";
import { listen } from "@tauri-apps/api/event";
import { useSessionsStore } from "../stores/sessions";
import { toast } from "../stores/toasts";

interface ColumnState {
  startedAt: number;
  content: string;
  thinking: string;
  done: boolean;
  error?: string;
  cancelled?: boolean;
  promptTokens?: number;
  outputTokens?: number;
}

export function CompareRoute() {
  const [providers, setProviders] = useState<Array<{ id: string; name: string; kind: string }>>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({});
  const [prompt, setPrompt] = useState("");
  const [selected, setSelected] = useState<Array<{ provider_id: string; model: string }>>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [columns, setColumns] = useState<ColumnState[]>([]);
  const [blind, setBlind] = useState(true);
  const [winner, setWinner] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<CompareRunSummary[]>([]);
  const [showDiff, setShowDiff] = useState(false);
  const navigate = useNavigate();
  const refreshSessions = useSessionsStore((s) => s.refresh);

  useEffect(() => {
    api.listProviders().then((ps) => {
      setProviders(ps.map((p) => ({ id: p.id, name: p.name, kind: p.kind })));
      ps.forEach((p) => {
        if (p.kind === "ollama") {
          api.listModelsForProvider(p.id).then((ms) => {
            setModelsByProvider((prev) => ({ ...prev, [p.id]: ms.map((m) => m.name) }));
          }).catch(() => {});
        } else if (p.base_url) {
          api.probeProvider(p.kind, p.base_url, p.api_key ?? undefined).then((r) => {
            if (r.ok) setModelsByProvider((prev) => ({ ...prev, [p.id]: r.models.map((m) => m.name) }));
          }).catch(() => {});
        }
      });
    }).catch(console.error);
  }, []);

  useEffect(() => {
    if (!runId) return;
    const unlisteners: Array<() => void> = [];
    (async () => {
      const u1 = await listen<{ run_id: string; index: number; content: string; full_content: string }>("compare-chunk", (e) => {
        if (e.payload.run_id !== runId) return;
        setColumns((prev) => {
          const next = prev.slice();
          next[e.payload.index] = {
            ...(next[e.payload.index] || { startedAt: Date.now(), content: "", thinking: "", done: false }),
            content: e.payload.full_content,
          };
          return next;
        });
      });
      const u2 = await listen<{ run_id: string; index: number; thinking: string }>("compare-thinking", (e) => {
        if (e.payload.run_id !== runId) return;
        setColumns((prev) => {
          const next = prev.slice();
          next[e.payload.index] = {
            ...(next[e.payload.index] || { startedAt: Date.now(), content: "", thinking: "", done: false }),
            thinking: e.payload.thinking,
          };
          return next;
        });
      });
      const u3 = await listen<{ run_id: string; index: number; prompt_tokens: number; output_tokens: number }>("compare-done", (e) => {
        if (e.payload.run_id !== runId) return;
        setColumns((prev) => {
          const next = prev.slice();
          next[e.payload.index] = {
            ...(next[e.payload.index] || { startedAt: Date.now(), content: "", thinking: "", done: false }),
            done: true,
            promptTokens: e.payload.prompt_tokens,
            outputTokens: e.payload.output_tokens,
          };
          return next;
        });
      });
      const u4 = await listen<{ run_id: string; index: number; error: string }>("compare-error", (e) => {
        if (e.payload.run_id !== runId) return;
        setColumns((prev) => {
          const next = prev.slice();
          next[e.payload.index] = {
            ...(next[e.payload.index] || { startedAt: Date.now(), content: "", thinking: "", done: false }),
            done: true,
            error: e.payload.error,
          };
          return next;
        });
      });
      const u5 = await listen<{ run_id: string; index: number }>("compare-cancelled", (e) => {
        if (e.payload.run_id !== runId) return;
        setColumns((prev) => {
          const next = prev.slice();
          next[e.payload.index] = {
            ...(next[e.payload.index] || { startedAt: Date.now(), content: "", thinking: "", done: false }),
            done: true,
            cancelled: true,
          };
          return next;
        });
      });
      unlisteners.push(u1, u2, u3, u4, u5);
    })();
    return () => unlisteners.forEach((u) => u());
  }, [runId]);

  const addModel = () => {
    if (selected.length >= 4) return;
    const first = providers[0];
    if (!first) return;
    const firstModel = modelsByProvider[first.id]?.[0] ?? "";
    setSelected([...selected, { provider_id: first.id, model: firstModel }]);
  };

  const removeModel = (i: number) => {
    setSelected(selected.filter((_, idx) => idx !== i));
  };

  const updateModel = (i: number, patch: Partial<{ provider_id: string; model: string }>) => {
    setSelected(selected.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };

  const start = async () => {
    if (!prompt.trim() || selected.length < 2) return;
    setColumns(
      selected.map(() => ({ startedAt: Date.now(), content: "", thinking: "", done: false }))
    );
    setRunId(null);
    setWinner(null);
    setRevealed(false);
    try {
      const cfg: CompareConfig = { prompt, models: selected };
      const id = await api.runCompare(cfg);
      setRunId(id);
    } catch (e) {
      console.error("compare start:", e);
      toast.error(String(e));
    }
  };

  const cancelAll = async () => {
    if (!runId) return;
    try { await api.cancelCompare(runId); } catch (e) { console.error(e); }
    setRunId(null);
  };

  const cancelOne = async (i: number) => {
    if (!runId) return;
    try { await api.cancelCompareColumn(runId, i); } catch (e) { console.error(e); }
  };

  const allDone = columns.length > 0 && columns.every((c) => c.done);
  const anyStreaming = columns.some((c) => !c.done);

  const pickWinner = async (i: number) => {
    setWinner(i);
    setRevealed(true);
    if (runId) {
      try { await api.saveCompareWinner(runId, i); } catch (e) { console.error(e); }
    }
  };

  const continueInChat = async (i: number) => {
    if (!runId) return;
    try {
      const sid = await api.saveCompareAsSession(runId, i);
      await refreshSessions();
      toast.success("Saved as chat");
      navigate(`/chat/${sid}`);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const loadHistory = async () => {
    try {
      const list = await api.listCompareRuns(50);
      setHistory(list);
      setShowHistory(true);
    } catch (e) { toast.error(String(e)); }
  };

  const loadRun = async (id: string) => {
    try {
      const r = await api.getCompareRun(id);
      setShowHistory(false);
      setPrompt(r.prompt);
      try {
        const cfg = JSON.parse(r.config_json);
        setSelected(cfg.models || []);
      } catch { setSelected([]); }
      // Replay results into columns
      let results: CompareRunResult[] = [];
      if (r.results_json) {
        try { results = JSON.parse(r.results_json); } catch {}
      }
      setColumns(
        (results.length ? results : Array(4).fill({ content: "", thinking: "" })).map((res) => ({
          startedAt: Date.now(),
          content: res.content || "",
          thinking: res.thinking || "",
          done: true,
          cancelled: res.cancelled,
          error: res.error,
          promptTokens: res.prompt_tokens,
          outputTokens: res.output_tokens,
        }))
      );
      setRunId(r.id);
      setWinner(r.winner_index);
      setRevealed(r.winner_index !== null);
    } catch (e) { toast.error(String(e)); }
  };

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="border-b border-border bg-surface-1/40 backdrop-blur px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <GitCompareArrows size={16} className="text-accent" />
          <h1 className="text-sm font-semibold text-text">Compare models</h1>
          <div className="flex-1" />
          <Button size="xs" variant="ghost" icon={<History size={12} />} onClick={loadHistory}>
            History
          </Button>
          <button
            onClick={() => setBlind(!blind)}
            className="text-xs text-text-muted hover:text-text flex items-center gap-1 px-2 py-1 rounded-md hover:bg-surface-2"
          >
            {blind ? <EyeOff size={12} /> : <Eye size={12} />}
            {blind ? "Blind" : "Labeled"}
          </button>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Prompt to send to all models…"
          rows={2}
          className="w-full bg-surface-2 border border-border rounded-md px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:border-accent resize-none"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {selected.map((sel, i) => (
            <div key={i} className="flex items-center gap-1 bg-surface-2 border border-border rounded-md pl-2 pr-1 py-1">
              <Dropdown
                align="left"
                menuClassName="min-w-[260px]"
                trigger={
                  <button className="text-xs text-text-muted hover:text-text flex items-center gap-1">
                    <span className="text-[10px] uppercase">Provider</span>
                    <span>{providers.find((p) => p.id === sel.provider_id)?.name ?? "—"}</span>
                    <span className="text-text-subtle">›</span>
                  </button>
                }
              >
                {() => (
                  <div className="py-1 max-h-64 overflow-y-auto">
                    {providers.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => updateModel(i, { provider_id: p.id, model: modelsByProvider[p.id]?.[0] ?? "" })}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 ${p.id === sel.provider_id ? "text-accent" : "text-text"}`}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </Dropdown>
              <Dropdown
                align="left"
                menuClassName="min-w-[200px]"
                trigger={
                  <button className="text-xs text-text-muted hover:text-text flex items-center gap-1">
                    <span className="text-[10px] uppercase">Model</span>
                    <span className="text-text">{sel.model || "—"}</span>
                    <span className="text-text-subtle">›</span>
                  </button>
                }
              >
                {() => (
                  <div className="py-1 max-h-64 overflow-y-auto">
                    {(modelsByProvider[sel.provider_id] ?? []).map((m) => (
                      <button
                        key={m}
                        onClick={() => updateModel(i, { model: m })}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 ${m === sel.model ? "text-accent" : "text-text"}`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </Dropdown>
              <button onClick={() => removeModel(i)} className="text-text-subtle hover:text-error ml-1 px-1" title="Remove">×</button>
            </div>
          ))}
          {selected.length < 4 && (
            <Button size="xs" variant="outline" onClick={addModel} icon={<span>+</span>}>
              Add model
            </Button>
          )}
          <div className="flex-1" />
          {runId ? (
            <Button size="sm" variant="danger" onClick={cancelAll} icon={<Square size={12} fill="currentColor" />}>
              Stop all
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={start} disabled={!prompt.trim() || selected.length < 2} icon={<Play size={12} />}>
              Run compare
            </Button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {columns.length === 0 ? (
          <EmptyState
            icon={<GitCompareArrows size={32} />}
            title="No comparison yet"
            description="Add 2–4 models, write a prompt, and run a comparison. Blind mode hides labels until you reveal."
            action={<Button variant="primary" onClick={loadHistory} icon={<History size={14} />}>View past runs</Button>}
          />
        ) : (
          <div className={`grid gap-3 ${columns.length === 2 ? "grid-cols-2" : columns.length === 3 ? "grid-cols-3" : "grid-cols-2 lg:grid-cols-4"}`}>
            {columns.map((col, i) => {
              const elapsed = Date.now() - col.startedAt;
              const label = blind && !revealed ? String.fromCharCode(65 + i) : selected[i]?.model || "—";
              return (
                <ErrorBoundary key={i} label={`Compare ${label}`}>
                <div className="flex flex-col bg-surface-1 border border-border rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface-2/40">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[10px] uppercase tracking-wider text-text-subtle">Model</span>
                      <span className="text-xs font-medium text-text truncate">
                        {blind && !revealed ? String.fromCharCode(65 + i) : selected[i]?.model || "—"}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {!col.done ? (
                        <>
                          <span className="text-[10px] text-accent tabular-nums">{(elapsed / 1000).toFixed(1)}s</span>
                          <button
                            onClick={() => cancelOne(i)}
                            className="text-[10px] text-error/80 hover:text-error px-1"
                            title="Stop this column"
                          >
                            <Square size={9} fill="currentColor" />
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="text-[10px] text-text-subtle tabular-nums">
                            {(col.outputTokens ?? 0) + (col.promptTokens ?? 0)}t · {((Date.now() - col.startedAt) / 1000).toFixed(1)}s
                          </span>
                          {allDone && !winner && (
                            <button onClick={() => pickWinner(i)} className="text-xs text-text-muted hover:text-accent flex items-center gap-1" title="Pick as winner">
                              <Trophy size={12} />
                            </button>
                          )}
                          {winner === i && <Trophy size={12} className="text-warn" />}
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 p-3 text-sm text-text overflow-y-auto max-h-[60vh] prose prose-invert prose-sm max-w-none">
                    {col.thinking && (
                      <details className="mb-2 text-text-muted text-xs">
                        <summary className="cursor-pointer">Thinking</summary>
                        <div className="mt-1 whitespace-pre-wrap">{col.thinking}</div>
                      </details>
                    )}
                    {col.error ? (
                      <div className="text-error text-xs">{col.error}</div>
                    ) : col.cancelled && !col.content ? (
                      <div className="text-text-subtle text-xs italic">Stopped</div>
                    ) : col.content ? (
                      <MarkdownRenderer content={escapeThinkTags(col.content)} />
                    ) : (
                      <div className="text-text-subtle text-xs italic">Waiting…</div>
                    )}
                  </div>
                </div>
                </ErrorBoundary>
              );
            })}
          </div>
        )}
        {anyStreaming && columns.length > 0 && (
          <div className="mt-3 text-center text-xs text-text-subtle">
            Streaming {columns.filter((c) => !c.done).length} of {columns.length}…
          </div>
        )}
        {allDone && columns.length > 0 && !revealed && (
          <div className="flex justify-center mt-4 gap-2">
            {winner !== null && (
              <Button variant="secondary" icon={<Save size={12} />} onClick={() => continueInChat(winner)}>
                Continue winner in chat
              </Button>
            )}
            <Button variant="primary" onClick={() => setRevealed(true)}>Reveal & pick winner</Button>
            <Button variant="ghost" icon={<GitCompareArrows size={12} />} onClick={() => setShowDiff(true)} disabled={columns.length < 2}>Diff</Button>
          </div>
        )}
        {revealed && winner !== null && (
          <div className="flex justify-center mt-4 gap-2">
            <Button variant="primary" icon={<ExternalLink size={12} />} onClick={() => continueInChat(winner)}>
              Continue in chat
            </Button>
            <Button variant="ghost" icon={<GitCompareArrows size={12} />} onClick={() => setShowDiff(true)} disabled={columns.length < 2}>Diff</Button>
          </div>
        )}
      </div>
      <HistoryModal open={showHistory} onClose={() => setShowHistory(false)} history={history} onSelect={loadRun} />
      {showDiff && columns.length >= 2 && (
        <DiffModal
          leftContent={columns[0].content || ""}
          rightContent={columns[1].content || ""}
          leftLabel={blind && !revealed ? "Model A" : selected[0]?.model || "Column 1"}
          rightLabel={blind && !revealed ? "Model B" : selected[1]?.model || "Column 2"}
          onClose={() => setShowDiff(false)}
        />
      )}
    </div>
  );
}

function HistoryModal({ open, onClose, history, onSelect }: { open: boolean; onClose: () => void; history: CompareRunSummary[]; onSelect: (id: string) => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Compare history" size="lg">
      {history.length === 0 ? (
        <div className="text-text-muted text-sm text-center py-6">No past comparisons</div>
      ) : (
        <ul className="space-y-1">
          {history.map((h) => {
            const title = h.prompt.split("\n")[0].slice(0, 80) || "(no prompt)";
            const dt = new Date(h.created_at).toLocaleString();
            return (
              <li key={h.id}>
                <button
                  onClick={() => onSelect(h.id)}
                  className="w-full text-left p-3 bg-surface-2 hover:bg-surface-3 border border-border rounded-md flex items-start gap-2"
                >
                  <Sparkles size={12} className="text-text-subtle shrink-0 mt-1" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-text truncate">{title}</div>
                    <div className="text-[10px] text-text-subtle mt-0.5">
                      {dt} {h.winner_index !== null && <span className="text-warn">· winner #{h.winner_index + 1}</span>}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

function DiffModal({
  leftContent,
  rightContent,
  leftLabel,
  rightLabel,
  onClose,
}: {
  leftContent: string;
  rightContent: string;
  leftLabel: string;
  rightLabel: string;
  onClose: () => void;
}) {
  const ops = diffLines(leftContent, rightContent);
  const stats = diffStats(ops);
  return (
    <Modal open={true} onClose={onClose} title={`Diff: ${leftLabel} vs ${rightLabel}`} size="xl">
      <div className="flex items-center gap-2 text-xs mb-2">
        <span className="text-success">+{stats.added} added</span>
        <span className="text-error">\u2212{stats.removed} removed</span>
      </div>
      <div className="bg-surface-1 border border-border rounded-md overflow-hidden text-xs font-mono leading-relaxed max-h-[50vh] overflow-y-auto">
        {ops.length === 0 ? (
          <div className="p-3 text-text-muted">No differences</div>
        ) : (
          ops.map((op, i) => {
            const lines = op.value.split("\n");
            return (
              <div key={i}>
                {lines.map((line, j) => {
                  if (line === "" && j === lines.length - 1 && op.kind === "equal") return null;
                  const prefix = op.kind === "add" ? "+" : op.kind === "remove" ? "\u2212" : " ";
                  const cls =
                    op.kind === "add"
                      ? "bg-success/10 text-success"
                      : op.kind === "remove"
                        ? "bg-error/10 text-error"
                        : "text-text-muted";
                  return (
                    <div key={j} className={`flex items-start gap-2 px-3 py-0.5 ${cls}`}>
                      <span className="w-3 text-text-subtle text-right select-none">{prefix}</span>
                      <span className="whitespace-pre-wrap break-words flex-1">{line || " "}</span>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}
