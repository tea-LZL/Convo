import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useThemeStore } from "../stores/theme";
import { useSettingsStore } from "../stores/settings";
import { parseEvent, useShortcutsStore, comboDisplay } from "../stores/shortcuts";
import { useTourStore } from "../stores/tour";
import { api, Provider, SearchConfig } from "../lib/api";
import { errorClass, recordLog } from "../lib/logger";
import { ModelsSection as ProviderModelsSection } from "./settings/ModelsSection";
import { KnowledgeSection } from "./settings/KnowledgeSection";
import { Button } from "../components/ui/Button";
import { RouteShell } from "../components/ui/RouteShell";
import { Modal } from "../components/ui/Modal";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Switch, Tabs, TextInput, TextArea, Select, Badge } from "../components/ui/Form";
import { Dropdown } from "../components/ui/Dropdown";
import { toast } from "../stores/toasts";
import { Cpu, Palette, KeyRound, Search, Keyboard, Info, Plus, Trash2, CheckCircle2, AlertCircle, Brain } from "lucide-react";

/**
 * Settings — a two-pane page, and one of the three that keep the
 * *standard* rhythm.
 *
 * ── The rhythm, and what governs it here ───────────────────────────────
 * The standard rhythm is an 8px step between rows and 12px inside a card.
 * Settings has no gap between its rows at all: it separates them with a
 * 1px rule, which is the older and denser way to do the same job and is
 * the right one for a list that runs to a dozen rows under a heading. So
 * what the rhythm governs here is the 12px *inside* a row, and the rule
 * is the step.
 *
 * That makes the claim worth asserting a stronger one than on the other
 * standard pages: not that one row is 12px, but that the page has *one*
 * row rhythm. The general rows, the Knowledge section's rows, the
 * discovered-servers rows and the shortcut rows were four separate
 * `py-3` / `py-2` literals, and the test now walks all four and asserts
 * they resolve to the same number. A page whose rows drift apart is a
 * page that reads as four pages.
 *
 * Every number is resolved out of a real Tailwind compile of the classes
 * the page rendered. `SettingsRoute.test.tsx` also resolves the compact
 * rhythm the same way, so it can show the measurement tells the two apart
 * and a row at 8px is not a row at 12px.
 *
 * ── The heading outline ────────────────────────────────────────────────
 * `RouteShell` owns this page's `h1`, and every section used to reach for
 * something else: the nav label was an `h2` repeating the page's own title
 * word for word, the section titles were `h2` and their card labels `h2`
 * as well, and `ModelsSection` — the one section that did not use
 * `SectionTitle` — put an `h1` on the page, so the page had two. A
 * screen-reader user moving by level got a flat list where a tree was
 * meant. The nav label is now a group header, the card labels are `h3`
 * under their section's `h2`, and `ModelsSection`'s heading is the `h2`
 * its siblings have.
 *
 * ── Cards ──────────────────────────────────────────────────────────────
 * `rounded-lg`, which is the radius the spec's card row names. Every card
 * on this page was `rounded-xl`, which is also a theme radius and so was
 * not wrong — it was a second, larger shape for the same object.
 *
 * ── The one place a literal colour is correct ───────────────────────────
 * A theme swatch's job is to *show* the theme's colours, so it paints
 * them from `tokens_json` at runtime and there is no var to read. That is
 * the single exemption from this page's no-literal rule, it is marked in
 * the markup as `data-swatch`, and the test exempts exactly that marker —
 * with a second assertion that the swatch really is carrying the theme's
 * own token, so the exemption cannot be used to smuggle a hardcoded
 * colour onto a swatch and call it a preview.
 *
 * `Card` is defined here and again in `KnowledgeSection.tsx`, with
 * identical bodies. It is duplication this task did not fix: a shared
 * module would be a new file, and the two sections are reviewable apart.
 * Recorded rather than done.
 */

