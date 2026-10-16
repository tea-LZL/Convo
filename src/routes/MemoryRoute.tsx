/**
 * Memory — the densest page in the app, and the first of three (with
 * Documents and Tasks) that say so in their spacing.
 *
 * ── The compact rhythm ────────────────────────────────────────────────
 * Every other page uses the standard rhythm: a 12px step between rows
 * and 12px of padding inside a card. Here it is 4px and 8px. Nothing
 * else changes. Same tokens, same 1px border, same `--radius-lg`, same
 * colours, same type sizes — less air, and that is the whole of it.
 *
 * The reasoning is a tool, not a taste. A memory store is the one list a
 * user comes back to *to see all of it*: what is pinned, what is
 * disabled, what a note produced, what kind each thing is. The twelve
 * pixels a row gives back is about a seventh of a typical row's height,
 * spent on nothing. How many rows that buys is modelled in
 * `MemoryRoute.test.tsx` rather than asserted as a count here, because a
 * count needs a laid-out row to measure and jsdom has no layout; the
 * test's general claim — more rows fit at any row height, and strictly
 * more at the heights this page actually has — is the one that holds.
 *
 * So the density lives in spacing values, and it is *measured* rather
 * than declared: the test compiles this file's classes through Tailwind
 * and asserts the rendered gap and padding are smaller than the standard
 * rhythm's, resolved the same way. Retuning either side moves both. A
 * test that read `space-y-1` off the DOM would break on the retune and
 * pass on any page that merely said it.
 *
 * Documents and Tasks take the same treatment. The two rhythms are a
 * deliberate split, not an inconsistency, and neither is a toggle.
 *
 * ── What is deliberately not here ──────────────────────────────────────
 * No shadow. A card in this design is a surface and a 1px border, and a
 * shadow on a list row is a regression against that rather than a
 * finishing touch. The only `box-shadow` in the app belongs to things
 * that genuinely float — a modal, a dropdown, a tooltip — and none of
 * those are on this page. Focus rings are the exception, and each one is
 * behind a state: Tailwind builds `ring-*` out of `box-shadow`, so a
 * ring that was not scoped would put a shadow on every row at rest.
 *
 * No transition inside the list, either, for the same reason the
 * streaming subtree is fenced: the list is the subtree that scales to
 * hundreds of rows. The handful of controls that are not the list — the
 * three starter cards, the rows inside a modal — keep theirs.
 *
 * The one deliberate exception to the density work: the four controls at
 * the end of a row went from 20px to 24px. Accessibility beats density,
 * WCAG 2.2's target size is a requirement rather than a preference, and
 * the column is a fixed 102px either way, so it costs no horizontal
 * space. The density is expressed in the gaps between rows, not in the
 * one place a bigger number would not have shown up as a smaller one.
 *
 * ── The kind filter, and the header it squeezes ─────────────────────────
 * Spec §4.2 puts the filter in the right-aligned `actions` cluster, and
 * that is where it is.
 *
 * Getting it there needed the cluster to be allowed to give, and it did
 * not: `RouteShell` put `shrink-0` on the action cluster, so a four-item
 * filter group could not shrink and a narrow window had to choose between
 * the spec's placement and working at all. The header was the defect, not
 * the filter's placement, so `RouteShell` no longer declares it and the
 * cluster's own `flex-wrap` reflows the control set. No collapse-to-
 * dropdown, which would be a new mechanism; reflow is the smaller honest
 * answer to a narrow window. Both sides are pinned —
 * `RouteShell.test.tsx` from the shell, and this page's test from the
 * page that depends on it.
 *
 * Three size overrides put the filter's controls at the same resolved
 * metrics as the buttons beside them. `Tabs` is a 14px, 33px-tall
 * underline tab bar; the header's buttons are 12px and 24px; side by side
 * they read as two different design systems, and the filter is the only
 * control in the cluster that is not a button. The overrides resolve to
 * exactly `Button size="sm"`, and the test compares the two sets of
 * resolved values rather than the two sets of class names.
 * `border-b-0` is the emission-order claim it has always been, with its
 * own test. `Badge` could not take the pinned and provenance chips for the
 * same underlying reason — see `CHIP`.
 */
