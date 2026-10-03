/**
 * Hardware scan + model-fit recommendations.
 *
 * ── Why this page is in the final fix wave ───────────────────────────
 * The third of three the restyle never reached. The plan's criterion 1
 * says "every route" and its checklist counted ten; seven shipped. This
 * one kept `rounded-xl` cards in two separate components, a `space-y-4`
 * (16px) stack gap, `text-accent` on two decorative section icons, a
 * bare `rounded` radius on its status chips and a `sm:p-8` content
 * inset — all under a new 28px `RouteShell` title.
 *
 * Nothing noticed, because nothing asked: this page had no rhythm
 * guard, so a page with no rhythm could not fail one.
 * `HardwareRoute.test.tsx` is that guard, and it measures the same way
 * `DiagnosticsRoute.test.tsx` does.
 *
 * ── The rhythm ───────────────────────────────────────────────────────
 * The *standard* one — 8px between cards, 12px inside one. This page
 * is not a data page, so it is not one of the two that earn the compact
 * rhythm (decision D3: Memory, Documents and Tasks, where row count is
 * the point). A fit list is *recommendations to read*, not a queue to
 * scan, and its two-column grid has to stay legible at arm's length.
 *
 * ── Two components, one shape ─────────────────────────────────────────
 * `Section` and `FitSection` are separate components because they take
 * different children, and for six commits they drew the same object two
 * ways: `Section` took a caller-supplied title, `FitSection` appended a
 * count to it, and both wrote `rounded-xl p-4`. They now share the
 * geometry, and the test walks *both* — a guard that measured one would
 * have passed a page where the other had drifted, which is exactly the
 * failure this page already had once.
 *
 * ── Icons ────────────────────────────────────────────────────────────
 * Two channels, and they do not cross. `Monitor` and the GPU glyph are
 * decoration on a section title, and decoration in the accent colour
 * reads as a link or a selection — so they take `text-text-subtle`.
 * `Check`, `AlertTriangle` and `X` *are* the verdict on a model, and
 * keep the semantic tones the status card already established.
 */
import { useEffect, useState } from "react";
import { Monitor, CpuIcon as GpuIcon, Check, AlertTriangle, X, Download } from "lucide-react";
import { api, FitReport, HardwareReport, ModelFit } from "../lib/api";
import { Button } from "../components/ui/Button";
import { RouteShell } from "../components/ui/RouteShell";
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
      <RouteShell title="Hardware scan" description="Check available CPU, RAM, and GPU resources.">
        <div role="status" className="flex h-full items-center justify-center text-text-subtle">
        Scanning hardware…
        </div>
      </RouteShell>
    );
  }

  if (failed || !hw || !fit) {
    return (
      <RouteShell
        title="Hardware scan"
        description="Check available CPU, RAM, and GPU resources."
        actions={<Button size="sm" variant="secondary" onClick={() => void scan()}>Re-scan</Button>}
      >
        <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 text-text-muted">
          <AlertTriangle size={20} className="text-error" />
          <div>Hardware scan failed</div>
        </div>
      </RouteShell>
    );
  }

  return (
    <RouteShell
      title="Hardware scan"
      description="Convo scans your machine to suggest models that fit. Numbers are best-effort; actual VRAM/RAM needs depend on the quant and context size."
      actions={<Button size="sm" variant="secondary" onClick={() => void scan()}>Re-scan</Button>}
    >
      <div className="max-w-4xl mx-auto p-4">
        <div className="space-y-2">
          <Section title="System" icon={<Monitor size={14} className="text-text-subtle" />}>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="OS" value={`${hw.os} ${hw.arch}`} />
              <Stat label="CPU" value={hw.cpuBrand || "Unknown"} />
              <Stat label="CPU cores" value={String(hw.cpuCores)} />
              <Stat label="Total RAM" value={formatBytes(hw.totalMemoryBytes)} />
              <Stat label="Available RAM" value={formatBytes(hw.availableMemoryBytes)} />
            </div>
          </Section>

          <Section title={`GPUs (${hw.gpus.length})`} icon={<GpuIcon size={14} className="text-text-subtle" />}>
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
    </RouteShell>
  );
}

/**
 * The two fit verdicts, as one card.
 *
 * `rounded-lg` in 12px, the spec's card radius and the standard
 * rhythm's card padding — the same geometry `Section` below draws, and
 * the reason it is a shared constant rather than a second hand-written
 * class list. The two were `rounded-xl p-4` and `rounded-lg p-3`
 * simultaneously for six commits, which is two shapes for one object.
 */
const FIT_CARD = "bg-surface-1 border border-border rounded-lg p-3";

/**
 * The 10px verdict chip. A theme radius (`rounded-sm`) rather than the
 * bare `rounded` this carried, so a retune of the theme's corner
 * scale moves the chip with the cards around it.
 */
const VERDICT = "text-[10px] px-1.5 py-0.5 rounded-sm border";

function FitSection({ title, icon, rows, navigate }: { title: string; icon: React.ReactNode; rows: ModelFit[]; navigate: (path: string) => void }) {
  return (
    <div className={FIT_CARD}>
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
                <span className={`${VERDICT} border-success/30 bg-success/10 text-success`}>fits</span>
              ) : (
                <span className={`${VERDICT} border-warn/30 bg-warn/10 text-warn`}>tight</span>
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

/**
 * One section card, and the shape every section on this page is.
 *
 * `rounded-lg` is the spec's card radius and 12px inside is the
 * standard rhythm's card padding — both measured in
 * `HardwareRoute.test.tsx` rather than asserted here. It was
 * `rounded-xl` in 16px, which is also a theme radius and so was not
 * *wrong*; it was a second, larger shape for the same object, sitting
 * under a title that had already been restyled.
 *
 * The heading is an `h2` under `RouteShell`'s `h1`, which is where the
 * outline wants it: a screen-reader user moving by level gets a flat
 * list of sections rather than a tree, and these are genuinely peers.
 */
function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={FIT_CARD}>
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
