import { useEffect, useMemo, useRef, useState } from "react";

import { api, KnowledgeIndexStatus, Provider } from "../../lib/api";
import { errorClass, recordLog } from "../../lib/logger";
import { Button } from "../../components/ui/Button";
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
const EMBED_NOTES_KEY = "memory.embed_all_notes";
const RECENCY_KEY = "memory.recency_half_life_days";
const EXTRACT_EVERY_KEY = "memory.extract_every_n_exchanges";
const RECALL_KINDS_KEY = "memory.recall_kinds";

// `memory.embed_all_notes` is now wired: the Build-index action below passes
// its value as `memory_index_fill`'s `embedNotes` argument, and
// `config::embed_all_notes` reads the same row. `memory.extract_every_n_exchanges`
// is read by `config::extract_every_n_exchanges`, which the auto-extraction
// path passes to `should_extract`; `memory.recency_half_life_days` is read by
// `config::recency_half_life_days` and used by `boost` on every recall.

/** config::TOP_K_DEFAULT */
const TOP_K_DEFAULT = 6;
/** config::CONTEXT_BUDGET_FRACTION */
const BUDGET_DEFAULT = 0.15;
/** config::RECENCY_HALF_LIFE_DAYS */
const RECENCY_DEFAULT = 30;
/** config::EXTRACT_EVERY_N_EXCHANGES */
const EXTRACT_EVERY_DEFAULT = 1;

/**
 * `extract::KINDS`, with the names the Memory tab already uses. The list is
 * duplicated here because the alternative is a Tauri command that exists
 * only to return six short strings; the fallback tests and the reader's own
 * filter are what keep the two lists agreeing.
 */
const RECALL_KINDS = [
  { id: "user_pref", label: "Preferences" },
  { id: "project_fact", label: "Project facts" },
  { id: "decision", label: "Decisions" },
  { id: "constraint", label: "Constraints" },
  { id: "skill", label: "Skills" },
  { id: "entity", label: "Entities" },
] as const;

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

/**
 * Effective `memory.embed_all_notes`. `config::embed_all_notes` reads only
 * the literal `true`, and so does this: anything else is off, which is the
 * default because a long-form note library is expensive to embed.
 */
export function effectiveEmbedNotes(raw: string | null): boolean {
  return (raw ?? "").trim().toLowerCase() === "true";
}

/**
 * Effective `memory.recency_half_life_days`.
 *
 * The reader falls back rather than clamping, and so does this: zero,
 * negative, non-finite, or unparseable would make the decay curve
 * meaningless. A very large value is honoured — it means "stop discounting
 * old items", which is a preference rather than a typo.
 */
export function effectiveRecencyHalfLife(raw: string | null): number {
  const trimmed = (raw ?? "").trim();
  if (!DECIMAL.test(trimmed)) return RECENCY_DEFAULT;
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return RECENCY_DEFAULT;
  return parsed;
}

function acceptsRecency(raw: string): boolean {
  return DECIMAL.test(raw) && effectiveRecencyHalfLife(raw) === Number.parseFloat(raw);
}

/**
 * Effective `memory.extract_every_n_exchanges`. `config::extract_every_n_exchanges`
 * rejects anything below 1, because `0` would mean "never extract" and the
 * user has an explicit switch for that.
 */
export function effectiveExtractEvery(raw: string | null): number {
  const trimmed = (raw ?? "").trim();
  if (!INTEGER.test(trimmed)) return EXTRACT_EVERY_DEFAULT;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : EXTRACT_EVERY_DEFAULT;
}

function acceptsExtractEvery(raw: string): boolean {
  return INTEGER.test(raw) && effectiveExtractEvery(raw) === Number.parseInt(raw, 10);
}

/**
 * Effective `memory.recall_kinds`: the kinds `config::recall_kinds` would
 * admit.
 *
 * Every kind on an absent row, on an empty array, on a non-array, and when
 * no recognised kind survives — the reader's contract, because an empty
 * scope honoured literally would silently disable recall.
 */