import { useEffect, useState } from "react";
import { Plus, Trash2, Brain, Power, PowerOff, Pin, PinOff, Search, Tag, X, Save, Sparkles, Filter, Edit3, Check, Bell, StickyNote } from "lucide-react";
import { api, ExtractableSession, ExtractedFact, MemoryItem, MemorySearchHit } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Dropdown } from "../components/ui/Dropdown";
import { EmptyState } from "../components/ui/EmptyState";
import { Modal } from "../components/ui/Modal";
import { Tabs, TextArea, TextInput, Badge } from "../components/ui/Form";
import { Spinner } from "../components/ui/Form";
import { toast } from "../stores/toasts";
import { useMemoryStore } from "../stores/memory";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { RouteShell } from "../components/ui/RouteShell";
import { ROW_ACTION, ROW_ACTION_IDLE } from "../components/ui/rowAction";
import { IndexStatusBanner } from "../components/memory/IndexStatusBanner";
import { RecallPanel } from "../components/memory/RecallPanel";
import { SupersedeHistory } from "../components/memory/SupersedeHistory";
import { useNavigate } from "react-router-dom";

type KindFilter = "all" | "user_pref" | "project_fact" | "skill";

const KIND_LABEL: Record<KindFilter, string> = {
  all: "All",
  user_pref: "Preferences",
  project_fact: "Project facts",
  skill: "Skills",
};

/**
 * The kind chip is a `Badge`, and the variant is the whole of the
 * mapping. `Badge` already owns exactly the three colour sets this page
 * used to spell out here as class strings, and owning them in one place
 * is what keeps a fourth kind from arriving with a hand-written colour.
 */
type KindVariant = "accent" | "success" | "warn";
const KIND_VARIANT: Record<string, KindVariant> = {
  user_pref: "accent",
  project_fact: "success",
  skill: "warn",
};


/**
 * The 10px chip geometry, stated once.
 *
 * `Badge` has the same geometry and is what the kind chip uses — it needs
 * nothing but a variant. These three cannot: the pinned and provenance
 * chips both carry a `title`, and `Badge` declares no `title` prop, so
 * using it would mean either dropping the only affordance that works on a
 * non-interactive element or adding a prop to a primitive. The second is
 * the thing `primitiveApi.test.ts` exists to prevent, so the geometry is
 * written out here and the page keeps one spelling of it.
 */
const CHIP = "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-sm border";

