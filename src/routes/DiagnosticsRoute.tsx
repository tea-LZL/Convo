/**
 * Diagnostics page — health, DB stats, provider status, recent log lines.
 *
 * ── Why this page is in the final fix wave ───────────────────────────
 * One of three the restyle never reached. The plan's criterion 1 says
 * "every route" and its checklist counted ten; seven shipped. This one
 * kept `rounded-xl` cards, a hand-written `bg-accent/15 text-accent
 * border-accent/30` chip where the `Badge` primitive already spells that
 * geometry, and `text-accent` on four decorative section icons — all of
 * it under a new 28px `RouteShell` title, which is what made it the
 * most visible hybrid in the app.
 *
 * Nothing noticed, for the same reason About and Hardware went
 * unnoticed: this page had no rhythm guard, so a page with no rhythm
 * could not fail one. `DiagnosticsRoute.test.tsx` is that guard.
 *
 * ── The rhythm ───────────────────────────────────────────────────────
 * The *standard* one — 8px between cards, 12px inside one — and this
 * page is not a data page, so it is not one of the two that earn the
 * compact rhythm (decision D3: Memory, Documents and Tasks, where row
 * count is the point). Nothing here is a pile to scan; the numbers are
 * read one at a time. So the air is not competing with anything.
 *
 * ── Icons ────────────────────────────────────────────────────────────
 * Two channels, and they do not cross. `Status` carries `success`/`warn`
 * because its icon *is* the state, and those are the semantic tones
 * already in the palette. `Database`, `Wifi`, `Folder` and `Clock` are
 * decoration on a section title, and decoration in the accent colour
 * reads as a link or a selection - so they take `text-text-subtle`,
 * the same quiet channel the restyled pages give a label. The section
 * title beside them is `text-text`, so the heading is still the loudest
 * thing in the card.
 *
 * ── The chip ─────────────────────────────────────────────────────────
 * `Badge`, not a hand-written span. The span was spelling out the
 * primitive's accent variant by hand, which is how the two drift: a
 * `Badge` whose geometry is retuned moves here too, and a `Badge` that
 * grows a fifth tone is one edit rather than five.
 */
import { useEffect, useState } from "react";
import { Database, Folder, RefreshCw, CheckCircle2, AlertCircle, Wifi, WifiOff, Clock, Download, Upload } from "lucide-react";
import { api, DiagnosticsReport } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Form";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { RouteShell } from "../components/ui/RouteShell";
import { toast } from "../stores/toasts";

