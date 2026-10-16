/**
 * About — the app's own colophon.
 *
 * ── Why this page is in the final fix wave at all ────────────────────
 * It was one of three the restyle never reached. The plan's success
 * criterion says "every route" and its checklist counted ten; seven
 * shipped, and this one kept `rounded-xl` cards and the old `p-4 sm:p-8`
 * content inset under a new 28px `RouteShell` title. The scope was
 * narrowed without being recorded, so the hybrid was invisible to every
 * test: nothing in the suite asserted a rhythm for a page with no
 * rhythm test. `AboutRoute.test.tsx` is that assertion.
 *
 * ── The rhythm ───────────────────────────────────────────────────────
 * The *standard* one — 8px between rows, 12px inside a card — and this
 * page is not a data page, so it is not one of the two that earn the
 * compact rhythm (decision D3: Memory, Documents and Tasks, where row
 * count is the point). There is nothing here to scan, so the air is not
 * competing with anything.
 *
 * Every number is resolved out of a real Tailwind compile of the classes
 * this file renders, not read off the class names, so a retune of the
 * spacing scale moves both sides of every comparison. See
 * `AboutRoute.test.tsx`, and the note there about why the resolver is
 * duplicated rather than shared.
 *
 * ── Cards ────────────────────────────────────────────────────────────
 * `rounded-lg`, the radius the spec's card row names, and no shadow. The
 * info card was `rounded-xl`, which is also a theme radius and so was
 * not *wrong* — it was a second, larger shape for the same object.
 */
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
      {/* `p-4`, not the `p-4 sm:p-8` this carried before: the page inset
          is 16px on every route, so the title's left edge and the
          content's left edge are the same line. `RouteShell.test.tsx`
          measures the shell's half of that agreement. */}
      <div className="max-w-2xl mx-auto p-4">
        <div className="w-12 h-12 rounded-lg bg-accent flex items-center justify-center mb-4">
          <span className="text-xl">✦</span>
        </div>

        <div className="mt-6 space-y-2 text-sm text-text-muted leading-relaxed">
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
          <div className="mt-6 bg-surface-1 border border-border rounded-lg p-3 text-xs space-y-2">
            <Row label="Version" value={info.version} />
            <Row label="Platform" value={`${info.os} ${info.arch}`} />
            <Row label="Data directory" value={info.data_dir} mono />
            <Row label="Database" value={info.db_path} mono />
          </div>
        )}

        <div className="mt-4 flex items-center gap-2">
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
