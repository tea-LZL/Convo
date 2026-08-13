import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { api, Model, Provider } from "../../lib/api";
import { errorClass, recordLog } from "../../lib/logger";
import { Button } from "../../components/ui/Button";
import { Badge, Select, TextInput } from "../../components/ui/Form";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Modal } from "../../components/ui/Modal";
import { toast } from "../../stores/toasts";

interface PullState {
  operationId: string;
  name: string;
  percent: number;
  status: string;
}

interface PullEvent {
  operation_id: string;
  provider_id: string;
  name: string;
  status: string;
  percent: number;
  error?: string | null;
}

export function ModelsSection() {
  const navigate = useNavigate();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pull, setPull] = useState<PullState | null>(null);
  const [pullName, setPullName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Model | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customBase, setCustomBase] = useState("");
  const [customContext, setCustomContext] = useState("8192");
  const [customBusy, setCustomBusy] = useState(false);

  const provider = providers.find((item) => item.id === providerId);

  const refresh = async () => {
    if (!providerId) return;
    setLoading(true);
    setError(null);
    try {
      setModels(await api.refreshModels(providerId));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api.listProviders().then((items) => {
      setProviders(items);
      setProviderId((current) => current && items.some((item) => item.id === current)
        ? current
        : items.find((item) => item.is_default)?.id ?? items[0]?.id ?? "");
    }).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!providerId) return;
    let active = true;
    setError(null);
    api.listModelsForProvider(providerId)
      .then((items) => { if (active) setModels(items); })
      .catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [providerId]);

  useEffect(() => {
    let active = true;
    const unlisteners: UnlistenFn[] = [];
    const setup = async () => {
      const events = await Promise.all([
        listen<PullEvent>("model-pull-progress", (event) => {
          if (!active) return;
          setPull((current) => current && current.operationId === event.payload.operation_id
            ? { ...current, percent: event.payload.percent, status: event.payload.status }
            : current);
        }),
        listen<PullEvent>("model-pull-done", (event) => {
          if (!active) return;
          setPull((current) => current?.operationId === event.payload.operation_id ? null : current);
          if (event.payload.operation_id) {
             void api.refreshModels(event.payload.provider_id).then(setModels).catch((error) => {
               recordLog({ operation: "refresh_models_after_pull", status: "failed", route: "/settings/models", errorClass: errorClass(error) });
             });
            toast.success(`Pulled ${event.payload.name}`);
          }
        }),
        listen<PullEvent>("model-pull-error", (event) => {
          if (!active) return;
          setPull((current) => current?.operationId === event.payload.operation_id ? null : current);
          toast.error(event.payload.error ?? `Could not pull ${event.payload.name}`);
        }),
        listen<PullEvent>("model-pull-cancelled", (event) => {
          if (!active) return;
          setPull((current) => current?.operationId === event.payload.operation_id ? null : current);
        }),
      ]);
      const valid = events.filter((unlisten): unlisten is UnlistenFn => typeof unlisten === "function");
      if (!active) valid.forEach((unlisten) => unlisten());
      else unlisteners.push(...valid);
    };
    setup().catch((e) => setError(String(e)));
    return () => {
      active = false;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  const startChat = async (model: Model) => {
    try {
      const session = await api.createSession({
        title: model.name,
        modelId: model.id,
        providerId: model.provider_id,
      });
      navigate(`/chat/${session.id}`);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const startPull = async (name: string) => {
    if (!provider || provider.kind !== "ollama") return;
    try {
      const operationId = await api.pullModelForProvider(provider.id, name);
      setPull({ operationId, name, percent: 0, status: "starting" });
    } catch (e) {
      toast.error(String(e));
    }
  };

  const deleteModel = async () => {
    if (!deleteTarget || !provider) return;
    try {
      await api.deleteModelForProvider(provider.id, deleteTarget.name);
      setModels((items) => items.filter((item) => item.id !== deleteTarget.id));
      toast.success(`Deleted ${deleteTarget.name}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDeleteTarget(null);
    }
  };

  const createCustom = async () => {
    if (!provider || provider.kind !== "ollama" || !customName.trim() || !customBase.trim()) return;
    setCustomBusy(true);
    try {
      await api.createCustomModelForProvider(provider.id, customName.trim(), customBase.trim(), Number(customContext) || 8192);
      toast.success(`Created ${customName.trim()}`);
      setCustomOpen(false);
      setCustomName("");
      setCustomBase("");
      await refresh();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCustomBusy(false);
    }
  };

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Models</h1>
      <p className="text-sm text-text-muted mt-1 mb-6">Discover, manage, and start chats with provider-scoped models.</p>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Select aria-label="Model provider" value={providerId} onChange={setProviderId} options={providers.map((p) => ({ value: p.id, label: p.name }))} />
        <Button variant="outline" onClick={refresh} loading={loading}>Refresh</Button>
        {provider?.kind === "ollama" && <Button variant="secondary" onClick={() => setCustomOpen(true)}>Create custom</Button>}
      </div>
      {provider?.kind === "ollama" && (
        <div className="mb-4 flex items-center gap-2">
          <TextInput aria-label="Model name to pull" value={pullName} onChange={setPullName} placeholder="Model name to pull (for example llama3.2)" />
          <Button
            variant="secondary"
            disabled={!pullName.trim() || pull !== null}
            onClick={() => { void startPull(pullName.trim()); setPullName(""); }}
          >
            Pull model
          </Button>
        </div>
      )}
      {error && <div role="alert" className="mb-4 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">{error}</div>}
      {pull && (
        <div className="mb-4 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-text-muted">
          <div className="flex items-center justify-between gap-2">
            <span>{pull.status}: {pull.name} ({Math.round(pull.percent)}%)</span>
            <Button size="xs" variant="danger" onClick={() => api.cancelModelPull(pull.operationId).catch((e) => toast.error(String(e)))}>Cancel</Button>
          </div>
          <div className="mt-2 h-1 rounded bg-surface-3"><div className="h-1 rounded bg-accent" style={{ width: `${Math.min(100, Math.max(0, pull.percent))}%` }} /></div>
        </div>
      )}
      <div className="border border-border rounded-lg divide-y divide-border">
        {models.length === 0 ? <p className="p-4 text-sm text-text-muted">No models found. Refresh this provider to discover models.</p> : models.map((model) => (
          <div key={model.id} className="p-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-text truncate">{model.name}</span>
                {model.supports_vision && <Badge variant="accent">vision</Badge>}
                {model.supports_thinking && <Badge variant="default">thinking</Badge>}
              </div>
              <div className="text-[10px] text-text-subtle mt-0.5">
                {model.context_length ? `${model.context_length.toLocaleString()} context` : "Context size unknown"}
                {model.family ? ` · ${model.family}` : ""}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button size="xs" variant="primary" onClick={() => startChat(model)}>Start chat</Button>
              {provider?.kind === "ollama" && <Button size="xs" variant="ghost" onClick={() => startPull(model.name)} disabled={pull !== null}>Pull</Button>}
              {provider?.kind === "ollama" && <Button size="xs" variant="danger" onClick={() => setDeleteTarget(model)}>Delete</Button>}
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={deleteModel}
        title="Delete model"
        message={`Delete ${deleteTarget?.name ?? "this model"} from the selected provider?`}
        confirmLabel="Delete"
        confirmVariant="danger"
      />
      <Modal
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        title="Create custom Ollama model"
        description="Create a provider-side model with a custom context length."
        footer={(
          <>
            <Button variant="ghost" onClick={() => setCustomOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={customBusy} onClick={createCustom}>Create</Button>
          </>
        )}
      >
        <div className="space-y-3">
          <div><label htmlFor="custom-model-name" className="mb-1 block text-xs text-text-muted">Model name</label><TextInput id="custom-model-name" value={customName} onChange={setCustomName} placeholder="my-model" /></div>
          <div><label htmlFor="custom-base-model" className="mb-1 block text-xs text-text-muted">Base model</label><TextInput id="custom-base-model" value={customBase} onChange={setCustomBase} placeholder="llama3.2" /></div>
          <div><label htmlFor="custom-context-length" className="mb-1 block text-xs text-text-muted">Context length</label><TextInput id="custom-context-length" value={customContext} onChange={setCustomContext} type="number" /></div>
        </div>
      </Modal>
    </div>
  );
}