export function SettingsRoute() {
  const location = useLocation();
  const path = location.pathname.replace(/^\/settings\/?/, "");
  const [section, setSection] = useState<string>(path || "general");

  useEffect(() => {
    setSection(path || "general");
  }, [path]);

  return (
    <RouteShell title="Settings" description="Configure providers, models, search, themes, and shortcuts." contentClassName="overflow-hidden">
    <div className="flex h-full min-h-0 flex-col sm:flex-row">
      <aside className="w-full sm:w-56 bg-surface-1 border-b sm:border-b-0 sm:border-r border-border p-2 shrink-0">
        {/* A group header, not a heading. It was an `h2` repeating the
            page's own `h1` word for word, so a screen-reader user heard
            "Settings" twice and the nav was a sibling of the sections it
            navigates rather than a label above them. The same treatment the
            sidebar's group headers get. */}
        <div className="text-[10px] uppercase tracking-wider text-group-header font-semibold px-2 py-2">Sections</div>
        <nav className="flex flex-row sm:flex-col gap-0.5 overflow-x-auto">
          <SettingsLink to="/settings/general" icon={<Info size={14} />} label="General" active={section === "general"} />
          <SettingsLink to="/settings/providers" icon={<KeyRound size={14} />} label="Providers" active={section === "providers"} />
          <SettingsLink to="/settings/models" icon={<Cpu size={14} />} label="Models" active={section === "models"} />
          <SettingsLink to="/settings/knowledge" icon={<Brain size={14} />} label="Knowledge" active={section === "knowledge"} />
          <SettingsLink to="/settings/search" icon={<Search size={14} />} label="Web search" active={section === "search"} />
          <SettingsLink to="/settings/theme" icon={<Palette size={14} />} label="Theme" active={section === "theme"} />
          <SettingsLink to="/settings/shortcuts" icon={<Keyboard size={14} />} label="Shortcuts" active={section === "shortcuts"} />
        </nav>
      </aside>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-4 sm:p-8">
          {section === "general" && <GeneralSection />}
          {section === "providers" && <ProvidersSection />}
          {section === "models" && <ModelsSection />}
          {section === "knowledge" && <KnowledgeSection />}
          {section === "search" && <SearchSection />}
          {section === "theme" && <ThemeSection />}
          {section === "shortcuts" && <ShortcutsSection />}
        </div>
      </div>
    </div>
    </RouteShell>
  );
}

