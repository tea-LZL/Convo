import { useEffect, useMemo, useRef, useState } from "react";

import { api, Provider } from "../../lib/api";
import { errorClass, recordLog } from "../../lib/logger";
import { Select, Switch, TextInput } from "../../components/ui/Form";

// Every key below is read by a function in src-tauri/src/memory/config.rs,
// and each of those functions is called from the live memory path. The
// fallbacks are transcribed from the readers, not chosen here: a control
// showing something the backend ignores is a setting that looks configured
// and is not, which is the defect this section exists to stop repeating.
const TOP_K_KEY = "memory.top_k";
const BUDGET_KEY = "memory.context_budget_fraction";
const AUTO_EXTRACT_KEY = "memory.auto_extract";
const ROUTING_KEY = "memory.routing";

// `memory.embed_all_notes` is deliberately absent. `config::embed_all_notes`
// exists but nothing calls it, and the argument that would carry it
// (`memory_index_fill`) is itself uncalled, so a switch here would write a
// row no code path consults. `EXTRACT_EVERY_N_EXCHANGES` has no reader at
// all: the trigger is a hardcoded `gen >= 2` in src/stores/chatStream.ts.

/** config::TOP_K_DEFAULT */
const TOP_K_DEFAULT = 6;
/** config::CONTEXT_BUDGET_FRACTION */
const BUDGET_DEFAULT = 0.15;

const ROUTE = "/settings/knowledge";

/** The three capabilities `load_routing` reads, in the order it reads them. */
const CAPABILITIES = ["chat", "extraction", "embedding"] as const;
type Capability = (typeof CAPABILITIES)[number];

const CAPABILITY_LABELS: Record<Capability, string> = {
  chat: "Chat",
  extraction: "Extraction",
  embedding: "Embedding",
};

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Effective `memory.top_k`. `config::top_k` parses an i64 and rejects
 * anything below 1, so a decimal, a negative, and a word all fall back to 6.
 */
export function effectiveTopK(raw: string | null): number {
  const trimmed = (raw ?? "").trim();
  if (!INTEGER.test(trimmed)) return TOP_K_DEFAULT;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : TOP_K_DEFAULT;
}

/** True when `raw` is a value the Rust reader would actually store. */
function acceptsTopK(raw: string): boolean {
  return INTEGER.test(raw) && effectiveTopK(raw) === Number.parseInt(raw, 10);
}

/**
 * Effective `memory.context_budget_fraction`. The reader falls back rather
 * than clamping, because `2.0` is a dropped decimal point rather than a
 * request for the whole window. `0` falls back too: it would inject no
 * memory at all and look like a broken feature.
 */
export function effectiveBudgetFraction(raw: string | null): number {
  const trimmed = (raw ?? "").trim();
  if (!DECIMAL.test(trimmed)) return BUDGET_DEFAULT;
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return BUDGET_DEFAULT;
  return parsed > 0 && parsed <= 1 ? parsed : BUDGET_DEFAULT;
}

function acceptsBudget(raw: string): boolean {
  return DECIMAL.test(raw) && effectiveBudgetFraction(raw) === Number.parseFloat(raw);
}

/**
 * Effective `memory.auto_extract`. Unset means on, and so does anything the
 * reader does not recognise: only the literal string `false` stops a user
 * accumulating memory. A checkbox defaulting to unchecked would invert this.
 */
export function effectiveAutoExtract(raw: string | null): boolean {
  if (raw === null) return true;
  return raw.trim().toLowerCase() !== "false";
}

/** The raw `memory.routing` row, untyped, exactly as `load_routing` wants it. */
export type RoutingRow = Record<string, unknown>;

/**
 * Parse the row without discarding capabilities the user did configure.
 * `load_routing` deserialises into a map, so a non-object is dropped whole;
 * one bad field costs only its own capability, and this mirrors that.
 */
export function parseRoutingRow(raw: string | null): RoutingRow {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as RoutingRow;
}

export interface ModelRouteView {
  providerId: string;
  model: string;
}