export function effectiveRecallKinds(raw: string | null): string[] {
  const all = RECALL_KINDS.map((kind) => kind.id);
  if (!raw) return all;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return all;
  }
  if (!Array.isArray(parsed)) return all;
  const known = all.filter((id) => parsed.includes(id));
  return known.length > 0 ? known : all;
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
  const [recency, setRecency] = useState(String(RECENCY_DEFAULT));
  const [extractEvery, setExtractEvery] = useState(String(EXTRACT_EVERY_DEFAULT));
  const [recallKinds, setRecallKinds] = useState<string[]>(RECALL_KINDS.map((kind) => kind.id));
  const [recallKindsError, setRecallKindsError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<Capability, Draft>>(emptyDrafts);
  const [topKError, setTopKError] = useState<string | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [recencyError, setRecencyError] = useState<string | null>(null);
  const [extractEveryError, setExtractEveryError] = useState<string | null>(null);
  // Keyed by operation, so the retry the user just performed clears its own
  // message instead of leaving a stale one claiming something is still wrong.
  const [problems, setProblems] = useState<Array<{ id: string; message: string }>>([]);
  // The controls stay hidden until the read lands. Rendering the fallbacks
  // first and replacing them a tick later shows the user values that are not
  // theirs, and makes "which value is real" unanswerable.
  const [loaded, setLoaded] = useState(false);
  // The semantic index. `indexStatus` is Rust's own view (how many rows wait,
  // whether the model is configured); `indexMessage` is the result of the
  // last Build-index run. Both are read here and nowhere else on the page.
  const [embedNotes, setEmbedNotes] = useState(false);
  const [indexStatus, setIndexStatus] = useState<KnowledgeIndexStatus | null>(null);
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexMessage, setIndexMessage] = useState<string | null>(null);

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
    void Promise.all([
      read(TOP_K_KEY),
      read(BUDGET_KEY),
      read(AUTO_EXTRACT_KEY),
      read(ROUTING_KEY),
      read(EMBED_NOTES_KEY),
      read(RECENCY_KEY),
      read(EXTRACT_EVERY_KEY),
      read(RECALL_KINDS_KEY),
    ])
      .then(([topKRaw, budgetRaw, autoExtractRaw, routingRaw, embedNotesRaw, recencyRaw, extractEveryRaw, recallKindsRaw]) => {
        if (!active) return;
        const topKValue = String(effectiveTopK(topKRaw));
        const budgetValue = String(effectiveBudgetFraction(budgetRaw));
        const autoExtractValue = String(effectiveAutoExtract(autoExtractRaw));
        const recencyValue = String(effectiveRecencyHalfLife(recencyRaw));
        const extractEveryValue = String(effectiveExtractEvery(extractEveryRaw));
        const recallKindsValue = effectiveRecallKinds(recallKindsRaw);
        seededRef.current = {
          [TOP_K_KEY]: topKValue,
          [BUDGET_KEY]: budgetValue,
          [AUTO_EXTRACT_KEY]: autoExtractValue,
          [ROUTING_KEY]: routingRaw ?? "",
          [EMBED_NOTES_KEY]: String(effectiveEmbedNotes(embedNotesRaw)),
          [RECENCY_KEY]: recencyValue,
          [EXTRACT_EVERY_KEY]: extractEveryValue,
          [RECALL_KINDS_KEY]: JSON.stringify(recallKindsValue),
        };
        setTopK(topKValue);
        setBudget(budgetValue);
        setAutoExtract(autoExtractValue === "true");
        setEmbedNotes(effectiveEmbedNotes(embedNotesRaw));
        setRecency(recencyValue);
        setExtractEvery(extractEveryValue);
        setRecallKinds(recallKindsValue);
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

  useEffect(() => {
    let active = true;
    // `await` inside the try, not a `.then`: the Tauri boundary is untyped at
    // runtime, and a caller that resolves with something that is not a
    // promise must not take the section down. `StatusCard` uses the same
    // shape against the same command for the same reason.
    void (async () => {
      try {
        const next = await api.knowledgeIndexStatus();
        if (active) setIndexStatus(next ?? null);
      } catch (e) {
        if (active) fail("get:index-status", "knowledge_index_status", e);
      }
    })();
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

  const commitRecency = () => {
    if (!acceptsRecency(recency.trim())) {
      setRecencyError(`A half-life must be more than 0 days. Convo is using ${RECENCY_DEFAULT}.`);
      return;
    }
    setRecencyError(null);
    void write(RECENCY_KEY, recency.trim(), "set_memory_recency", () => setRecency(String(RECENCY_DEFAULT)));
  };

  const commitExtractEvery = () => {
    if (!acceptsExtractEvery(extractEvery.trim())) {
      setExtractEveryError(`Extraction can run every 1 exchange or more. Convo is using ${EXTRACT_EVERY_DEFAULT}.`);
      return;
    }
    setExtractEveryError(null);
    void write(EXTRACT_EVERY_KEY, extractEvery.trim(), "set_memory_extract_every", () => setExtractEvery(String(EXTRACT_EVERY_DEFAULT)));
  };

  const toggleRecallKind = (id: string, next: boolean) => {
    // Turning one on is a union with the current scope; turning one off is a
    // subtraction from it. One filter cannot do both — treating "off" as
    // "everything except this" silently re-admits kinds the user had already
    // excluded.
    const wanted = next
      ? RECALL_KINDS.map((kind) => kind.id).filter(
          (other) => other === id || recallKinds.includes(other),
        )
      : recallKinds.filter((other) => other !== id);
    // Empty means "every kind" downstream, so storing an empty list would
    // silently invert the setting the user just cleared.
    if (wanted.length === 0) {
      setRecallKindsError(
        "At least one kind has to stay recallable. To keep a single memory out, turn that memory off instead.",
      );
      return;
    }
    const previous = recallKinds;
    setRecallKindsError(null);
    setRecallKinds(wanted);
    void write(RECALL_KINDS_KEY, JSON.stringify(wanted), "set_memory_recall_kinds", () =>
      setRecallKinds(previous),
    );
  };

  const toggleAutoExtract = (next: boolean) => {
    const previous = autoExtract;
    setAutoExtract(next);
    void write(AUTO_EXTRACT_KEY, String(next), "set_memory_auto_extract", () => setAutoExtract(previous));
  };

  const toggleEmbedNotes = (next: boolean) => {
    const previous = embedNotes;
    setEmbedNotes(next);
    void write(EMBED_NOTES_KEY, String(next), "set_memory_embed_all_notes", () => setEmbedNotes(previous));
  };

  const buildIndex = async () => {
    setIndexBusy(true);
    setIndexMessage(null);
    try {
      const written = await api.memoryIndexFill(embedNotes);
      try {
        setIndexStatus(await api.knowledgeIndexStatus());
      } catch (e) {
        // The fill succeeded; only the refresh failed. Do not overwrite the
        // success message with the refresh error.
        fail("get:index-status", "knowledge_index_status", e);
      }
      setIndexMessage(
        written === 0
          ? "Nothing to index — every eligible item already has a vector."
          : `Indexed ${written} item${written === 1 ? "" : "s"}.`,
      );
    } catch (e) {
      setIndexMessage(String(e));
      fail("memory-index-fill", "memory_index_fill", e);
    } finally {
      setIndexBusy(false);
    }
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
            <Row
              id="memory-recency-half-life"
              label="Recency half-life (days)"
              hint={`How fast an older memory loses rank. Convo uses ${RECENCY_DEFAULT} days unless this says otherwise; a value of 0 or less falls back to ${RECENCY_DEFAULT} rather than switching decay off.`}
              error={recencyError}
            >
              <TextInput
                id="memory-recency-half-life"
                type="number"
                className="w-24"
                value={recency}
                onChange={(value) => { setRecency(value); setRecencyError(null); }}
                onBlur={commitRecency}
                onKeyDown={(event) => { if (event.key === "Enter") commitRecency(); }}
              />
            </Row>
            <Row
              id="memory-extract-every"
              label="Extract every N exchanges"
              hint={`How many completed exchanges to wait between automatic extraction runs. ${EXTRACT_EVERY_DEFAULT} is every exchange; 0 falls back to ${EXTRACT_EVERY_DEFAULT} — use the switch below to turn extraction off.`}
              error={extractEveryError}
            >
              <TextInput
                id="memory-extract-every"
                type="number"
                className="w-24"
                value={extractEvery}
                onChange={(value) => { setExtractEvery(value); setExtractEveryError(null); }}
                onBlur={commitExtractEvery}
                onKeyDown={(event) => { if (event.key === "Enter") commitExtractEvery(); }}
              />
            </Row>
            <div className="py-3 border-t border-border">
              <p className="text-sm text-text">Recall kinds</p>
              <p className="text-xs text-text-muted mt-0.5">
                Which kinds of memory a chat send may pull in. Pinned memories are injected
                whatever this says.
              </p>
              {recallKindsError && <p className="text-xs text-error mt-1">{recallKindsError}</p>}
              <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1">
                {RECALL_KINDS.map((kind) => (
                  <Switch
                    key={kind.id}
                    label={kind.label}
                    checked={recallKinds.includes(kind.id)}
                    onChange={(next) => toggleRecallKind(kind.id, next)}
                  />
                ))}
              </div>
            </div>
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
            <h3 className="text-sm font-medium text-text">Semantic index</h3>
            <p className="text-xs text-text-muted mt-0.5 mb-1">
              Recall fuses keyword search with vectors from an embedding model. Without one, only
              memories that share words with the question are found — asking by the word "name"
              misses a memory titled "User's nickname".
            </p>
            <div className="py-3 border-t border-border">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-text">
                    {indexStatus?.embeddingModel
                      ? `Embedding model: ${indexStatus.embeddingModel}`
                      : "No embedding model configured"}
                  </p>
                  {indexStatus && (
                    <p className="text-xs text-text-muted mt-0.5">
                      {indexStatus.embeddedCount} embedded · {indexStatus.needsEmbedding} waiting
                    </p>
                  )}
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  loading={indexBusy}
                  disabled={indexBusy || !indexStatus?.embeddingModel}
                  onClick={() => void buildIndex()}
                >
                  Build index
                </Button>
              </div>
              {indexStatus?.semanticNote && (
                <p className="text-xs text-text-subtle mt-2">{indexStatus.semanticNote}</p>
              )}
              {!indexStatus?.embeddingModel && (
                <p className="text-xs text-text-subtle mt-2">
                  Set an Embedding route under Model routing, pull that model in Ollama, then Build
                  index.
                </p>
              )}
              {indexMessage && <p className="text-xs text-text mt-2">{indexMessage}</p>}
            </div>
            <div className="py-3 border-t border-border">
              <Switch
                label="Index unpinned notes too"
                description="By default only pinned notes get a vector: a long-form note library is expensive to embed and rarely what a chat query is reaching for."
                checked={embedNotes}
                onChange={toggleEmbedNotes}
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