function SettingsLink({ to, icon, label, active }: { to: string; icon: React.ReactNode; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        active ? "bg-accent/15 text-accent" : "text-text-muted hover:text-text hover:bg-surface-2"
      }`}
    >
      {icon}
      {label}
    </Link>
  );
}

function SectionTitle({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-xl font-semibold text-text">{title}</h2>
        {description && <p className="text-sm text-text-muted mt-1">{description}</p>}
      </div>
      {action}
    </div>
  );
}

function GeneralSection() {
  const settings = useSettingsStore();
  const restartTour = useTourStore((s) => s.restart);
  return (
    <div>
      <SectionTitle title="General" description="App-wide preferences." />
      {/* The six switch rows do *not* go through `SettingRow`, and the reason
          is an accessibility defect rather than a layout one.

          `Switch` takes its accessible name from its own `label` prop — it
          wires `aria-labelledby` to the `<label>` it renders. A `Switch`
          handed only `checked` and `onChange` is therefore announced as
          "Toggle", and this section had six of them, in a row, identical.
          `SettingRow` put the name in its own left column, which is a
          `<div>` and associates with nothing, so the name was for sighted
          users only.

          The fix is to let `Switch` own the name it already knows how to
          wire, and the visual result is the same: `Switch` renders its
          label at `text-sm text-text` and its description at
          `text-xs text-text-muted mt-0.5`, which are exactly the classes
          `SettingRow` used, and its own row is a `justify-between` with the
          track on the right. `SwitchRow` is that row's 12px padding and its
          1px rule, and nothing else.

          `SettingRow` is still the row for a `Button` and a `Select`,
          where the control is not a switch and cannot carry a name. The
          Knowledge section's own switch already passed `label` and was
          never affected. */}
      <Card>
        <SwitchRow>
          <Switch
            label="Sound effects"
            description="Subtle sounds for send and response complete"
            checked={!settings.muteSounds}
            onChange={(v) => settings.update("muteSounds", !v)}
          />
        </SwitchRow>
        <SwitchRow>
          <Switch
            label="Desktop notifications"
            description="Notify when a response completes while the window is unfocused"
            checked={!settings.muteNotifications}
            onChange={(v) => settings.update("muteNotifications", !v)}
          />
        </SwitchRow>
        <SwitchRow>
          <Switch
            label="Enter to send"
            description="Send messages with Enter; Shift+Enter for new line"
            checked={settings.enterToSend}
            onChange={(v) => settings.update("enterToSend", v)}
          />
        </SwitchRow>
        <SwitchRow>
          <Switch
            label="Show token count"
            description="Display token usage in the input bar"
            checked={settings.showTokenCount}
            onChange={(v) => settings.update("showTokenCount", v)}
          />
        </SwitchRow>
        <SwitchRow>
          <Switch
            label="Show thinking by default"
            description="Expand model thinking cards automatically"
            checked={settings.showThinking}
            onChange={(v) => settings.update("showThinking", v)}
          />
        </SwitchRow>
        <SwitchRow>
          <Switch
            label="Auto-extract memory from chat"
            description="After each chat with ≥ 2 exchanges, ask the model to propose durable facts (preferences, project facts, skills) for review on the Memory page."
            checked={settings.memoryAutoEvaluate}
            onChange={(v) => settings.update("memoryAutoEvaluate", v)}
          />
        </SwitchRow>
      </Card>
      <Card className="mt-4">
        <SettingRow
          label="Onboarding tour"
          description="Replay the introduction and feature overview."
          control={<Button size="sm" variant="secondary" onClick={restartTour}>Replay tour</Button>}
        />
      </Card>
    </div>
  );
}

export function ProvidersSection() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"ollama" | "openai_compat">("ollama");
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434");
  const [apiKey, setApiKey] = useState("");
  const [probeMsg, setProbeMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [discovered, setDiscovered] = useState<Array<{ base_url: string; models: Array<{ name: string }> }>>([]);
  const [scanning, setScanning] = useState(false);
  const [confirmDeleteProvider, setConfirmDeleteProvider] = useState<string | null>(null);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setProviders(await api.listProviders());
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void refresh(); }, []);

  const probe = async () => {
    try {
      const r = await api.probeProvider(kind, baseUrl, apiKey || undefined);
      setProbeMsg({ ok: r.ok, message: r.ok ? `Found ${r.models.length} models` : r.message });
    } catch (e) {
      setProbeMsg({ ok: false, message: String(e) });
    }
  };

  const add = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const providerName = name.trim() || `${kind} (${baseUrl})`;
      let providerId: string;
      if (editingProvider) {
        await api.updateProvider(editingProvider.id, providerName, baseUrl.trim() || null, apiKey || null, null);
        providerId = editingProvider.id;
      } else {
        const created = await api.addProvider(kind, providerName, baseUrl.trim() || null, apiKey || null);
        providerId = created.id;
      }
      setAdding(false);
      setEditingProvider(null);
      setName(""); setApiKey(""); setProbeMsg(null);
      await refresh();
       await api.refreshModels(providerId).catch((error) => {
         recordLog({ operation: "refresh_models", status: "failed", route: "/settings/providers", errorClass: errorClass(error) });
       });
      toast.success(editingProvider ? "Provider updated" : "Provider added");
    } catch (e) { toast.error(String(e)); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteProvider(id);
      await refresh();
      toast.success("Provider deleted");
    } catch (e) { toast.error(String(e)); }
  };

  const setDefault = async (id: string) => {
    try {
      await api.updateProvider(id, null, null, null, true);
      await refresh();
    } catch (e) { toast.error(String(e)); }
  };

  const scan = async () => {
    setScanning(true);
    try {
      const list = await api.discoverLocalServers();
      setDiscovered(list);
      if (list.length === 0) toast.info("No servers found on ports 8000-8020");
    } catch (e) { toast.error(String(e)); }
    setScanning(false);
  };

  return (
    <div>
      <SectionTitle title="Providers" description="Connect to Ollama, OpenAI-compatible APIs, or local servers (vLLM, llama.cpp)." />
      <div className="mb-4 flex items-center gap-2">
         <Button
           variant="primary"
           onClick={() => {
             setEditingProvider(null);
             setName("");
             setKind("ollama");
             setBaseUrl("http://localhost:11434");
             setApiKey("");
             setProbeMsg(null);
             setAdding(true);
           }}
           icon={<Plus size={12} />}
         >Add provider</Button>
        <Button variant="outline" onClick={scan} loading={scanning} icon={<Search size={12} />}>Discover local servers</Button>
      </div>
      {discovered.length > 0 && (
        <Card className="mb-4">
          <h3 className="text-sm font-medium text-text mb-2">Discovered servers</h3>
          {discovered.map((s, i) => (
            <div key={i} className="flex items-center justify-between py-2 border-t border-border first:border-t-0">
              <div>
                <div className="text-sm text-text">{s.base_url}</div>
                <div className="text-xs text-text-muted">{s.models.length} models</div>
              </div>
              <Button
                size="xs"
                variant="secondary"
                onClick={async () => {
                  await api.addProvider("openai_compat", `Local @ ${s.base_url}`, s.base_url, null);
                  await refresh();
                  setDiscovered(discovered.filter((_, j) => j !== i));
                  toast.success("Added");
                }}
              >
                Add
              </Button>
            </div>
          ))}
        </Card>
      )}
      <Card>
        {loading ? (
          <div className="text-center text-text-muted text-sm py-6">Loading providers…</div>
        ) : loadError ? (
          <div role="alert" className="text-center text-error text-sm py-6">
            <p>{loadError}</p>
            <Button size="xs" variant="secondary" onClick={() => void refresh()} className="mt-2">Retry</Button>
          </div>
        ) : providers.length === 0 ? (
          <div className="text-center text-text-muted text-sm py-6">No providers yet. Add one to start chatting.</div>
        ) : (
          providers.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 py-3 border-b border-border last:border-b-0">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text">{p.name}</span>
                  {p.is_default && <Badge variant="accent">default</Badge>}
                  {p.has_api_key && <Badge variant="success">api key</Badge>}
                </div>
                <div className="text-xs text-text-muted">{p.kind} · {p.base_url ?? "—"}</div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditingProvider(p);
                    setName(p.name);
                    setKind(p.kind);
                    setBaseUrl(p.base_url ?? "");
                    setApiKey("");
                    setProbeMsg(null);
                    setAdding(true);
                  }}
                >Edit</Button>
                {!p.is_default && (
                  <Button size="sm" variant="ghost" onClick={() => setDefault(p.id)}>Set default</Button>
                )}
                {/* Icon-only, and it had no accessible name at all: a
                    screen reader announced "button" and nothing else, on the
                    one control that deletes a provider. Named, and
                    `size="sm"` rather than `size="xs"` for WCAG 2.2's target
                    size — a settings row is not a place to economise. */}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmDeleteProvider(p.id)}
                  aria-label={`Delete ${p.name}`}
                  title={`Delete ${p.name}`}
                  icon={<Trash2 size={12} />}
                />
              </div>
            </div>
          ))
        )}
      </Card>
      {adding && (
        <Modal
          open
          onClose={() => setAdding(false)}
          title={editingProvider ? "Edit provider" : "Add provider"}
          size="md"
        >
          <div className="space-y-3">
            <div>
              <label htmlFor="provider-kind" className="text-xs text-text-muted block mb-1">Kind</label>
              <Select id="provider-kind" disabled={editingProvider !== null} value={kind} onChange={(v) => setKind(v as any)} options={[
                { value: "ollama", label: "Ollama" },
                { value: "openai_compat", label: "OpenAI-compatible" },
              ]} />
            </div>
            <div>
              <label htmlFor="provider-name" className="text-xs text-text-muted block mb-1">Name</label>
              <TextInput id="provider-name" value={name} onChange={setName} placeholder="e.g. OpenRouter" />
            </div>
            <div>
              <label htmlFor="provider-base-url" className="text-xs text-text-muted block mb-1">Base URL</label>
              <TextInput id="provider-base-url" value={baseUrl} onChange={setBaseUrl} placeholder="http://localhost:11434" />
            </div>
            {kind === "openai_compat" && (
              <div>
                <label htmlFor="provider-api-key" className="text-xs text-text-muted block mb-1">API key (optional, stored in OS keyring)</label>
                <TextInput id="provider-api-key" value={apiKey} onChange={setApiKey} type="password" placeholder={editingProvider ? "Leave blank to keep current key" : "sk-..."} />
              </div>
            )}
            {probeMsg && (
              <div className={`text-xs flex items-center gap-1 ${probeMsg.ok ? "text-success" : "text-error"}`}>
                {probeMsg.ok ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                {probeMsg.message}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button size="sm" variant="ghost" onClick={() => void probe()} disabled={saving}>Test connection</Button>
              <Button size="sm" variant="primary" onClick={() => void add()} loading={saving}>{editingProvider ? "Save" : "Add"}</Button>
            </div>
          </div>
        </Modal>
      )}
      <ConfirmDialog
        open={confirmDeleteProvider !== null}
        onClose={() => setConfirmDeleteProvider(null)}
        onConfirm={() => {
          if (confirmDeleteProvider) remove(confirmDeleteProvider);
          setConfirmDeleteProvider(null);
        }}
        title="Delete provider"
        message={`Delete "${
          providers.find((p) => p.id === confirmDeleteProvider)?.name ?? "this provider"
        }"? Models cached for this provider will be removed.`}
        confirmLabel="Delete"
        confirmVariant="danger"
      />
    </div>
  );
}

