/**
 * Hardware scan + model-fit recommendations.
 */
import { useEffect, useState } from "react";
import { Cpu, Monitor, CpuIcon as GpuIcon, Check, AlertTriangle, X, Download } from "lucide-react";
import { api, FitReport, HardwareReport, ModelFit } from "../lib/api";
import { Button } from "../components/ui/Button";
import { useNavigate } from "react-router-dom";
import { toast } from "../stores/toasts";

function formatBytes(n: number): string {
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export function HardwareRoute() {
  const [hw, setHw] = useState<HardwareReport | null>(null);
  const [fit, setFit] = useState<FitReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const navigate = useNavigate();

  const scan = async () => {
    setLoading(true);
    setFailed(false);
    setHw(null);
    setFit(null);
    try {
      const h = await api.getHardware();
      setHw(h);
      const f = await api.recommendModels(h);
      setFit(f);
    } catch (e) {
      setFailed(true);
      toast.error(String(e));
    }
    setLoading(false);
  };

  useEffect(() => { scan(); }, []);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-subtle">
        Scanning hardware…
      </div>
    );
  }

  if (failed || !hw || !fit) {
    return (
      <div role="alert" className="flex-1 flex flex-col items-center justify-center gap-3 text-text-muted">
        <AlertTriangle size={20} className="text-error" />
        <div>Hardware scan failed</div>
        <Button size="sm" variant="secondary" onClick={scan}>Re-scan</Button>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto p-8">
        <div className="flex items-center gap-2 mb-2">
          <Cpu size={18} className="text-accent" />
          <h1 className="text-xl font-semibold text-text">Hardware scan</h1>
          <div className="flex-1" />
          <Button size="sm" variant="secondary" onClick={scan}>Re-scan</Button>
        </div>
        <p className="text-sm text-text-muted mb-6">
          Convo scans your machine to suggest models that fit. Numbers are best-effort — actual
          VRAM/RAM needs depend on the quant and context size.
        </p>

        <div className="space-y-4">
          <Section title="System" icon={<Monitor size={14} className="text-accent" />}>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="OS" value={`${hw.os} ${hw.arch}`} />
              <Stat label="CPU" value={hw.cpuBrand || "Unknown"} />
              <Stat label="CPU cores" value={String(hw.cpuCores)} />
              <Stat label="Total RAM" value={formatBytes(hw.totalMemoryBytes)} />
              <Stat label="Available RAM" value={formatBytes(hw.availableMemoryBytes)} />
            </div>
          </Section>

          <Section title={`GPUs (${hw.gpus.length})`} icon={<GpuIcon size={14} className="text-accent" />}>
            {hw.gpus.length === 0 ? (
              <div className="text-sm text-text-muted">No GPU detected. Models will run on CPU/RAM.</div>
            ) : (
              <ul className="space-y-1">
                {hw.gpus.map((g, i) => (
                  <li key={i} className="flex items-center justify-between bg-surface-2 border border-border rounded-md px-3 py-2 text-sm">
                    <div>
                      <div className="text-text font-medium">{g.name}</div>
                      <div className="text-[10px] text-text-subtle uppercase tracking-wider">{g.vendor}</div>
                    </div>
                    <div className="text-xs text-text-muted">{g.vramBytes !== null ? formatBytes(g.vramBytes) : "VRAM unknown"}</div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {fit.fits.length > 0 && (
            <FitSection title="Fits comfortably" icon={<Check size={14} className="text-success" />} rows={fit.fits} navigate={navigate} />
          )}
          {fit.partial.length > 0 && (
            <FitSection title="Tight fit" icon={<AlertTriangle size={14} className="text-warn" />} rows={fit.partial} navigate={navigate} />
          )}
          {fit.tooBig.length > 0 && (
            <FitSection title="Too large for this hardware" icon={<X size={14} className="text-error" />} rows={fit.tooBig} navigate={navigate} />
          )}

          <div className="text-xs text-text-subtle">
            <strong>Note:</strong> recommendations assume Q4_K_M quant for dense models, ~1.3× param
            count in bytes (Q4 ≈ 0.5 bytes/param + overhead). CPU-only and partial offload
            scenarios are not modeled precisely.
          </div>
        </div>
      </div>
    </div>
  );
}

function FitSection({ title, icon, rows, navigate }: { title: string; icon: React.ReactNode; rows: ModelFit[]; navigate: (path: string) => void }) {
  return (
    <div className="bg-surface-1 border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        {icon}
        <h2 className="text-sm font-semibold text-text">{title} ({rows.length})</h2>
      </div>
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {rows.map((m, i) => (
          <li key={i} className="bg-surface-2 border border-border rounded-md p-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-text font-medium">{m.name}</div>
                <div className="text-[10px] text-text-subtle uppercase tracking-wider">{m.family} · {m.sizeLabel} · {m.recommendedQuant ?? "n/a"}</div>
              </div>
              {m.fits ? (
                <span className="text-[10px] text-success px-1.5 py-0.5 rounded border border-success/30 bg-success/10">fits</span>
              ) : (
                <span className="text-[10px] text-warn px-1.5 py-0.5 rounded border border-warn/30 bg-warn/10">tight</span>
              )}
            </div>
            <div className="text-xs text-text-muted mt-1.5">{m.reason}</div>
            <div className="mt-2 flex items-center gap-1">
              <Button size="xs" variant="ghost" onClick={() => navigate("/settings")} icon={<Download size={10} />}>
                Open in Settings
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-surface-1 border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        {icon}
        <h2 className="text-sm font-semibold text-text">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-subtle mb-0.5">{label}</div>
      <div className="text-xs text-text">{value}</div>
    </div>
  );
}
