/**
 * Diagnostics page — health, DB stats, provider status, recent log lines.
 */
import { useEffect, useState } from "react";
import { Database, Folder, RefreshCw, CheckCircle2, AlertCircle, Wifi, WifiOff, Clock, Download, Upload } from "lucide-react";
import { api, DiagnosticsReport } from "../lib/api";
import { Button } from "../components/ui/Button";
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
      <div className="max-w-4xl mx-auto p-4 sm:p-8">
        <div className="space-y-4">
          <Section title="Status" icon={allOk ? <CheckCircle2 size={14} className="text-success" /> : <AlertCircle size={14} className="text-warn" />}>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="App version" value={report.app.version} />
              <Stat label="OS / Arch" value={`${report.app.os} ${report.app.arch}`} />
              <Stat label="Data dir" value={report.app.data_dir} mono />
              <Stat label="DB path" value={report.app.db_path} mono />
            </div>
          </Section>

          <Section title="Database" icon={<Database size={14} className="text-accent" />}>
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

          <Section title="Providers" icon={<Wifi size={14} className="text-accent" />}>
            {report.providers.length === 0 ? (
              <div className="text-sm text-text-muted">No providers configured. Add one in Settings → Providers.</div>
            ) : (
              <div className="space-y-2">
                {report.providers.map((p) => (
                  <div key={p.id} className="flex items-center justify-between bg-surface-2 border border-border rounded-md p-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text">{p.name}</span>
                        {p.is_default && <span className="text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border bg-accent/15 text-accent border-accent/30">default</span>}
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

          <Section title="Storage" icon={<Folder size={14} className="text-accent" />}>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Attachments (blobs/)" value={formatBytes(report.storage.blobs_bytes)} />
              <Stat label="Logs (logs/)" value={formatBytes(report.storage.logs_bytes)} />
              <Stat label="Themes (themes/)" value={formatBytes(report.storage.themes_bytes)} />
            </div>
          </Section>

          <Section title="Recent log" icon={<Clock size={14} className="text-accent" />}>
            {report.recent_logs.length === 0 ? (
              <div className="text-xs text-text-subtle">No log lines yet.</div>
            ) : (
              <pre className="bg-surface-2 border border-border rounded-md p-2 text-[10px] font-mono text-text-muted max-h-72 overflow-y-auto leading-relaxed">
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

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-subtle mb-0.5">{label}</div>
      <div className={`text-xs text-text ${mono ? "font-mono" : ""} truncate`}>{value}</div>
    </div>
  );
}