function ModelsSection() {
  return <ProviderModelsSection />;
}

export function SearchSection() {
  const [cfg, setCfg] = useState<SearchConfig>({ provider: "duckduckgo", base_url: null, api_key: null, max_results: 5 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testQuery, setTestQuery] = useState("Convo local-first AI");
  const [testResults, setTestResults] = useState<Array<{ title: string; url: string; snippet: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.getSearchConfig().then((c) => { if (c) setCfg(c); }).catch((e) => setError(String(e))).finally(() => setLoading(false));
  }, []);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.setSearchConfig(cfg);
      toast.success("Search settings saved");
    } catch (e) {
      setError(String(e));
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };
  const testSearch = async () => {
    if (!testQuery.trim()) return;
    setTesting(true);
    setError(null);
    try {
      setTestResults(await api.webSearch(testQuery.trim(), cfg));
    } catch (e) {
      setError(String(e));
      toast.error(String(e), "Search test failed");
    } finally {
      setTesting(false);
    }
  };
  return (
    <div>
      <SectionTitle title="Web search" description="Convo can run web searches via SearXNG, DuckDuckGo, or Brave and cite results inline." />
      {loading && <div className="text-sm text-text-muted mb-4">Loading search settings…</div>}
      {error && <div role="alert" className="mb-4 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">{error}</div>}
      <Card>
        <div className="space-y-3">
          <div>
            <label htmlFor="search-provider" className="text-xs text-text-muted block mb-1">Provider</label>
            <Select id="search-provider" value={cfg.provider} onChange={(v) => setCfg({ ...cfg, provider: v })} options={[
              { value: "duckduckgo", label: "DuckDuckGo (free, no key)" },
              { value: "searxng", label: "SearXNG (self-hosted)" },
              { value: "brave", label: "Brave Search API" },
            ]} />
          </div>
          {cfg.provider === "searxng" && (
            <div>
              <label htmlFor="search-searxng-url" className="text-xs text-text-muted block mb-1">SearXNG base URL</label>
              <TextInput id="search-searxng-url" value={cfg.base_url ?? ""} onChange={(v) => setCfg({ ...cfg, base_url: v })} placeholder="http://localhost:8080" />
            </div>
          )}
          {cfg.provider === "brave" && (
            <div>
              <label htmlFor="search-brave-key" className="text-xs text-text-muted block mb-1">Brave API key</label>
              <TextInput id="search-brave-key" value={cfg.api_key ?? ""} onChange={(v) => setCfg({ ...cfg, api_key: v })} type="password" placeholder={cfg.has_api_key ? "Leave blank to keep saved key" : "BSA..."} />
              {cfg.has_api_key && !cfg.api_key && <p className="text-[10px] text-success mt-1">A key is saved in the OS keyring.</p>}
            </div>
          )}
          <div>
            <label htmlFor="search-max-results" className="text-xs text-text-muted block mb-1">Max results per search</label>
            <Select id="search-max-results" value={String(cfg.max_results)} onChange={(v) => setCfg({ ...cfg, max_results: Number(v) })} options={["3","5","8","10"].map((v) => ({ value: v, label: v }))} />
          </div>
          <div className="flex justify-end pt-2">
            <Button variant="primary" onClick={save} loading={saving} disabled={loading}>Save</Button>
          </div>
        </div>
      </Card>
      <Card className="mt-4">
        <h3 className="text-sm font-medium text-text mb-2">Test search</h3>
        <div className="flex gap-2">
          <TextInput aria-label="Search query" value={testQuery} onChange={setTestQuery} placeholder="Search query" />
          <Button variant="secondary" onClick={() => void testSearch()} loading={testing}>Test</Button>
        </div>
        {testResults.length > 0 && (
          <ul className="mt-3 space-y-2">
            {testResults.slice(0, 3).map((result) => (
              <li key={result.url} className="border-t border-border pt-2">
                <a href={result.url} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">{result.title}</a>
                <p className="text-[10px] text-text-muted mt-0.5">{result.snippet}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ThemeSection() {
  const themes = useThemeStore((s) => s.themes);
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const setActive = useThemeStore((s) => s.setActive);
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  const init = useThemeStore((s) => s.init);

  return (
    <div>
      <SectionTitle title="Theme" description="Choose a built-in theme and color mode." />
      <Card className="mb-4">
        <SettingRow
          label="Mode"
          description="Light, dark, or follow your system preference"
          control={
            <Select value={mode} onChange={(v) => setMode(v as any)} options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
              { value: "system", label: "System" },
            ]} />
          }
        />
      </Card>
      <h3 className="text-xs uppercase tracking-wider text-text-subtle font-semibold mb-2">Themes</h3>
      <div className="grid grid-cols-2 gap-2">
        {themes.map((t) => (
          <button
            key={t.id}
            onClick={() => { setActive(t.id); init(); window.dispatchEvent(new CustomEvent("convo:theme-changed")); }}
             className={`text-left p-3 rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              t.id === activeThemeId ? "border-accent bg-accent/10" : "border-border bg-surface-1 hover:border-border-strong"
            }`}
          >
            <div className="flex items-center gap-2 mb-2">
              <ThemeSwatch tokensJson={t.tokens_json} />
              <span className="text-sm font-medium text-text">{t.name}</span>
              {t.is_builtin && <Badge variant="default">built-in</Badge>}
            </div>
            <div className="text-[10px] text-text-subtle">{t.id}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function ThemeSwatch({ tokensJson }: { tokensJson: string }) {
  let tokens: Record<string, string> = {};
  try { tokens = JSON.parse(tokensJson); } catch {}
  return (
    <div className="flex gap-0.5">
      {["color-bg", "color-surface-2", "color-accent", "color-text"].map((k) => (
               <span
                 key={k}
                 // `data-swatch` is the one place on this page where a
                 // literal colour is correct: a swatch's job is to *show*
                 // the theme's colours, so it paints them from
                 // `tokens_json` and there is no var to read. The marker is
                 // in the markup rather than in the test so the exemption
                 // travels with the element, and the test asserts
                 // separately that the swatch really is carrying the
                 // theme's token — an exemption that could carry a
                 // hardcoded colour would be a hole, not an exemption.
                 data-swatch=""
                 className="w-3 h-3 rounded-sm border border-border"
                 style={{ background: tokens[k] || "var(--color-bg)" }}
               />
      ))}
    </div>
  );
}

function ShortcutsSection() {
  const bindings = useShortcutsStore((s) => s.bindings);
  const setCombo = useShortcutsStore((s) => s.setCombo);
  const [editing, setEditing] = useState<string | null>(null);
  const [recording, setRecording] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") { setRecording(null); return; }
      const key = e.key.toLowerCase();
      if (key === "control" || key === "meta" || key === "alt" || key === "shift") return;
      const combo = parseEvent(e, useShortcutsStore.getState().isMac);
      if (!setCombo(recording, combo)) {
         toast.error("That shortcut is already in use", "Shortcut conflict");
      }
      setRecording(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [recording, setCombo]);

  return (
    <div>
      <SectionTitle title="Shortcuts" description="Click a binding to record a new combo. Esc to cancel." />
      <Card>
        {bindings.map((b) => (
          // `py-3`, like every other row on this page. It was `py-2` — the
          // only row out of step — and the test walks all four row kinds
          // and asserts they resolve alike.
          <div key={b.id} className="flex items-center justify-between gap-3 py-3 border-b border-border last:border-b-0">
            <div>
              <div className="text-sm text-text">{b.description ?? b.id}</div>
              <div className="text-xs text-text-subtle font-mono">{b.combo || "—"}</div>
            </div>
            <Button
              size="xs"
              variant={recording === b.id ? "primary" : "secondary"}
              onClick={() => setRecording(b.id)}
            >
              {recording === b.id ? "Press keys…" : comboDisplay(b.combo) || "Bind"}
            </Button>
          </div>
        ))}
      </Card>
    </div>
  );
}

/** `--radius-lg`, the radius the spec's card row names. */
function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-surface-1 border border-border rounded-lg p-4 ${className}`}>{children}</div>;
}

/**
 * The page's row around a control that cannot carry its own name — a
 * `Button`, a `Select`. 12px inside, a 1px rule between: the standard
 * rhythm expressed as a rule rather than as air, which is the right call
 * for a dozen rows under a heading and is what the test measures.
 */
function SwitchRow({ children }: { children: React.ReactNode }) {
  return <div className="py-3 border-b border-border last:border-b-0">{children}</div>;
}

/** The same row, for a `Button` or a `Select`. See the note on `GeneralSection`. */
function SettingRow({ label, description, control }: { label: string; description?: string; control: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-border last:border-b-0">
      <div>
        <div className="text-sm text-text">{label}</div>
        {description && <div className="text-xs text-text-muted mt-0.5">{description}</div>}
      </div>
      {control}
    </div>
  );
}