function formatBytes(n: number): string {
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export function DiagnosticsRoute() {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (silent = false) => {
    if (!silent) setRefreshing(true);
    setError(null);
    try {
      const r = await api.getDiagnostics();
      setReport(r);
      setLoading(false);
    } catch (e) {
      setError(String(e));
      toast.error(String(e));
      setLoading(false);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const exportBackup = async () => {
    setExporting(true);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: `convo-backup-${new Date().toISOString().slice(0, 10)}.zip`,
        filters: [{ name: "Convo backup", extensions: ["zip"] }],
      });
      if (!path) return;
      const finalPath = await api.exportBackup(path);
      toast.success(`Exported to ${finalPath}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setExporting(false);
    }
  };

  const performImport = async () => {
    setImporting(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Convo backup", extensions: ["zip"] }],
      });
      if (!path) return;
      const pathStr = Array.isArray(path) ? path[0] : path;
      const msg = await api.importBackup(pathStr);
      toast.success(msg);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setImporting(false);
    }
  };

  if (loading) {
    return (
      <RouteShell title="Diagnostics" description="Health, database stats, provider reachability, and recent log lines.">
        <div role="status" className="flex h-full items-center justify-center text-text-subtle">
          Loading diagnostics…
        </div>
      </RouteShell>
    );
  }

  if (error || !report) {
    return (
      <RouteShell
        title="Diagnostics"
        description="Health, database stats, provider reachability, and recent log lines."
        actions={<Button size="sm" variant="secondary" onClick={() => void refresh()}>Retry</Button>}
      >
        <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 text-text-muted">
          <AlertCircle size={20} className="text-error" />
          <div>Diagnostics could not be loaded</div>
          <div className="text-xs text-error max-w-md text-center">{error}</div>
        </div>
      </RouteShell>
    );
  }

  const allOk = report.providers.every((p) => p.reachable !== false);

  return (
    <RouteShell
      title="Diagnostics"
      description="Health, database stats, provider reachability, and recent log lines."
      actions={
        <>
          <Button size="sm" variant="secondary" onClick={() => void refresh()} loading={refreshing} icon={<RefreshCw size={12} />}>
            Refresh
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void exportBackup()} loading={exporting} icon={<Download size={12} />}>
            Export backup
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setConfirmImport(true)} loading={importing} icon={<Upload size={12} />}>
            Import backup
          </Button>
        </>
      }
    >
      <div className="max-w-4xl mx-auto p-4">
        <div className="space-y-2">
          <Section title="Status" icon={allOk ? <CheckCircle2 size={14} className="text-success" /> : <AlertCircle size={14} className="text-warn" />}>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="App version" value={report.app.version} />
              <Stat label="OS / Arch" value={`${report.app.os} ${report.app.arch}`} />
              <Stat label="Data dir" value={report.app.data_dir} mono />
              <Stat label="DB path" value={report.app.db_path} mono />
            </div>
          </Section>

          <Section title="Database" icon={<Database size={14} className="text-text-subtle" />}>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <Stat label="DB size" value={formatBytes(report.db.size_bytes + report.db.wal_size_bytes)} />
              <Stat label="Schema version" value={`v${report.db.schema_version}`} />
              <Stat label="Pages" value={report.db.page_count.toLocaleString()} />
              <Stat label="Page size" value={`${report.db.page_size} B`} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Sessions" value={report.counts.sessions.toLocaleString()} />
              <Stat label="Messages" value={report.counts.messages.toLocaleString()} />
              <Stat label="Notes" value={report.counts.notes.toLocaleString()} />
              <Stat label="Tasks" value={report.counts.tasks.toLocaleString()} />
              <Stat label="Documents" value={report.counts.documents.toLocaleString()} />
              <Stat label="Memory (enabled)" value={`${report.counts.memory_items} (${report.counts.enabled_memory})`} />
              <Stat label="Compare runs" value={report.counts.compare_runs.toLocaleString()} />
              <Stat label="Attachments" value={report.counts.attachments.toLocaleString()} />
            </div>
            <div className="mt-3 text-[10px] text-text-subtle">
              Per-table counts: {report.db.tables.map(([n, c]) => `${n}=${c}`).join(", ")}
            </div>
          </Section>

          <Section title="Providers" icon={<Wifi size={14} className="text-text-subtle" />}>
            {report.providers.length === 0 ? (
              <div className="text-sm text-text-muted">No providers configured. Add one in Settings → Providers.</div>
            ) : (
              <div className="space-y-2">
                {report.providers.map((p) => (
                  <div key={p.id} className="flex items-center justify-between bg-surface-2 border border-border rounded-md p-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text">{p.name}</span>
                        {/* The primitive, for the reason in the file header:
                            the span this replaces was spelling out
                            `Badge`'s accent variant by hand, one class at a
                            time, in a place a retune would not reach. */}
                        {p.is_default && <Badge variant="accent">default</Badge>}
                        <span className="text-[10px] uppercase tracking-wider text-text-subtle">{p.kind}</span>
                      </div>
                      <div className="text-xs text-text-muted mt-0.5">
                        {p.model_count} model(s){p.last_seen && ` · last seen ${new Date(p.last_seen).toLocaleString()}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {p.has_api_key && <span className="text-[10px] text-success">api key</span>}
                      {p.reachable === true && <span className="flex items-center gap-1 text-[10px] text-success"><Wifi size={10} /> online</span>}
                      {p.reachable === false && (
                        <span className="flex items-center gap-1 text-[10px] text-error" title={p.reachable_msg ?? ""}>
                          <WifiOff size={10} /> offline
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="Storage" icon={<Folder size={14} className="text-text-subtle" />}>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Attachments (blobs/)" value={formatBytes(report.storage.blobs_bytes)} />
              <Stat label="Logs (logs/)" value={formatBytes(report.storage.logs_bytes)} />
              <Stat label="Themes (themes/)" value={formatBytes(report.storage.themes_bytes)} />
            </div>
          </Section>

          <Section title="Recent log" icon={<Clock size={14} className="text-text-subtle" />}>
            {report.recent_logs.length === 0 ? (
              <div className="text-xs text-text-subtle">No log lines yet.</div>
            ) : (
              <pre className="bg-surface-2 border border-border rounded-md p-3 text-[10px] font-mono text-text-muted max-h-72 overflow-y-auto leading-relaxed">
                {report.recent_logs.join("\n")}
              </pre>
            )}
          </Section>
        </div>
      </div>
      <ConfirmDialog
        open={confirmImport}
        onClose={() => setConfirmImport(false)}
        onConfirm={async () => {
          setConfirmImport(false);
          await performImport();
        }}
        title="Import backup"
        message="Importing will overwrite the current database. This cannot be undone. Continue?"
        confirmLabel="Import"
        confirmVariant="danger"
      />
    </RouteShell>
  );
}

/**
 * One section card, and the shape every section on this page is.
 *
 * `rounded-lg` is the spec's card radius, and 12px inside is the
 * standard rhythm's card padding - both measured in
 * `DiagnosticsRoute.test.tsx` rather than asserted here. It was
 * `rounded-xl` in 16px, which is also a theme radius and so was not
 * *wrong*; it was a second, larger shape for the same object, sitting
 * under a title that had already been restyled.
 *
 * The heading is an `h2` under `RouteShell`'s `h1`, which is where the
 * outline wants it: a screen-reader user moving by level gets a flat
 * list of sections rather than a tree, and this page has five siblings
 * that are genuinely peers.
 */
function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-surface-1 border border-border rounded-lg p-3">
      <div className="flex items-center gap-2 mb-3">
        {icon}
        <h2 className="text-sm font-semibold text-text">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-subtle mb-0.5">{label}</div>
      <div className={`text-xs text-text ${mono ? "font-mono" : ""} truncate`}>{value}</div>
    </div>
  );
}