/**
 * One capability out of a row. A missing field, a non-string field, or a
 * blank provider or model is "not configured": completing a half-typed row
 * would send a request to a model that does not exist.
 */
export function readRoute(row: RoutingRow, capability: string): ModelRouteView | null {
  const value = row[capability];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { provider_id: providerId, model } = value as { provider_id?: unknown; model?: unknown };
  if (typeof providerId !== "string" || typeof model !== "string") return null;
  const route = { providerId: providerId.trim(), model: model.trim() };
  return route.providerId !== "" && route.model !== "" ? route : null;
}

interface Draft {
  providerId: string;
  model: string;
}

const emptyDrafts = (): Record<Capability, Draft> => ({
  chat: { providerId: "", model: "" },
  extraction: { providerId: "", model: "" },
  embedding: { providerId: "", model: "" },
});

export function KnowledgeSection() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [topK, setTopK] = useState(String(TOP_K_DEFAULT));
  const [budget, setBudget] = useState(String(BUDGET_DEFAULT));
  const [autoExtract, setAutoExtract] = useState(true);
  const [drafts, setDrafts] = useState<Record<Capability, Draft>>(emptyDrafts);
  const [topKError, setTopKError] = useState<string | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  // Keyed by operation, so the retry the user just performed clears its own
  // message instead of leaving a stale one claiming something is still wrong.
  const [problems, setProblems] = useState<Array<{ id: string; message: string }>>([]);
  // The controls stay hidden until the read lands. Rendering the fallbacks
  // first and replacing them a tick later shows the user values that are not
  // theirs, and makes "which value is real" unanswerable.
  const [loaded, setLoaded] = useState(false);

  // A write rewrites the row, so it reads the row from a ref rather than
  // from one render's snapshot: two edits in a tick must not both start
  // from the value the first one was about to replace.
  const rowRef = useRef<RoutingRow>({});
  // What the controls were seeded with. A commit of the value already shown
  // is a no-op, so a blur without an edit writes nothing — and a key that
  // failed to read is never written back.
  const seededRef = useRef<Record<string, string>>({});

  const fail = (id: string, operation: string, error: unknown) => {
    recordLog({ operation, status: "failed", route: ROUTE, errorClass: errorClass(error) });
    const message = String(error);
    setProblems((current) => [...current.filter((problem) => problem.id !== id), { id, message }]);
  };

  const write = async (key: string, value: string, operation: string, revert?: () => void) => {
    if (seededRef.current[key] === value) return;
    const id = `set:${key}`;
    try {
      await api.setSetting(key, value);
      seededRef.current[key] = value;
      setProblems((current) => current.filter((problem) => problem.id !== id));
    } catch (e) {
      fail(id, operation, e);
      // A control still showing a value the store rejected is a lie about
      // what is configured. Put the last value the store agreed on back.
      revert?.();
    }
  };

  useEffect(() => {
    let active = true;
    const read = async (key: string): Promise<string | null> => {
      try {
        return await api.getSetting(key);
      } catch (e) {
        if (active) fail(`get:${key}`, `get_setting_${key.replace(".", "_")}`, e);
        return null;
      }
    };
    // One read per key, each degrading to the fallback its Rust reader
    // documents. Nothing is written back here. A key that fails to read has
    // not been unset by anyone, and re-saving the fallback would overwrite a
    // value the backend still honours.
    void Promise.all([read(TOP_K_KEY), read(BUDGET_KEY), read(AUTO_EXTRACT_KEY), read(ROUTING_KEY)])
      .then(([topKRaw, budgetRaw, autoExtractRaw, routingRaw]) => {
        if (!active) return;
        const topKValue = String(effectiveTopK(topKRaw));
        const budgetValue = String(effectiveBudgetFraction(budgetRaw));
        const autoExtractValue = String(effectiveAutoExtract(autoExtractRaw));
        seededRef.current = {
          [TOP_K_KEY]: topKValue,
          [BUDGET_KEY]: budgetValue,
          [AUTO_EXTRACT_KEY]: autoExtractValue,
          [ROUTING_KEY]: routingRaw ?? "",
        };
        setTopK(topKValue);
        setBudget(budgetValue);
        setAutoExtract(autoExtractValue === "true");
        const row = parseRoutingRow(routingRaw);
        rowRef.current = row;
        const parsed = emptyDrafts();
        for (const capability of CAPABILITIES) {
          parsed[capability] = readRoute(row, capability) ?? { providerId: "", model: "" };
        }
        setDrafts(parsed);
        setLoaded(true);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    api.listProviders()
      .then((items) => { if (active) setProviders(items); })
      .catch((e) => { if (active) fail("get:providers", "list_providers", e); });
    return () => { active = false; };
  }, []);

  const commitTopK = () => {
    if (!acceptsTopK(topK.trim())) {
      setTopKError(`Recall needs a whole number of at least 1. Convo is using ${TOP_K_DEFAULT}.`);
      return;
    }
    setTopKError(null);
    void write(TOP_K_KEY, topK.trim(), "set_memory_top_k", () => setTopK(String(TOP_K_DEFAULT)));
  };

  const commitBudget = () => {
    if (!acceptsBudget(budget.trim())) {
      setBudgetError(`Must be a fraction between 0 and 1. Convo is using ${BUDGET_DEFAULT}.`);
      return;
    }
    setBudgetError(null);
    void write(BUDGET_KEY, budget.trim(), "set_memory_budget", () => setBudget(String(BUDGET_DEFAULT)));
  };

  const toggleAutoExtract = (next: boolean) => {
    const previous = autoExtract;
    setAutoExtract(next);
    void write(AUTO_EXTRACT_KEY, String(next), "set_memory_auto_extract", () => setAutoExtract(previous));
  };

  const setCapability = (capability: Capability, draft: Draft) => {
    setDrafts((current) => ({ ...current, [capability]: draft }));
    const model = draft.model.trim();
    if (draft.providerId === "") {
      // The provider select is the explicit way to hand a job back to the
      // session model. Nothing to do when it was already unconfigured.
      if (model !== "" || !(capability in rowRef.current)) return;
      const row = { ...rowRef.current };
      delete row[capability];
      rowRef.current = row;
      void write(ROUTING_KEY, JSON.stringify(row), "set_memory_routing");
      return;
    }
    // A provider with no model is a half-typed route the backend reads as
    // unset, so it is held here until the pair is complete rather than
    // written as a row that does nothing.
    if (model === "") return;
    const row = { ...rowRef.current, [capability]: { provider_id: draft.providerId, model } };
    rowRef.current = row;
    void write(ROUTING_KEY, JSON.stringify(row), "set_memory_routing");
  };

  const providerOptions = useMemo(() => {
    // A route naming a provider this app no longer lists is still the stored
    // truth. Leaving it out would show one route and, on the next edit,
    // write a different provider.
    const orphans = new Set<string>();
    for (const capability of CAPABILITIES) {
      const { providerId } = drafts[capability];
      if (providerId !== "" && !providers.some((provider) => provider.id === providerId)) orphans.add(providerId);
    }
    return [
      { value: "", label: "Session model" },
      ...providers.map((provider) => ({ value: provider.id, label: provider.name })),
      ...[...orphans].map((id) => ({ value: id, label: id })),
    ];
  }, [providers, drafts]);

  return (
    <div>
      <SectionTitle
        title="Knowledge"
        description="How Convo recalls, stores, and refreshes what it knows about you."
      />
      {problems.length > 0 && (
        <div role="alert" className="mb-4 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
          {problems.map((problem) => <p key={problem.id}>{problem.message}</p>)}
        </div>
      )}
      {!loaded ? (
        <p className="text-sm text-text-muted">Loading knowledge settings…</p>
      ) : (
        <>
          <Card>
            {/* `h3` under this section's `h2`, not a second `h2` beside
                it: a screen-reader user moving by level was told "Recall"
                and "Model routing" were siblings of "Knowledge" rather than
                its children. A `div` would also have been defensible, but
                these are headings and a heading level is cheap to keep. */}
            <h3 className="text-sm font-medium text-text">Recall</h3>
            <Row
              id="memory-top-k"
              label="Recall items"
              hint={`How many memories reach the prompt at once. Convo uses ${TOP_K_DEFAULT} unless this says otherwise.`}
              error={topKError}
            >
              <TextInput
                id="memory-top-k"
                type="number"
                className="w-24"
                value={topK}
                onChange={(value) => { setTopK(value); setTopKError(null); }}
                onBlur={commitTopK}
                onKeyDown={(event) => { if (event.key === "Enter") commitTopK(); }}
              />
            </Row>
            <Row
              id="memory-budget-fraction"
              label="Context budget fraction"
              hint="Share of the model's context window the memory block may take. Zero would inject no memory at all, so Convo falls back to 0.15 rather than honouring it."
              error={budgetError}
            >
              <TextInput
                id="memory-budget-fraction"
                type="number"
                className="w-24"
                value={budget}
                onChange={(value) => { setBudget(value); setBudgetError(null); }}
                onBlur={commitBudget}
                onKeyDown={(event) => { if (event.key === "Enter") commitBudget(); }}
              />
            </Row>
            <div className="py-3 border-t border-border">
              <Switch
                label="Extract memories automatically"
                description="After each chat with at least two exchanges, ask the model to propose durable facts. Only the literal value false turns this off, so an unset or unrecognised value leaves it on."
                checked={autoExtract}
                onChange={toggleAutoExtract}
              />
            </div>
          </Card>

          <Card className="mt-4">
            <h3 className="text-sm font-medium text-text">Model routing</h3>
            <p className="text-xs text-text-muted mt-0.5 mb-1">
              Which model serves which job. Session model means whichever model the chat is using.
            </p>
            {CAPABILITIES.map((capability) => {
              const draft = drafts[capability];
              return (
                <div key={capability} className="py-3 border-t border-border">
                  <label htmlFor={`routing-${capability}-provider`} className="block text-sm text-text mb-1.5">
                    {CAPABILITY_LABELS[capability]}
                  </label>
              <div className="flex items-center gap-2 flex-wrap">
                <Select
                  id={`routing-${capability}-provider`}
                  aria-label={`${CAPABILITY_LABELS[capability]} model provider`}
                  value={draft.providerId}
                  options={providerOptions}
                  onChange={(value) => setCapability(capability, { providerId: value, model: "" })}
                />
                <TextInput
                  aria-label={`${CAPABILITY_LABELS[capability]} model name`}
                  className="w-40"
                  placeholder="Model name"
                  disabled={draft.providerId === ""}
                  value={draft.model}
                  onChange={(value) => setCapability(capability, { ...draft, model: value })}
                />
              </div>
              {draft.providerId !== "" && draft.model.trim() === "" && (
                <p className="text-xs text-text-subtle mt-1">
                  Convo keeps the stored route until a model name is entered.
                </p>
              )}
                </div>
              );
            })}
            <p className="text-xs text-text-subtle border-t border-border pt-3">
              A route naming no model counts as unconfigured, and a route whose provider Convo no longer lists is kept rather than dropped.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * `--radius-lg`, the radius the spec's card row names — and the same
 * definition `SettingsRoute.tsx` has for its own `Card`, duplicated
 * because the two sections are reviewable apart and a shared module would
 * be a new file. Recorded rather than done.
 */
function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-surface-1 border border-border rounded-lg p-4 ${className}`}>{children}</div>;
}

function SectionTitle({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-xl font-semibold text-text">{title}</h2>
      {description && <p className="text-sm text-text-muted mt-1">{description}</p>}
    </div>
  );
}

function Row({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string | null; children: React.ReactNode }) {
  return (
    <div className="py-3 border-t border-border">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor={id} className="block text-sm text-text">{label}</label>
          {hint && <p className="text-xs text-text-muted mt-0.5">{hint}</p>}
        </div>
        {children}
      </div>
      {error && <p className="text-xs text-warn mt-1">{error}</p>}
    </div>
  );
}