export function MemoryRoute() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  /**
   * memory id → the title of the note that produced it, resolved once per
   * refresh rather than per row. One call, and a `Map` lookup at render: a
   * per-row lookup is invisible at ten memories and obvious at two hundred.
   *
   * `list_note_titles` rather than `list_notes`, and the difference is the
   * size of the payload: this runs after every pin click, and a note body is
   * a free-text textarea, so `list_notes` was sending the whole library —
   * megabytes of pasted documents — to read two short strings per row.
   */
  const [provenance, setProvenance] = useState<Map<string, string>>(new Map());
  const [filter, setFilter] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<MemorySearchHit[] | null>(null);
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [draft, setDraft] = useState<{ title: string; content: string; tags: string; is_enabled: boolean }>({
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
  const [statusTick, setStatusTick] = useState(0);
  const navigate = useNavigate();

  const refresh = async () => {
    const [list, titles] = await Promise.all([
      api.listMemory(filter === "all" ? undefined : filter),
      // Provenance is decoration. A note library that will not load must not
      // cost the list it decorates, so this failure is swallowed and the
      // rows render without a "from note" line.
      api.listNoteTitles().catch(() => []),
    ]);
    setItems(list);
    setProvenance(new Map(
      titles.flatMap((note) =>
        note.memory_ids.map((memoryId) => [memoryId, note.title || "Untitled"] as const),
      ),
    ));
    setSearchHits(null);
  };

  const refreshAfterMutation = async () => {
    await refresh();
    setStatusTick((n) => n + 1);
  };

  useEffect(() => { refresh(); }, [filter]);
  useEffect(() => { void refreshReviews(); }, [refreshReviews]);

  useEffect(() => {
    if (!query.trim()) {
      setSearchHits(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await api.searchMemory(query, filter === "all" ? undefined : filter);
        setSearchHits(r);
      } catch (e) { console.error(e); }
    }, 200);
    return () => clearTimeout(t);
  }, [query, filter]);

  const toggle = async (item: MemoryItem) => {
    await toggleMemory(item.id, !item.is_enabled);
    await refreshAfterMutation();
  };

  // `set_memory_pinned` is the deliberate path: `upsert_memory` does not
  // carry a pin, so writing the editor's draft back would unpin a memory
  // pinned here. Errors for an id that is not there rather than reporting a
  // pin that never took.
  const setPinned = async (item: MemoryItem, pinned: boolean) => {
    try {
      await api.setMemoryPinned(item.id, pinned);
      await refreshAfterMutation();
    } catch (e) {
      toast.error(String(e), "Pin could not be changed");
    }
  };

  const remove = async (id: string) => {
    await removeMemory(id);
    await refreshAfterMutation();
  };

  const startEdit = (item: MemoryItem) => {
    setEditing(item);
    setDraft({
      title: item.title ?? "",
      content: item.content,
      tags: item.tags ?? "",
      is_enabled: item.is_enabled,
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (!draft.content.trim()) {
      toast.error("Content cannot be empty");
      return;
    }
    await upsertMemory({
      id: editing.id,
      kind: editing.kind as "user_pref" | "project_fact" | "skill",
      title: draft.title || null,
      content: draft.content,
      tags: draft.tags || null,
      is_enabled: draft.is_enabled,
    });
    setEditing(null);
    await refresh();
    toast.success("Saved");
  };

  const add = async (kind: "user_pref" | "project_fact" | "skill") => {
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

  const visible = searchHits ?? items.map((i) => ({ item: i, snippet: "" }));
  const reviewPending = reviewId ? reviews.find((review) => review.id === reviewId) ?? null : null;
  const [deleteMemoryId, setDeleteMemoryId] = useState<string | null>(null);

  return (
    <RouteShell
      title="Memory"
      description={`${items.length} item(s) · durable context used when relevant.`}
      actions={
        <>
          {/* The kind filter, in the cluster where spec §4.2 puts it. The
              three size overrides exist because `Tabs` is a 14px, 33px
              underline tab bar and the buttons beside it are 12px and
              24px; they resolve to exactly `Button size="sm"`, and the
              test compares the two sets of resolved values rather than
              the two sets of class names. `border-b-0` is the same
              emission-order claim as before and the same test. */}
          <Tabs
            active={filter}
            onChange={(v) => setFilter(v as KindFilter)}
            tabs={[
              { id: "all", label: "All" },
              { id: "user_pref", label: "Preferences" },
              { id: "project_fact", label: "Project facts" },
              { id: "skill", label: "Skills" },
            ]}
            className="border-b-0 [&>button]:px-2.5 [&>button]:py-1 [&>button]:text-xs"
          />
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
      <div className="px-3 py-1.5 border-b border-border bg-surface-1/40 flex items-center gap-2 flex-wrap">
        {/* The page's only declared width floor, and it is deliberately
            smaller than the sidebar's own 240px: a window that narrows is
            absorbed by the content pane, never by the chrome. The
            `max-w-sm` keeps a lone search field from running the full
            672px measure on a wide monitor; a max-width cannot squeeze a
            narrow one, so it plays no part in the floor above. */}
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search
            size={12}
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle"
          />
          {/* Hand-composed rather than `TextInput`, deliberately: its
              `text-sm` and `px-3` cannot be overridden from `className`
              without depending on the order Tailwind happens to emit two
              same-property utilities in, and a search field is the one
              control on this page worth 8px of height. Everything that
              does not fight the primitive — surface, radius, border, the
              focus ring — is `TextInput`'s, copied. That is the coupling
              this comment exists to name: a second copy of the primitive's
              treatment that will not notice if the primitive changes. */}
          <input
            aria-label="Search memory"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memory…"
            className="w-full bg-surface-2 border border-border rounded-md pl-7 pr-2.5 py-1 text-xs text-text placeholder:text-text-subtle focus:outline-none focus:border-accent focus:ring-2 focus:ring-text focus:ring-offset-2 focus:ring-offset-bg"
          />
        </div>
      </div>
      {reviews.length > 0 && (
        <div className="border-b border-border bg-accent/5 px-3 py-1.5 flex items-center gap-1.5 flex-wrap">
          <Bell size={12} className="text-accent shrink-0" />
          <span className="text-xs text-text">Memory extraction reviews</span>
          <div className="flex-1" />
          {reviews.map((review) => {
            const label = review.status === "pending"
              ? `Pending (${review.facts.length})`
              : review.status === "failed" ? "Failed · Retry"
                : review.status === "extracting" ? "Extracting · Retry" : "Reviewed";
            return (
              <Button
                key={review.id}
                size="xs"
                variant="secondary"
                disabled={review.status === "reviewed"}
                onClick={() => {
                  if (review.status === "failed" || review.status === "extracting") void retryReview(review.id);
                  if (review.status === "pending") {
                    setReviewId(review.id);
                    setReviewSelected(new Set(review.facts.map((_, i) => i)));
                  }
                }}
                title={`From session ${review.sessionId.slice(0, 8)}…`}
              >
                {label}
              </Button>
            );
          })}
        </div>
      )}
      <div className="p-4 max-w-2xl mx-auto w-full">
        <IndexStatusBanner refreshKey={statusTick} />
        <RecallPanel />
        {visible.length === 0 ? (
          <EmptyState
            // `RouteShell` owns this page's h1, so the title underneath
            // it is an h2 — an h3 here would be a skipped level, and a
            // screen-reader user moves between headings by level.
            headingLevel={2}
            icon={<Brain size={28} />}
            title={query ? "No matches" : "No memories yet"}
            description={query
              ? "Try a different query or filter."
              : "Add user preferences, project facts, and skills. Convo picks the ones relevant to what you are asking. Pin a memory to always include it."}
            action={query ? undefined : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                <button
                  onClick={() => add("user_pref")}
                  className="bg-surface-1 hover:bg-surface-2 border border-border hover:border-accent/30 rounded-lg p-2.5 text-left transition-colors"
                >
                  <div className="text-xs font-medium text-text mb-0.5">Set a preference</div>
                  <div className="text-[10px] text-text-muted">"I prefer concise replies"</div>
                </button>
                <button
                  onClick={() => add("project_fact")}
                  className="bg-surface-1 hover:bg-surface-2 border border-border hover:border-accent/30 rounded-lg p-2.5 text-left transition-colors"
                >
                  <div className="text-xs font-medium text-text mb-0.5">Log a project fact</div>
                  <div className="text-[10px] text-text-muted">"This repo uses Tauri v2"</div>
                </button>
                <button
                  onClick={() => add("skill")}
                  className="bg-surface-1 hover:bg-surface-2 border border-border hover:border-accent/30 rounded-lg p-2.5 text-left transition-colors"
                >
                  <div className="text-xs font-medium text-text mb-0.5">Create a skill</div>
                  <div className="text-[10px] text-text-muted">"Run tests with `npm t` before push"</div>
                </button>
              </div>
            )}
          />
        ) : (
          <ul className="space-y-1">
            {visible.map((entry) => {
              const item = entry.item;
              const replaced = Boolean(item.superseded_by);
              const tags = (item.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
              const fromNote = provenance.get(item.id);
              const label = item.title || "memory item";
              return (
                <li key={item.id} id={`memory-${item.id}`} className={`bg-surface-1 border border-border rounded-lg p-2 group ${!item.is_enabled ? "opacity-50" : ""}`}>
                  <div className="flex items-start gap-1.5">
                    <Badge variant={KIND_VARIANT[item.kind] ?? "warn"}>
                      {KIND_LABEL[item.kind as KindFilter] || item.kind}
                    </Badge>
                    {item.pinned && (
                      <span
                        className={`${CHIP} border-accent/30 text-accent`}
                        title="Pinned — always included in every chat, budget permitting, and never at the mercy of what recall ranks."
                      >
                        <Pin size={8} /> pinned
                      </span>
                    )}
                    {/* `min-w-0` is what lets a long title give way; without
                        it `min-width: auto` turns the text into a hard floor
                        and a 200-word title widens the whole pane. The
                        `title` is what makes truncation fair — the text is
                        only clipped, never shortened. */}
                    {item.title && (
                      <div className={`text-sm font-medium min-w-0 truncate ${replaced ? "text-text-subtle line-through" : "text-text"}`} title={item.title}>
                        {item.title}
                      </div>
                    )}
                    <div className="flex-1" />
                    {/* The control column keeps its width and the text
                        gives: 102px is the same on every row, so what
                        shrinks on a narrow pane is the sentence, not the
                        four buttons a user has to hit. */}
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        aria-pressed={item.pinned}
                        aria-label={item.pinned ? `Unpin ${label} — stop including it in every chat` : `Pin ${label} — always include it in every chat`}
                        onClick={() => void setPinned(item, !item.pinned)}
                        className={`${ROW_ACTION} ${item.pinned ? "text-accent" : ROW_ACTION_IDLE}`}
                        title={item.pinned
                          ? "Pinned: always included in every chat, budget permitting, whether or not recall ranks it. Unpin to make it recall-only."
                          : "Unpinned: included only when recall ranks it for what you are asking. Pin it to always include it."}
                      >
                        {item.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                      </button>
                      <button
                        type="button"
                        // The pin above states its state; this one did not,
                        // and the gap is the whole class of defect Task 6
                        // found on Compare: a name that changes with the
                        // state ("Enable" / "Disable") promises the state
                        // is being announced, and without a state channel
                        // nothing is. A screen reader read "Disable Pref
                        // m-1 — stop it being eligible for recall, button"
                        // and could not tell whether it was enabled, which
                        // is the one fact the control exists to change.
                        // The polarity matches the pin: the name is the next
                        // action, so pressed says the governed state is
                        // currently on. `stateAgreement.test.ts` asserts
                        // the name, the state and the title all branch on
                        // the same expression.
                        aria-pressed={item.is_enabled}
                        aria-label={item.is_enabled
                          ? `Disable ${label} — stop it being eligible for recall`
                          : `Enable ${label} — let recall choose it when relevant`}
                        onClick={() => toggle(item)}
                        className={`${ROW_ACTION} ${ROW_ACTION_IDLE}`}
                        title={item.is_enabled
                          ? "Enabled: eligible for recall, so it is included when it is relevant to what you are asking. Disable to leave it out entirely — a disabled memory is not injected even when pinned."
                          : "Disabled: left out of every prompt, and not eligible for recall. Enable to let recall choose it again."}
                      >
                        {item.is_enabled ? <Power size={13} /> : <PowerOff size={13} />}
                      </button>
                      <button
                        type="button"
                        aria-label={`Edit ${label}`}
                        onClick={() => startEdit(item)}
                        className={`${ROW_ACTION} ${ROW_ACTION_IDLE}`}
                        title="Edit"
                      >
                        <Edit3 size={13} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${label}`}
                        onClick={() => setDeleteMemoryId(item.id)}
                        className={`${ROW_ACTION} text-text-subtle hover:text-error`}
                        title="Delete"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  {entry.snippet ? (
                    <div
                      // `break-words` is not optional next to
                      // `whitespace-pre-wrap`: an unbroken run — a pasted
                      // URL, a base64 blob — has no break opportunity, and
                      // it is those, not sentences, that break a row.
                      className={`text-xs text-text-muted leading-relaxed mt-1 break-words ${replaced ? "line-through" : ""}`}
                      dangerouslySetInnerHTML={{
                        __html: entry.snippet
                          .replace(/<mark>/g, '<mark class="bg-warn/30 text-text px-0.5">')
                          .replace(/<\/mark>/g, '</mark>'),
                      }}
                    />
                  ) : (
                    <div className={`text-xs text-text-muted leading-relaxed mt-1 whitespace-pre-wrap break-words ${replaced ? "line-through" : ""}`}>{item.content}</div>
                  )}
                  {(tags.length > 0 || fromNote || replaced) && (
                    <div className="flex flex-wrap items-center gap-1 mt-1.5">
                      <SupersedeHistory
                        item={item}
                        items={items}
                        onSelectReplacement={startEdit}
                      />
                      {fromNote && (
                        <span
                          className={`${CHIP} border-border bg-surface-2 text-text-muted`}
                          title="This memory was extracted from that note."
                        >
                          <StickyNote size={8} /> from note: {fromNote}
                        </span>
                      )}
                      {tags.map((t, j) => (
                        <span key={j} className={`${CHIP} border-border bg-surface-2 text-text-subtle`}>
                          <Tag size={8} /> {t}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Add modal */}
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add memory" size="sm">
        <div className="space-y-1.5">
          <p className="text-sm text-text-muted">What kind of memory?</p>
          <div className="grid grid-cols-1 gap-1.5">
            <Button variant="secondary" onClick={() => add("user_pref")}>User preference</Button>
            <Button variant="secondary" onClick={() => add("project_fact")}>Project fact</Button>
            <Button variant="secondary" onClick={() => add("skill")}>Skill</Button>
          </div>
        </div>
      </Modal>

      {/* Edit modal */}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Edit memory"
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" onClick={saveEdit} icon={<Save size={12} />}>Save</Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-1.5">
            <div className="text-xs text-text-muted">
              <Badge variant={KIND_VARIANT[editing.kind] ?? "warn"}>
                {KIND_LABEL[editing.kind as KindFilter] || editing.kind}
              </Badge>
            </div>
            <div>
              <label htmlFor="memory-title" className="text-xs text-text-muted block mb-1">Title (optional)</label>
              <TextInput id="memory-title" value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} />
            </div>
            <div>
              <label htmlFor="memory-content" className="text-xs text-text-muted block mb-1">Content</label>
              <TextArea
                id="memory-content"
                value={draft.content}
                onChange={(v) => setDraft({ ...draft, content: v })}
                rows={5}
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="memory-tags" className="text-xs text-text-muted block mb-1">Tags (comma-separated)</label>
              <TextInput id="memory-tags" value={draft.tags} onChange={(v) => setDraft({ ...draft, tags: v })} placeholder="preference, code-style, project-x" />
            </div>
            <label className="flex items-start gap-2 text-xs text-text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={draft.is_enabled}
                onChange={(e) => setDraft({ ...draft, is_enabled: e.target.checked })}
                className="accent-[var(--color-accent)] mt-0.5"
              />
              <span>
                Enabled — eligible for recall
                <span className="block text-[10px] text-text-subtle">
                  Included when it is relevant to what you are being asked. This is not the
                  same as pinning, which injects a memory into every chat whether or not recall
                  ranks it; pin it from the list with the pin button.
                </span>
              </span>
            </label>
          </div>
        )}
      </Modal>

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
            <ul className="space-y-1">
              {extractFacts.map((f, i) => (
              <li key={i} className="bg-surface-1 border border-border rounded-md p-2">
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
                      <Badge variant={KIND_VARIANT[f.kind] ?? "warn"}>
                        {KIND_LABEL[f.kind as KindFilter] || f.kind}
                      </Badge>
                      {f.title && <span className="text-xs font-medium text-text">{f.title}</span>}
                    </div>
                    <div className="text-xs text-text-muted leading-relaxed break-words">{f.content}</div>
                    {f.tags && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {f.tags.split(",").map((t, j) => t.trim()).filter(Boolean).map((t, j) => (
                          <span key={j} className={`${CHIP} border-border bg-surface-2 text-text-subtle`}>
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
                className="w-full text-left p-2 bg-surface-2 hover:bg-surface-3 border border-border rounded-md transition-colors"
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

      {/* Pending review modal — surfaces auto-extracted facts from
          chat-done. User picks which to save as memory items. */}
      <Modal
        open={!!reviewId}
        onClose={() => {
          setReviewId(null);
          setReviewSelected(new Set());
        }}
        title="Review extracted facts"
        description={
          reviewPending
            ? `Auto-extracted from chat ${reviewPending.sessionId.slice(0, 8)} — pick the facts that should become memory.`
            : ""
        }
        size="lg"
        footer={
          reviewPending ? (
            <>
              <Button
                variant="ghost"
                onClick={async () => {
                  await markReviewReviewed(reviewPending.id);
                  setReviewId(null);
                  setReviewSelected(new Set());
                }}
              >
                Discard all
              </Button>
              <Button
                variant="secondary"
                onClick={() => setReviewSelected(new Set(reviewPending.facts.map((_, i) => i)))}
              >
                Select all
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  const chosen = reviewPending.facts.filter((_, i) => reviewSelected.has(i));
                  for (const f of chosen) {
                    await upsertMemory({
                      kind: f.kind as "user_pref" | "project_fact" | "skill",
                      title: f.title,
                      content: f.content,
                      tags: f.tags,
                      is_enabled: true,
                    });
                  }
                  toast.success(`Saved ${chosen.length} memory item${chosen.length === 1 ? "" : "s"}`);
                  await markReviewReviewed(reviewPending.id);
                  setReviewId(null);
                  setReviewSelected(new Set());
                  await refresh();
                }}
                disabled={reviewSelected.size === 0}
                icon={<Save size={12} />}
              >
                Save {reviewSelected.size}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  const sid = reviewPending.sessionId;
                  setReviewId(null);
                  setReviewSelected(new Set());
                  navigate(`/chat/${sid}`);
                }}
              >
                Open chat
              </Button>
            </>
          ) : null
        }
      >
        {reviewPending && (
          <ul className="space-y-1">
            {reviewPending.facts.map((f, i) => (
              <li key={i} className="bg-surface-1 border border-border rounded-md p-2">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={reviewSelected.has(i)}
                    onChange={(e) => {
                      const next = new Set(reviewSelected);
                      if (e.target.checked) next.add(i);
                      else next.delete(i);
                      setReviewSelected(next);
                    }}
                    className="accent-[var(--color-accent)] mt-1"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant={KIND_VARIANT[f.kind] ?? "warn"}>
                        {KIND_LABEL[f.kind as KindFilter] || f.kind}
                      </Badge>
                      {f.title && <span className="text-xs font-medium text-text">{f.title}</span>}
                    </div>
                    <div className="text-xs text-text-muted leading-relaxed break-words">{f.content}</div>
                    {f.tags && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {f.tags.split(",").map((t, j) => t.trim()).filter(Boolean).map((t, j) => (
                          <span
                            key={j}
                            className={`${CHIP} border-border bg-surface-2 text-text-subtle`}
                          >
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
