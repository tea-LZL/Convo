import { useEffect, useState } from "react";
import { api, AppInfo } from "../lib/api";
import { Button } from "../components/ui/Button";
import { RouteShell } from "../components/ui/RouteShell";
import { errorClass, recordLog } from "../lib/logger";
import { ExternalLink, Folder } from "lucide-react";
import { useThemeStore } from "../stores/theme";

export function AboutRoute() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const restart = useTourStoreRestart();

  useEffect(() => {
    api.appInfo().then(setInfo).catch((error) => {
      recordLog({ operation: "app_info", status: "failed", route: "/about", errorClass: errorClass(error) });
    });
  }, []);

  return (
    <RouteShell title="About Convo" description={`v${info?.version ?? "?"} · local-first AI workspace`}>
      <div className="max-w-2xl mx-auto p-4 sm:p-8">
      <div className="w-12 h-12 rounded-xl bg-accent flex items-center justify-center mb-4">
        <span className="text-xl">✦</span>
      </div>

      <div className="mt-8 space-y-4 text-sm text-text-muted leading-relaxed">
        <p>
          Convo is a self-hosted AI workspace for Linux. It started as a focused Ollama chat
          client and has grown into a multi-provider, multi-modal tool with documents, notes,
          tasks, memory, and side-by-side model comparison.
        </p>
        <p>
          Inspired by the depth of <a href="https://github.com/pewdiepie-archdaemon/odysseus" className="text-accent hover:underline">Odysseus</a> and the simplicity
          of native desktop apps. Local-first, privacy-first, no telemetry.
        </p>
      </div>

      {info && (
        <div className="mt-8 bg-surface-1 border border-border rounded-xl p-4 text-xs space-y-1.5">
          <Row label="Version" value={info.version} />
          <Row label="Platform" value={`${info.os} ${info.arch}`} />
          <Row label="Data directory" value={info.data_dir} mono />
          <Row label="Database" value={info.db_path} mono />
        </div>
      )}

      <div className="mt-6 flex items-center gap-2">
        <Button
          variant="secondary"
          icon={<Folder size={14} />}
          onClick={async () => {
            const path = await api.openDataDir();
            toast.info(`Data dir: ${path}`);
          }}
        >
          Show data directory
        </Button>
        <Button variant="ghost" onClick={restart}>Replay tour</Button>
      </div>
      </div>
    </RouteShell>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-subtle">{label}</span>
      <span className={`text-text text-right ${mono ? "font-mono text-[11px]" : ""} truncate max-w-[60%]`}>{value}</span>
    </div>
  );
}

import { useTourStore } from "../stores/tour";
import { toast } from "../stores/toasts";

function useTourStoreRestart() {
  const restart = useTourStore((s) => s.restart);
  return () => {
    restart();
    toast.info("Tour restarted");
  };
}
