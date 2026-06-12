import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Dropdown } from "../components/ui/Dropdown";
import { EmptyState } from "../components/ui/EmptyState";
import { GitCompareArrows, Play, Square, Trophy, Eye, EyeOff } from "lucide-react";
import { listen } from "@tauri-apps/api/event";

export function CompareRoute() {
  const [providers, setProviders] = useState<Array<{ id: string; name: string; kind: string }>>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({});
  const [prompt, setPrompt] = useState("");
  const [selected, setSelected] = useState<Array<{ provider_id: string; model: string }>>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [results, setResults] = useState<Array<{ content: string; thinking: string; done: boolean; error?: string }>>([]);
  const [blind, setBlind] = useState(true);
  const [winner, setWinner] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    api.listProviders().then((ps) => {
      setProviders(ps.map((p) => ({ id: p.id, name: p.name, kind: p.kind })));
      // Auto-load models for each provider
      ps.forEach((p) => {
        if (p.kind === "ollama") {
          api.listModels().then((ms) => {
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
        setResults((prev) => {
          const next = prev.slice();
          next[e.payload.index] = { ...(next[e.payload.index] || { content: "", thinking: "", done: false }), content: e.payload.full_content };
          return next;
        });
      });
      const u2 = await listen<{ run_id: string; index: number; thinking: string }>("compare-thinking", (e) => {
        if (e.payload.run_id !== runId) return;
        setResults((prev) => {
          const next = prev.slice();
          next[e.payload.index] = { ...(next[e.payload.index] || { content: "", thinking: "", done: false }), thinking: e.payload.thinking };
          return next;
        });
      });
      const u3 = await listen<{ run_id: string; index: number; prompt_tokens: number; output_tokens: number }>("compare-done", (e) => {
        if (e.payload.run_id !== runId) return;
        setResults((prev) => {
          const next = prev.slice();
          next[e.payload.index] = { ...(next[e.payload.index] || { content: "", thinking: "", done: false }), done: true };
          return next;
        });
      });
      const u4 = await listen<{ run_id: string; index: number; error: string }>("compare-error", (e) => {
        if (e.payload.run_id !== runId) return;
        setResults((prev) => {
          const next = prev.slice();
          next[e.payload.index] = { ...(next[e.payload.index] || { content: "", thinking: "", done: false }), done: true, error: e.payload.error };
          return next;
        });
      });
      unlisteners.push(u1, u2, u3, u4);
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

  const start = async () => {
    if (!prompt.trim() || selected.length < 2) return;
    setResults(selected.map(() => ({ content: "", thinking: "", done: false })));
    setRunId(null);
    setWinner(null);
    setRevealed(false);
    try {
      const id = await api.runCompare({
        prompt,
        models: selected,
      });
      setRunId(id);
    } catch (e) {
      console.error("compare start:", e);
    }
  };

  const cancel = async () => {
    if (!runId) return;
    try { await api.cancelCompare(runId); } catch (e) { console.error(e); }
    setRunId(null);
  };

  const allDone = results.length > 0 && results.every((r) => r.done);
  const pickWinner = async (i: number) => {
    setWinner(i);
    setRevealed(true);
    if (runId) {
      try { await api.saveCompareWinner(runId, i); } catch (e) { console.error(e); }
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="border-b border-border bg-surface-1/40 backdrop-blur px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <GitCompareArrows size={16} className="text-accent" />
          <h1 className="text-sm font-semibold text-text">Compare models</h1>
          <div className="flex-1" />
          <button
            onClick={() => setBlind(!blind)}
            className="text-xs text-text-muted hover:text-text flex items-center gap-1"
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
            <div key={i} className="flex items-center gap-1 bg-surface-2 border border-border rounded-md px-2 py-1">
              <span className="text-[10px] uppercase text-text-subtle">{blind && !revealed ? `Model ${String.fromCharCode(65 + i)}` : sel.model}</span>
              <span className="text-text-subtle">·</span>
              <span className="text-xs text-text">{sel.model}</span>
              <button onClick={() => removeModel(i)} className="text-text-subtle hover:text-error ml-1">×</button>
            </div>
          ))}
          {selected.length < 4 && (
            <Button size="xs" variant="outline" onClick={addModel} icon={<span>+</span>}>
              Add model
            </Button>
          )}
          <div className="flex-1" />
          {runId ? (
            <Button size="sm" variant="danger" onClick={cancel} icon={<Square size={12} fill="currentColor" />}>
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
        {results.length === 0 ? (
          <EmptyState
            icon={<GitCompareArrows size={32} />}
            title="No comparison yet"
            description="Add 2–4 models, write a prompt, and run a comparison. Blind mode hides labels until you reveal."
          />
        ) : (
          <div className={`grid gap-3 ${results.length === 2 ? "grid-cols-2" : results.length === 3 ? "grid-cols-3" : "grid-cols-2 lg:grid-cols-4"}`}>
            {results.map((r, i) => (
              <div key={i} className="flex flex-col bg-surface-1 border border-border rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface-2/40">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[10px] uppercase tracking-wider text-text-subtle">Model</span>
                    <span className="text-xs font-medium text-text truncate">
                      {blind && !revealed ? String.fromCharCode(65 + i) : selected[i]?.model}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    {!r.done && <span className="text-[10px] text-accent">streaming…</span>}
                    {r.done && allDone && !winner && (
                      <button onClick={() => pickWinner(i)} className="text-xs text-text-muted hover:text-accent flex items-center gap-1" title="Pick as winner">
                        <Trophy size={12} />
                      </button>
                    )}
                    {winner === i && <Trophy size={12} className="text-warn" />}
                  </div>
                </div>
                <div className="flex-1 p-3 text-sm text-text overflow-y-auto max-h-[60vh] prose prose-invert prose-sm max-w-none">
                  {r.thinking && (
                    <details className="mb-2 text-text-muted text-xs">
                      <summary className="cursor-pointer">Thinking</summary>
                      <div className="mt-1 whitespace-pre-wrap">{r.thinking}</div>
                    </details>
                  )}
                  {r.error ? (
                    <div className="text-error text-xs">{r.error}</div>
                  ) : r.content ? (
                    <div className="whitespace-pre-wrap break-words">{r.content}</div>
                  ) : (
                    <div className="text-text-subtle text-xs italic">Waiting…</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {allDone && !revealed && results.length > 0 && (
          <div className="flex justify-center mt-4">
            <Button variant="primary" onClick={() => setRevealed(true)}>Reveal & pick winner</Button>
          </div>
        )}
      </div>
    </div>
  );
}
