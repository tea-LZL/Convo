import { useEffect, useRef, useState } from "react";
import { Brain, Plus, Save, Sparkles, Tag } from "lucide-react";
import { api } from "../lib/api";
import type { ExtractableSession, ExtractedFact, MemoryItem, MemoryReview, MemorySearchHit } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Spinner, TextArea } from "../components/ui/Form";
import { toast } from "../stores/toasts";
import { useMemoryStore } from "../stores/memory";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { RouteShell } from "../components/ui/RouteShell";
import { MemoryEditor, memoryDraftFromItem, type MemoryEditorDraft } from "../components/memory/MemoryEditor";
import { MemoryLibrary, KIND_COLOR, KIND_LABEL, type MemoryKind, type MemoryKindFilter } from "../components/memory/MemoryLibrary";
import { duplicateCandidateIndexes, MemoryReviewQueue } from "../components/memory/MemoryReviewQueue";
import { RecallTester } from "../components/memory/RecallTester";
import { useNavigate } from "react-router-dom";

function memoryKindOrNull(kind: string): MemoryKind | null {
  if (kind === "user_pref" || kind === "project_fact" || kind === "skill") return kind;
  return null;
}

export function MemoryRoute() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [recallItems, setRecallItems] = useState<MemoryItem[]>([]);
  const [filter, setFilter] = useState<MemoryKindFilter>("all");
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<MemorySearchHit[] | null>(null);
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const savingEditRef = useRef(false);
  const editSessionRef = useRef(0);
  const [draft, setDraft] = useState<MemoryEditorDraft>({
    kind: "user_pref",
    title: "",
    content: "",
    tags: "",
    is_enabled: true,
  });
  const [showExtract, setShowExtract] = useState(false);
  const [extractBusy, setExtractBusy] = useState(false);
  const [extractFacts, setExtractFacts] = useState<ExtractedFact[] | null>(null);
  const [selectedFacts, setSelectedFacts] = useState<Set<number>>(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [showRecallTester, setShowRecallTester] = useState(false);
  const [memoryLoading, setMemoryLoading] = useState(true);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [recallLoading, setRecallLoading] = useState(true);
  const [recallError, setRecallError] = useState<string | null>(null);
  const [extractSessionId, setExtractSessionId] = useState<string | null>(null);
  const [extractSessions, setExtractSessions] = useState<ExtractableSession[]>([]);
  const reviews = useMemoryStore((s) => s.reviews);
  const refreshReviews = useMemoryStore((s) => s.refreshReviews);
  const retryReview = useMemoryStore((s) => s.retryReview);
  const markReviewReviewed = useMemoryStore((s) => s.markReviewReviewed);
  const upsertMemory = useMemoryStore((s) => s.upsert);
  const toggleMemory = useMemoryStore((s) => s.toggle);
  const removeMemory = useMemoryStore((s) => s.remove);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [reviewSelected, setReviewSelected] = useState<Set<number>>(new Set());
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, ExtractedFact[]>>({});
  const [deleteMemoryId, setDeleteMemoryId] = useState<string | null>(null);
  const [reviewAction, setReviewAction] = useState<"saving" | "discarding" | null>(null);
  const retryingReviewIdsRef = useRef(new Set<string>());
  const [retryingReviewIds, setRetryingReviewIds] = useState<Set<string>>(new Set());
  const reviewActionRef = useRef<"saving" | "discarding" | null>(null);
  const navigate = useNavigate();
  const libraryRequestRef = useRef(0);
  const recallRequestRef = useRef(0);
  const searchRequestRef = useRef(0);
  const filterRef = useRef(filter);
  const queryRef = useRef(query);

  const performSearch = async (
    searchQuery: string,
    searchFilter: MemoryKindFilter,
    requestId: number,
  ) => {
    try {
      const result = await api.searchMemory(
        searchQuery,
        searchFilter === "all" ? undefined : searchFilter,
      );
      if (requestId !== searchRequestRef.current) return;
      setSearchHits(result);
      setSearchError(null);
    } catch (e) {
      if (requestId !== searchRequestRef.current) return;
      setSearchHits(null);
      setSearchError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === searchRequestRef.current) setSearchLoading(false);
    }
  };

  const startSearch = (searchQuery: string, searchFilter: MemoryKindFilter) => {
    const normalizedQuery = searchQuery.trim();
    const requestId = ++searchRequestRef.current;
    if (!normalizedQuery) {
      setSearchHits(null);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    void performSearch(normalizedQuery, searchFilter, requestId);
  };

  const refreshLibrary = async (revalidateSearch = true) => {
    const requestId = ++libraryRequestRef.current;
    if (revalidateSearch) startSearch(queryRef.current, filterRef.current);
    setMemoryLoading(true);
    setMemoryError(null);
    try {
      const currentFilter = filterRef.current;
      const list = await api.listMemory(currentFilter === "all" ? undefined : currentFilter);
      if (requestId !== libraryRequestRef.current) return;
      setItems(list);
    } catch (e) {
      if (requestId !== libraryRequestRef.current) return;
      setMemoryError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === libraryRequestRef.current) setMemoryLoading(false);
    }
  };

  const refreshRecallItems = async () => {
    const requestId = ++recallRequestRef.current;
    setRecallLoading(true);
    setRecallError(null);
    try {
      const list = await api.listMemory();
      if (requestId !== recallRequestRef.current) return;
      setRecallItems(list);
    } catch (e) {
      if (requestId !== recallRequestRef.current) return;
      setRecallError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === recallRequestRef.current) setRecallLoading(false);
    }
  };

  const refresh = async (revalidateSearch = true) => {
    await Promise.all([refreshLibrary(revalidateSearch), refreshRecallItems()]);
  };

  useEffect(() => { filterRef.current = filter; }, [filter]);
  useEffect(() => { queryRef.current = query; }, [query]);
  useEffect(() => { void refresh(false); }, [filter]);
  useEffect(() => { void refreshReviews(); }, [refreshReviews]);

  useEffect(() => {
    const requestId = ++searchRequestRef.current;
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      setSearchHits(null);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    setSearchHits(null);
    setSearchError(null);
    setSearchLoading(true);
    const t = setTimeout(() => {
      if (requestId !== searchRequestRef.current) return;
      void performSearch(normalizedQuery, filter, requestId);
    }, 200);
    return () => clearTimeout(t);
  }, [query, filter]);

  const toggle = async (item: MemoryItem) => {
    await toggleMemory(item.id, !item.is_enabled);
    await refresh();
  };

  const remove = async (id: string) => {
    await removeMemory(id);
    await refresh();
  };

  const startEdit = (item: MemoryItem) => {
    if (savingEditRef.current) return;
    editSessionRef.current += 1;
    setEditing(item);
    setDraft(memoryDraftFromItem(item));
  };

  const closeEdit = () => {
    if (savingEditRef.current) return;
    editSessionRef.current += 1;
    setEditing(null);
  };

  const handleEditChange = (patch: Partial<MemoryEditorDraft>) => {
    if (savingEditRef.current) return;
    setDraft((current) => ({ ...current, ...patch }));
  };

  const saveEdit = async () => {
    if (!editing || savingEditRef.current) return;
    if (!draft.content.trim()) {
      toast.error("Content cannot be empty");
      return;
    }
    const editSession = editSessionRef.current;
    savingEditRef.current = true;
    setSavingEdit(true);
    try {
      await upsertMemory({
        id: editing.id,
        kind: draft.kind,
        title: draft.title || null,
        content: draft.content,
        tags: draft.tags || null,
        is_enabled: draft.is_enabled,
      });
      if (editSession === editSessionRef.current) setEditing(null);
      await refresh();
      toast.success("Saved");
    } catch (e) {
      toast.error(String(e), "Memory could not be saved");
    } finally {
      savingEditRef.current = false;
      setSavingEdit(false);
    }
  };

  const add = async (kind: MemoryKind) => {
    try {
      const id = await upsertMemory({
        kind,
        title: null,
        content: "",
        tags: null,
        is_enabled: true,
      });
      setShowAdd(false);
      await refresh();
      // Open the new item in the editor
      const created = (await api.listMemory(kind)).find((m) => m.id === id);
      if (created) startEdit(created);
    } catch (e) { toast.error(String(e)); }
  };

  const runExtract = async () => {
    setExtractBusy(true);
    setExtractSessions([]);
    try {
      setExtractSessions(await api.listExtractableSessions());
    } catch (e) {
      toast.error(String(e));
    } finally {
      setExtractBusy(false);
    }
  };

  const runExtractOnSession = async (sessionId: string) => {
    setExtractSessionId(sessionId);
    setExtractBusy(true);
    try {
      const facts = await api.extractFactsFromSession(sessionId);
      setExtractFacts(facts);
      setSelectedFacts(new Set(facts.map((_, i) => i)));
    } catch (e) {
      toast.error(String(e));
    }
    setExtractBusy(false);
  };

  const saveSelectedFacts = async () => {
    if (!extractFacts) return;
    const chosen = extractFacts.filter((_, i) => selectedFacts.has(i));
    for (const f of chosen) {
      await upsertMemory({
        kind: f.kind as "user_pref" | "project_fact" | "skill",
        title: f.title,
        content: f.content,
        tags: f.tags,
        is_enabled: true,
      });
    }
    toast.success(`Saved ${chosen.length} memory item(s)`);
    setShowExtract(false);
    setExtractFacts(null);
    setSelectedFacts(new Set());
    await refresh();
  };

  const visible = searchHits ?? items.map((item) => ({ item, snippet: "" }));
  const activeReview = reviewId ? reviews.find((review) => review.id === reviewId) ?? null : null;
  const persistedItemsReady = !recallLoading && recallError === null;
  const persistedItems = persistedItemsReady ? recallItems : [];

  const openReview = (review: MemoryReview, selectedIndexes: number[]) => {
    setReviewId(review.id);
    setReviewSelected(new Set(selectedIndexes));
    setReviewDrafts((current) => current[review.id]
      ? current
      : { ...current, [review.id]: review.facts.map((fact) => ({ ...fact })) });
  };

  const closeReview = () => {
    setReviewId(null);
    setReviewSelected(new Set());
  };

  const clearReview = (id: string) => {
    closeReview();
    setReviewDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const updateReviewCandidate = (index: number, patch: Partial<ExtractedFact>) => {
    if (!activeReview) return;
    setReviewDrafts((current) => {
      const candidates = current[activeReview.id] ?? activeReview.facts;
      return {
        ...current,
        [activeReview.id]: candidates.map((candidate, candidateIndex) => (
          candidateIndex === index ? { ...candidate, ...patch } : candidate
        )),
      };
    });
  };

  const toggleReviewSelection = (index: number, selected: boolean) => {
    setReviewSelected((current) => {
      const next = new Set(current);
      if (selected) next.add(index);
      else next.delete(index);
      return next;
    });
  };

  const selectAllReview = (indexes: number[]) => {
    setReviewSelected(new Set(indexes));
  };

  const beginReviewAction = (action: "saving" | "discarding") => {
    if (reviewActionRef.current !== null) return false;
    reviewActionRef.current = action;
    setReviewAction(action);
    return true;
  };

  const endReviewAction = (action: "saving" | "discarding") => {
    if (reviewActionRef.current !== action) return;
    reviewActionRef.current = null;
    setReviewAction(null);
  };

  const discardReview = async () => {
    if (!activeReview || !beginReviewAction("discarding")) return;
    const id = activeReview.id;
    try {
      await markReviewReviewed(id);
      clearReview(id);
    } catch (e) {
      toast.error(String(e), "Review could not be discarded");
    } finally {
      endReviewAction("discarding");
    }
  };

  const saveReview = async () => {
    if (!activeReview || reviewActionRef.current !== null) return;
    if (!persistedItemsReady) {
      toast.warn("Wait for saved memory to load before accepting candidates");
      return;
    }
    const candidates = reviewDrafts[activeReview.id] ?? activeReview.facts;
    const selectedCandidates = candidates.flatMap((candidate, index) => (
      reviewSelected.has(index) ? [{ candidate, index }] : []
    ));
    const normalizedSelected: Array<{
      index: number;
      candidate: ExtractedFact & { kind: MemoryKind };
    }> = [];
    for (const { candidate, index } of selectedCandidates) {
      const kind = memoryKindOrNull(candidate.kind);
      if (!kind) {
        toast.warn(`Candidate ${index + 1} has unsupported kind "${candidate.kind}". Choose user_pref, project_fact, or skill before saving.`);
        return;
      }
      if (!candidate.content.trim()) {
        toast.warn(`Candidate ${index + 1} has empty content. Add content or unselect it before saving.`);
        return;
      }
      normalizedSelected.push({
        index,
        candidate: { ...candidate, kind },
      });
    }
    const duplicateIndexes = duplicateCandidateIndexes(candidates, persistedItems, persistedItemsReady);
    const chosen = normalizedSelected
      .filter(({ index }) => !duplicateIndexes.has(index))
      .map(({ candidate }) => candidate);
    if (chosen.length === 0) {
      toast.warn("Select at least one new candidate");
      return;
    }
    if (!beginReviewAction("saving")) return;
    const id = activeReview.id;
    try {
      for (const candidate of chosen) {
        await upsertMemory({
          kind: candidate.kind,
          title: candidate.title,
          content: candidate.content,
          tags: candidate.tags,
          is_enabled: true,
        });
      }
      await markReviewReviewed(id);
      const savedSkill = chosen.some((candidate) => candidate.kind === "skill");
      toast.success(`Saved ${chosen.length} memory item${chosen.length === 1 ? "" : "s"}`);
      clearReview(id);
      if (savedSkill) {
        filterRef.current = "skill";
        setFilter("skill");
      }
      await refresh();
    } catch (e) {
      toast.error(String(e), "Memory review could not be saved");
    } finally {
      endReviewAction("saving");
    }
  };

  const openReviewSourceChat = () => {
    const sessionId = activeReview?.sessionId;
    closeReview();
    if (sessionId) navigate(`/chat/${sessionId}`);
  };

  const retryReviewById = (id: string) => {
    if (retryingReviewIdsRef.current.has(id)) return;
    retryingReviewIdsRef.current.add(id);
    setRetryingReviewIds((current) => new Set(current).add(id));
    void retryReview(id)
      .catch((error) => toast.error(String(error)))
      .finally(() => {
        retryingReviewIdsRef.current.delete(id);
        setRetryingReviewIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      });
  };

  const handleQueryChange = (nextQuery: string) => {
    queryRef.current = nextQuery;
    searchRequestRef.current += 1;
    setSearchHits(null);
    setSearchError(null);
    setSearchLoading(Boolean(nextQuery.trim()));
    setQuery(nextQuery);
  };

  const handleFilterChange = (nextFilter: MemoryKindFilter) => {
    if (nextFilter === filter) return;
    filterRef.current = nextFilter;
    searchRequestRef.current += 1;
    if (queryRef.current.trim()) {
      setSearchHits(null);
      setSearchError(null);
      setSearchLoading(true);
    }
    setFilter(nextFilter);
  };

  return (
    <RouteShell
      title="Memory"
      description={`${items.length} item(s) · durable context used when relevant.`}
      actions={
        <>
          <Button size="sm" variant="secondary" icon={<Brain size={11} />} onClick={() => setShowRecallTester(true)}>
            Test recall
          </Button>
          <Button size="sm" variant="secondary" icon={<Sparkles size={11} />} onClick={() => {
            setShowExtract(true);
            void runExtract();
          }}>
            Extract from chat
          </Button>
          <Button size="sm" variant="primary" icon={<Plus size={11} />} onClick={() => setShowAdd(true)}>
            Add
          </Button>
        </>
      }
    >
      <MemoryReviewQueue
        reviews={reviews}
        persistedItems={persistedItems}
        persistedItemsReady={persistedItemsReady}
        persistedItemsError={recallError}
        reviewAction={reviewAction}
        activeReviewId={reviewId}
        selected={reviewSelected}
        drafts={reviewDrafts}
        retryingReviewIds={retryingReviewIds}
        onOpenReview={openReview}
        onRetry={retryReviewById}
        onToggleSelection={toggleReviewSelection}
        onSelectAll={selectAllReview}
        onCloseReview={closeReview}
        onRetryPersistedItems={() => void refreshRecallItems()}
        onDiscard={discardReview}
        onSave={saveReview}
        onOpenSourceChat={openReviewSourceChat}
        onCandidateChange={updateReviewCandidate}
      />
      <MemoryLibrary
        items={items}
        visible={visible}
        filter={filter}
        query={query}
        loading={memoryLoading}
        error={memoryError}
        searchLoading={searchLoading}
        searchError={searchError}
        onQueryChange={handleQueryChange}
        onFilterChange={handleFilterChange}
        onRetry={() => void refreshLibrary()}
        onSearchRetry={() => startSearch(queryRef.current, filterRef.current)}
        onAdd={add}
        onToggle={toggle}
        onEdit={startEdit}
        onDelete={(id) => setDeleteMemoryId(id)}
      />

      <RecallTester
        open={showRecallTester}
        onClose={() => setShowRecallTester(false)}
        items={recallItems}
        loading={recallLoading}
        error={recallError}
        onRetry={() => void refreshRecallItems()}
      />

      {/* Add modal */}
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add memory" size="sm">
        <div className="space-y-2">
          <p className="text-sm text-text-muted">What kind of memory?</p>
          <div className="grid grid-cols-1 gap-2">
            <Button variant="secondary" onClick={() => add("user_pref")}>User preference</Button>
            <Button variant="secondary" onClick={() => add("project_fact")}>Project fact</Button>
            <Button variant="secondary" onClick={() => add("skill")}>Skill</Button>
          </div>
        </div>
      </Modal>

      <MemoryEditor
        open={editing !== null}
        item={editing}
        draft={draft}
        onChange={handleEditChange}
        onClose={closeEdit}
        onSave={() => void saveEdit()}
        saving={savingEdit}
      />

      {/* Extract from session modal */}
      <Modal
        open={showExtract}
        onClose={() => {
          setShowExtract(false);
          setExtractFacts(null);
          setSelectedFacts(new Set());
          setExtractSessionId(null);
          setExtractSessions([]);
        }}
        title={extractSessionId ? "Extract facts from chat" : "Choose a session to extract from"}
        description={extractSessionId
          ? `Extracting facts from: ${extractSessions.find((s) => s.id === extractSessionId)?.title || extractSessionId}`
          : "Convo will ask the LLM to find durable facts in the selected session."}
        size="lg"
        footer={
          extractFacts !== null ? (
            <>
              <Button variant="ghost" onClick={() => {
                setShowExtract(false);
                setExtractFacts(null);
                setSelectedFacts(new Set());
                setExtractSessionId(null);
              }}>Cancel</Button>
              <Button variant="secondary" onClick={() => setSelectedFacts(new Set(extractFacts.map((_, i) => i)))}>Select all</Button>
              <Button variant="primary" onClick={saveSelectedFacts} disabled={selectedFacts.size === 0} icon={<Save size={12} />}>
                Save {selectedFacts.size}
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => {
              setShowExtract(false);
              setExtractSessions([]);
            }}>Cancel</Button>
          )
        }
      >
        {extractFacts !== null ? (
          extractFacts.length === 0 ? (
            <div className="text-sm text-text-muted py-4 text-center">No durable facts found in this session.</div>
          ) : (
            <ul className="space-y-2">
              {extractFacts.map((f, i) => (
              <li key={i} className="bg-surface-1 border border-border rounded-md p-3">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedFacts.has(i)}
                    onChange={(e) => {
                      const next = new Set(selectedFacts);
                      if (e.target.checked) next.add(i);
                      else next.delete(i);
                      setSelectedFacts(next);
                    }}
                    className="accent-[var(--color-accent)] mt-1"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`inline-block text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border ${KIND_COLOR[f.kind] || KIND_COLOR.skill}`}>
                        {KIND_LABEL[f.kind as MemoryKindFilter] || f.kind}
                      </span>
                      {f.title && <span className="text-xs font-medium text-text">{f.title}</span>}
                    </div>
                    <div className="text-xs text-text-muted leading-relaxed">{f.content}</div>
                    {f.tags && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {f.tags.split(",").map((t, j) => t.trim()).filter(Boolean).map((t, j) => (
                          <span key={j} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border bg-surface-2 text-text-subtle">
                            <Tag size={8} /> {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </label>
              </li>
            ))}
          </ul>
          )
        ) : extractBusy ? (
          <div className="flex items-center gap-2 py-4"><Spinner size={14} /> Loading sessions...</div>
        ) : extractSessions.length > 0 ? (
          <div className="space-y-1 max-h-[50vh] overflow-y-auto">
            {extractSessions.map((s) => (
              <button
                key={s.id}
                onClick={() => runExtractOnSession(s.id)}
                className="w-full text-left p-3 bg-surface-2 hover:bg-surface-3 border border-border rounded-md transition-colors"
              >
                <div className="text-sm font-medium text-text truncate">{s.title || "Untitled"}</div>
                <div className="text-xs text-text-muted mt-0.5">
                  {s.messageCount} message{s.messageCount === 1 ? "" : "s"} · {s.snippet || "(no preview)"}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="text-sm text-text-muted py-4 text-center">
            No sessions available. Start a chat first.
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={deleteMemoryId !== null}
        onClose={() => setDeleteMemoryId(null)}
        onConfirm={async () => {
          if (deleteMemoryId) await remove(deleteMemoryId);
          setDeleteMemoryId(null);
        }}
        title="Delete memory item"
        message="Delete this memory item? This cannot be undone."
        confirmLabel="Delete"
        confirmVariant="danger"
      />
    </RouteShell>
  );
}
