import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useThemeStore } from "../stores/theme";
import { useSettingsStore } from "../stores/settings";
import { useShortcutsStore, comboDisplay } from "../stores/shortcuts";
import { api, Provider, SearchConfig } from "../lib/api";
import { ModelsSection as ProviderModelsSection } from "./settings/ModelsSection";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Switch, Tabs, TextInput, TextArea, Select, Badge } from "../components/ui/Form";
import { Dropdown } from "../components/ui/Dropdown";
import { toast } from "../stores/toasts";
import { Cpu, Palette, KeyRound, Search, Keyboard, Info, Plus, Trash2, CheckCircle2, AlertCircle, X, Save } from "lucide-react";

export function SettingsRoute() {
  const location = useLocation();
  const path = location.pathname.replace(/^\/settings\/?/, "");
  const [section, setSection] = useState<string>(path || "general");

  useEffect(() => {
    setSection(path || "general");
  }, [path]);

  return (
    <div className="flex-1 flex h-full">
      <aside className="w-48 sm:w-56 bg-surface-1 border-r border-border p-2 shrink-0">
        <h2 className="text-sm font-semibold text-text px-2 py-2">Settings</h2>
        <nav className="flex flex-col gap-0.5">
          <SettingsLink to="/settings/general" icon={<Info size={14} />} label="General" active={section === "general"} />
          <SettingsLink to="/settings/providers" icon={<KeyRound size={14} />} label="Providers" active={section === "providers"} />
          <SettingsLink to="/settings/models" icon={<Cpu size={14} />} label="Models" active={section === "models"} />
          <SettingsLink to="/settings/search" icon={<Search size={14} />} label="Web search" active={section === "search"} />
          <SettingsLink to="/settings/theme" icon={<Palette size={14} />} label="Theme" active={section === "theme"} />
          <SettingsLink to="/settings/shortcuts" icon={<Keyboard size={14} />} label="Shortcuts" active={section === "shortcuts"} />
        </nav>
      </aside>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-4 sm:p-8">
          {section === "general" && <GeneralSection />}
          {section === "providers" && <ProvidersSection />}
          {section === "models" && <ModelsSection />}
          {section === "search" && <SearchSection />}
          {section === "theme" && <ThemeSection />}
          {section === "shortcuts" && <ShortcutsSection />}
        </div>
      </div>
    </div>
  );
}

