import { useEffect, useState } from "react";
import { api, Model, Provider } from "../../lib/api";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Form";
import { Badge } from "../../components/ui/Form";

export function ModelsSection() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    if (!providerId) return;
    setLoading(true);
    try {
      setModels(await api.refreshModels(providerId));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api.listProviders().then((items) => {
      setProviders(items);
      setProviderId(items.find((item) => item.is_default)?.id ?? items[0]?.id ?? "");
    });
  }, []);

  useEffect(() => {
    if (!providerId) return;
    api.listModelsForProvider(providerId).then(setModels);
  }, [providerId]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Models</h1>
      <p className="text-sm text-text-muted mt-1 mb-6">Provider-scoped model discovery and refresh.</p>
      <div className="flex items-center gap-2 mb-4">
        <Select value={providerId} onChange={setProviderId} options={providers.map((p) => ({ value: p.id, label: p.name }))} />
        <Button variant="outline" onClick={refresh} loading={loading}>Refresh</Button>
      </div>
      <div className="border border-border rounded-lg divide-y divide-border">
        {models.length === 0 ? <p className="p-4 text-sm text-text-muted">No models found.</p> : models.map((model) => (
          <div key={model.id} className="p-3 flex items-center justify-between">
            <span className="text-sm text-text">{model.name}</span>
            {model.supports_vision && <Badge variant="accent">vision</Badge>}
          </div>
        ))}
      </div>
    </div>
  );
}