function SettingsLink({ to, icon, label, active }: { to: string; icon: React.ReactNode; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors ${
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
        <h1 className="text-xl font-semibold text-text">{title}</h1>
        {description && <p className="text-sm text-text-muted mt-1">{description}</p>}
      </div>
      {action}
    </div>
  );
}

function GeneralSection() {
  const settings = useSettingsStore();
  return (
    <div>
      <SectionTitle title="General" description="App-wide preferences." />
      <Card>
        <SettingRow
          label="Sound effects"
          description="Subtle sounds for send and response complete"
          control={<Switch checked={!settings.muteSounds} onChange={(v) => settings.update("muteSounds", !v)} />}
        />
        <SettingRow
          label="Desktop notifications"
          description="Notify when a response completes while the window is unfocused"
          control={<Switch checked={!settings.muteNotifications} onChange={(v) => settings.update("muteNotifications", !v)} />}
        />
        <SettingRow
          label="Enter to send"
          description="Send messages with Enter; Shift+Enter for new line"
          control={<Switch checked={settings.enterToSend} onChange={(v) => settings.update("enterToSend", v)} />}
        />
        <SettingRow
          label="Show token count"
          description="Display token usage in the input bar"
          control={<Switch checked={settings.showTokenCount} onChange={(v) => settings.update("showTokenCount", v)} />}
        />
        <SettingRow
          label="Show thinking by default"
          description="Expand model thinking cards automatically"
          control={<Switch checked={settings.showThinking} onChange={(v) => settings.update("showThinking", v)} />}
        />
        <SettingRow
          label="Auto-extract memory from chat"
          description="After each chat with ≥ 2 exchanges, ask the model to propose durable facts (preferences, project facts, skills) for review on the Memory page."
          control={
            <Switch
              checked={settings.memoryAutoEvaluate}
              onChange={(v) => settings.update("memoryAutoEvaluate", v)}
            />
          }
        />
      </Card>
    </div>
  );
}

function ProvidersSection() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"ollama" | "openai_compat">("ollama");
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434");
  const [apiKey, setApiKey] = useState("");
  const [probeMsg, setProbeMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [discovered, setDiscovered] = useState<Array<{ base_url: string; models: Array<{ name: string }> }>>([]);
  const [scanning, setScanning] = useState(false);
  const [confirmDeleteProvider, setConfirmDeleteProvider] = useState<string | null>(null);

  const refresh = async () => setProviders(await api.listProviders());
  useEffect(() => { refresh(); }, []);

  const probe = async () => {
    try {
      const r = await api.probeProvider(kind, baseUrl, apiKey || undefined);
      setProbeMsg({ ok: r.ok, message: r.ok ? `Found ${r.models.length} models` : r.message });
    } catch (e) {
      setProbeMsg({ ok: false, message: String(e) });
    }
  };

  const add = async () => {
    try {
      await api.addProvider(kind, name || `${kind} (${baseUrl})`, baseUrl, apiKey || null);
      setAdding(false);
      setName(""); setApiKey(""); setProbeMsg(null);
      await refresh();
      toast.success("Provider added");
    } catch (e) { toast.error(String(e)); }
  };

  const remove = async (id: string) => {
    await api.deleteProvider(id);
    await refresh();
    toast.success("Provider deleted");
  };

  const setDefault = async (id: string) => {
    await api.updateProvider(id, null, null, null, true);
    await refresh();
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
        <Button variant="primary" onClick={() => setAdding(true)} icon={<Plus size={12} />}>Add provider</Button>
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
        {providers.length === 0 ? (
          <div className="text-center text-text-muted text-sm py-6">No providers yet. Add one to start chatting.</div>
        ) : (
          providers.map((p) => (
            <div key={p.id} className="flex items-center justify-between py-3 border-b border-border last:border-b-0">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text">{p.name}</span>
                  {p.is_default && <Badge variant="accent">default</Badge>}
                  {p.has_api_key && <Badge variant="success">api key</Badge>}
                </div>
                <div className="text-xs text-text-muted">{p.kind} · {p.base_url ?? "—"}</div>
              </div>
              <div className="flex items-center gap-1">
                {!p.is_default && (
                  <Button size="xs" variant="ghost" onClick={() => setDefault(p.id)}>Set default</Button>
                )}
                <Button size="xs" variant="ghost" onClick={() => setConfirmDeleteProvider(p.id)} icon={<Trash2 size={12} />} />
              </div>
            </div>
          ))
        )}
      </Card>
      {adding && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-fade-in" onClick={() => setAdding(false)}>
          <div className="bg-surface-1 border border-border rounded-2xl shadow-modal w-full max-w-md p-5 animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-text">Add provider</h3>
              <button onClick={() => setAdding(false)} className="text-text-subtle hover:text-text"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-text-muted block mb-1">Kind</label>
                <Select value={kind} onChange={(v) => setKind(v as any)} options={[
                  { value: "ollama", label: "Ollama" },
                  { value: "openai_compat", label: "OpenAI-compatible" },
                ]} />
              </div>
              <div>
                <label className="text-xs text-text-muted block mb-1">Name</label>
                <TextInput value={name} onChange={setName} placeholder="e.g. OpenRouter" />
              </div>
              <div>
                <label className="text-xs text-text-muted block mb-1">Base URL</label>
                <TextInput value={baseUrl} onChange={setBaseUrl} placeholder="http://localhost:11434" />
              </div>
              {kind === "openai_compat" && (
                <div>
                  <label className="text-xs text-text-muted block mb-1">API key (optional, stored in OS keyring)</label>
                  <TextInput value={apiKey} onChange={setApiKey} type="password" placeholder="sk-..." />
                </div>
              )}
              {probeMsg && (
                <div className={`text-xs flex items-center gap-1 ${probeMsg.ok ? "text-success" : "text-error"}`}>
                  {probeMsg.ok ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                  {probeMsg.message}
                </div>
              )}
              <div className="flex items-center justify-end gap-2 pt-2">
                <Button size="sm" variant="ghost" onClick={probe}>Test connection</Button>
                <Button size="sm" variant="primary" onClick={add}>Add</Button>
              </div>
            </div>
          </div>
        </div>
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

function SearchSection() {
  const [cfg, setCfg] = useState<SearchConfig>({ provider: "duckduckgo", base_url: null, api_key: null, max_results: 5 });
  useEffect(() => {
    api.getSearchConfig().then((c) => { if (c) setCfg(c); });
  }, []);
  const save = async () => {
    await api.setSearchConfig(cfg);
    toast.success("Saved");
  };
  return (
    <div>
      <SectionTitle title="Web search" description="Convo can run web searches via SearXNG, DuckDuckGo, or Brave and cite results inline." />
      <Card>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-text-muted block mb-1">Provider</label>
            <Select value={cfg.provider} onChange={(v) => setCfg({ ...cfg, provider: v })} options={[
              { value: "duckduckgo", label: "DuckDuckGo (free, no key)" },
              { value: "searxng", label: "SearXNG (self-hosted)" },
              { value: "brave", label: "Brave Search API" },
            ]} />
          </div>
          {cfg.provider === "searxng" && (
            <div>
              <label className="text-xs text-text-muted block mb-1">SearXNG base URL</label>
              <TextInput value={cfg.base_url ?? ""} onChange={(v) => setCfg({ ...cfg, base_url: v })} placeholder="http://localhost:8080" />
            </div>
          )}
          {cfg.provider === "brave" && (
            <div>
              <label className="text-xs text-text-muted block mb-1">Brave API key</label>
              <TextInput value={cfg.api_key ?? ""} onChange={(v) => setCfg({ ...cfg, api_key: v })} type="password" />
            </div>
          )}
          <div>
            <label className="text-xs text-text-muted block mb-1">Max results per search</label>
            <Select value={String(cfg.max_results)} onChange={(v) => setCfg({ ...cfg, max_results: Number(v) })} options={["3","5","8","10"].map((v) => ({ value: v, label: v }))} />
          </div>
          <div className="flex justify-end pt-2">
            <Button variant="primary" onClick={save}>Save</Button>
          </div>
        </div>
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
      <SectionTitle title="Theme" description="Switch between built-in themes or create your own." />
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
            className={`text-left p-3 rounded-xl border transition-all ${
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
        <span key={k} className="w-3 h-3 rounded-sm border border-border" style={{ background: tokens[k] || "#000" }} />
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
      if (e.key === "Escape") { setRecording(null); return; }
      const isMac = useShortcutsStore.getState().isMac;
      const parts: string[] = [];
      const ctrlKey = isMac ? e.metaKey : e.ctrlKey;
      if (ctrlKey) parts.push("ctrl");
      if (e.altKey) parts.push("alt");
      if (e.shiftKey) parts.push("shift");
      let key = e.key.toLowerCase();
      if (key === " ") key = "space";
      if (key === "escape") key = "escape";
      if (key === "arrowup") key = "up";
      if (key === "arrowdown") key = "down";
      if (key === "arrowleft") key = "left";
      if (key === "arrowright") key = "right";
      if (key === "control" || key === "meta" || key === "alt" || key === "shift") return;
      parts.push(key);
      setCombo(recording, parts.join("+"));
      setRecording(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [recording, setCombo]);

  return (
    <div>
      <SectionTitle title="Shortcuts" description="Click a binding to record a new combo. Esc to cancel." />
      <Card>
        {bindings.map((b) => (
          <div key={b.id} className="flex items-center justify-between py-2 border-b border-border last:border-b-0">
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

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-surface-1 border border-border rounded-xl p-4 ${className}`}>{children}</div>;
}

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
