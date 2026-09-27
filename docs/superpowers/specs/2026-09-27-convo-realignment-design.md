# Convo Realignment — Memory-First Ollama Chat Client

**Date:** 2026-09-27
**Status:** Design approved. Supersedes `.hermes/plans/2026-08-30_113649-convo-release-readiness-knowledge-skill-curation.md` (discarded).
**Branch:** new branch from `main`. `main` stays runnable and testable for the whole rewrite.

---

## 1. Goals

Convo is a **memory-first chat client for Ollama** — local and cloud. Chat is the product.

**Success criteria, in priority order:**

1. Every turn recalls relevant memory, or correctly recalls nothing.
2. Durable facts are extracted, revised, and consolidated without user babysitting.
3. Notes are agent-writable, live under the Notes tab, and are recallable in chat.
4. Ollama cloud works for chat, extraction, **and** embeddings.

**Success is measured, not asserted.** Concrete gates in §11.

---

## 2. Non-goals (locked)

Drift back into these requires a new explicit decision, not a side quest.

- No MCP, no tool-calling, no agent loop, no terminal, no file-editing agent, no git.
- No code-execution sandbox.
- No cloud sync, no auto-updater, no plugin API.
- **No feature deletions.** Compare, Documents, Tasks, web search, slash commands, backup/restore, Hardware scan, Diagnostics all stay. Nav is reordered (§9) so the memory path leads. This is a de-prioritization, not a purge.

---

## 3. Current state (assessed 2026-09-27)

Ground truth, so the todos fix real things.

**Drift is feature sprawl, not agent-ification.** No MCP, no tool-calling, no terminal, no git tooling exists. The provider layer is plain chat. The problem is 6 nav tabs of unrelated features with the memory core as the weakest one.

**Memory recall is a browser-side substring scorer.** `src/stores/chatStream.ts:750-767` scans the full enabled-memory array per send: `contentLower.includes(w)` scoring, title weighted 2×, `topK` hardcoded 3, 20 hardcoded stopwords, min token length 2. No index, no IDF, no vectors.

**FTS5 exists but is not used for recall.** `memory_fts` (`V002__fts_and_skills.sql:24-31`) is wired only to the Memory page search box (`src-tauri/src/commands/memory.rs:139-167`). Recall never touches it.

**Zero embeddings.** No `/api/embed` call, no vector column, no embedding model in the pull catalog.

**Rust never reads `memory_items` on a chat send.** The whole recall path is frontend; `chat_stream.rs:181` passes `system` through verbatim.

**Every retrieval constant is a literal at its use site.** No config for topK, thresholds, decay, or embedding model.

**Extraction is the one solid subsystem.** LLM-based (`memory.rs:560`), `temperature: 0.1`, defensively parsed against 14 alias keys, 3 canonical kinds, bounded `<think>`-span JSON recovery (`memory.rs:266-399`). But: it writes **nothing** automatically (human review queue only), has no revision/consolidation, is capped at 60 messages with no token budget, and is gated on a hardcoded `gen >= 2` (`chatStream.ts:355`).

**No revision of any kind.** One mechanism: exact `(kind, content)` equality on insert. No merge, no supersede, no decay, no access counting, no contradiction detection.

**Notes are dead weight.** `commands/notes.rs` is CRUD plus `LIKE '%q%'` search. Notes are never recalled into chat, never pinned, have no provenance links.

**Recall is a black box and silently self-suppresses.** Two different `<memory-context>` blocks with contradictory directives exist (`stores/memory.ts:179-184` vs `chatStream.ts:780-787`), and recall items whose content is a substring of the always-on block are dropped (`chatStream.ts:770-772`) — an undocumented heuristic that costs recall.

**Streaming is load-bearing and expensive.** ~8 commits and 4 version tags (v0.6.5 → v0.7) to land. `chatStream.ts` 824 lines, `streamingRenderer.ts` 222 lines of hand-rolled DOM-direct rendering, `streamingSegmenter.ts` 224 lines.

**Docs conflict.** `AGENTS.md` says 107 tests, `RELEASE_CHECKLIST.md` says 252. README claims all 7 phases complete while manual install gates are unchecked. The origin statement survives only at `AboutRoute.tsx:28-30`.

---

## 4. Target architecture

**Rust owns all intelligence. TypeScript is a view.**

```
┌─ Tauri commands ────────────────────────────────────────────┐
│  memory_recall(query, sessionId) -> RankedMemory[]          │
│  memory_extract(sessionId) -> ExtractionOutcome             │
│  memory_revise(candidateId) -> RevisionOutcome              │
│  note_upsert / note_pin / note_unlink_memory                │
│  list_notes / list_memory / search_knowledge                │
└─────────────────────────────────────────────────────────────┘
        │
        ├── memory/index.rs      embed + store vectors
        ├── memory/retrieve.rs   BM25 ⊕ cosine ⊕ RRF ⊕ boost
        ├── memory/extract.rs    LLM candidate generation
        ├── memory/revise.rs     ADD / REINFORCE / SUPERSEDE / MERGE
        ├── memory/context.rs    single budgeted context block
        └── providers/           ollama local + ollama cloud + /api/embed
        │
        └─── SQLite: memory_items, notes, memory_embeddings,
                     memory_events, memory_fts (shared)

┌─ TypeScript ────────────────────────────────────────────────┐
│  stores/chatStream.ts   stream state (from scratch, §8)     │
│  routes/                Chat, Notes, Memory, review inbox    │
│  lib/api.ts             thin IPC wrappers                   │
└─────────────────────────────────────────────────────────────┘
```

**Boundary rule:** prompt assembly happens in Rust. The frontend passes raw user input and renders returned context. No retrieval logic in TypeScript.

---

## 5. Unified index — one index, two views

Retrieval cannot distinguish a memory from a note. The UI can.

### 5.1 Migration `V006__unified_index.sql`

Additive only. No destructive changes to V001–V005.

```sql
-- embeddings, shared by memories and notes
CREATE TABLE memory_embeddings (
    id          TEXT PRIMARY KEY,      -- uuid of the owner row
    owner_type  TEXT NOT NULL,         -- 'memory' | 'note'
    owner_id    TEXT NOT NULL,
    model       TEXT NOT NULL,         -- e.g. 'nomic-embed-text'
    dim         INTEGER NOT NULL,
    vec         BLOB NOT NULL,         -- f32 little-endian, dim * 4 bytes
    created_at  TEXT NOT NULL
);
CREATE INDEX idx_emb_owner ON memory_embeddings(owner_type, owner_id);
CREATE INDEX idx_emb_model ON memory_embeddings(model);

-- access log → reinforcement + recency decay
CREATE TABLE memory_events (
    id          TEXT PRIMARY KEY,
    owner_type  TEXT NOT NULL,
    owner_id    TEXT NOT NULL,
    event       TEXT NOT NULL,         -- 'recall' | 'extract' | 'reinforce'
    session_id  TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX idx_events_owner ON memory_events(owner_type, owner_id, event);

-- extend memory_items
ALTER TABLE memory_items ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;
ALTER TABLE memory_items ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_items ADD COLUMN last_seen_at TEXT;
ALTER TABLE memory_items ADD COLUMN superseded_by TEXT;        -- excluded from recall
ALTER TABLE memory_items ADD COLUMN source_note_id TEXT;        -- provenance
ALTER TABLE memory_items ADD COLUMN source_session_id TEXT;
ALTER TABLE memory_items ADD COLUMN token_count INTEGER;

-- extend notes
ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN token_count INTEGER;
ALTER TABLE notes ADD COLUMN source_note_id TEXT;

-- kind taxonomy expansion: 'user_pref' | 'project_fact' | 'decision'
--                     | 'constraint' | 'skill' | 'entity'
```

### 5.2 Shared FTS5

`memory_fts` becomes the index for both. Notes are added as an external-content row set. Columns weighted `title > tags > content` via `columnsize`/rank config so a title hit outranks a body hit — today BM25 is never used for recall, so there is no regression risk in retuning it.

### 5.3 Views

| View | Filter | Reaches |
|---|---|---|
| Memory tab | `owner_type = 'memory'` | ranked list, why-recalled, edit, disable, supersede history |
| Notes tab | `owner_type = 'note'` | long-form editor, pin toggle, linked memories, "add to chat" |
| Recall | both, kind-agnostic | budgeted context block |

### 5.4 Provenance

Bidirectional. A note records `linked_memory_ids`; a memory records `source_note_id`. The Notes tab shows "this note produced 3 memories"; the Memory tab shows "from note: <title>".

---

## 6. Retrieval

Replaces `chatStream.ts:736-787` entirely. The frontend's `recallMemories` and `stores/memory.ts buildContextBlock` are **deleted**.

### 6.1 Pipeline

```
query = last user message (trimmed to 2000 chars for embedding)
  1. embed query            /api/embed → vec_q
  2. BM25 top-30           FTS5, field-weighted
  3. cosine top-30         memory_embeddings, same model
  4. RRF fuse              score = Σ_routes 1 / (60 + rank)
  5. filter                is_enabled, not superseded, session overrides, kind filters
  6. boost                 recency + reinforcement
  7. MMR dedupe            λ = 0.7, drop near-identical restatements
  8. cap                   topK = 6, token budget = 15% of model ctx
  9. return                id, kind, owner_type, title, content, score, reason
```

### 6.2 Constants (all in Rust `config.rs`, all user-overridable in Settings)

| Constant | Default | Notes |
|---|---|---|
| `RRF_K` | `60` | Cormack et al. standard |
| `BM25_LIMIT` | `30` | per-route candidate depth |
| `COSINE_LIMIT` | `30` | per-route candidate depth |
| `TOP_K` | `6` | was hardcoded 3 |
| `REINFORCE_FLOOR` | `0.72` | below → ADD |
| `DUP_FLOOR` | `0.92` | above → revise decision |
| `RECENCY_HALF_LIFE_DAYS` | `30` | on `updated_at` |
| `CONTEXT_BUDGET_FRACTION` | `0.15` | of model context length |
| `MIN_CONTENT_LENGTH` | `32` chars | shorter items are not embedded |

**Scoring, explicit:**
```
final = RRF_score
      × (1 + 0.15 × min(access_count, 10))          reinforcement, capped
      × 0.5^(age_days / 30)                          recency decay
```

Reinforcement is capped at 10 so a frequently-recalled item cannot permanently dominate. Recency decay is a multiplier in `[0.5, 1.0]`, not a hard filter — old-but-relevant still surfaces.

### 6.3 "Why recalled"

Every returned row carries a human-readable `reason` string, e.g. `matched "postgres" in title · recalled 7× · updated 4 days ago`. Rendered in the Memory tab and in a per-message "memory used" affordance. Today recall is opaque, which is exactly how the self-suppression bug survived.

### 6.4 Degradation

| Condition | Behavior |
|---|---|
| No embedding model configured | BM25-only. UI banner: "Semantic recall off — pull an embedding model." |
| Embedding call fails / cloud down | BM25-only for that turn, log a warning, do not fail the send |
| Index empty | No `<memory>` block emitted at all |
| Model or dim changed | Rows whose `model`/`dim` mismatch are excluded and queued for reindex |

Recall must never block or fail a send. BM25-only is a degraded success, not a failure.

---

## 7. Extraction + revision

### 7.1 Trigger

- Automatic: every `EXTRACT_EVERY_N_EXCHANGES` (default 2), replacing the hardcoded `gen >= 2` gate.
- Manual: `/remember`, or the Memory tab's extract button.
- Never in the first exchange of a session.
- Uses a watermark (`sessions.last_extracted_message_id`), not a generation counter, so history-truncated sessions extract correctly.

### 7.2 Extraction window

Last 40 messages **or** 6000 estimated tokens, whichever is smaller, ending at the watermark. This replaces the current blind `LIMIT 60` (`memory.rs:483`).

### 7.3 Candidate schema

```json
[{ "kind": "decision|constraint|user_pref|project_fact|skill|entity",
   "title": "…", "content": "…", "tags": "csv", "confidence": 0.0–1.0,
   "is_note": false, "note_body": null }]
```

`is_note: true` routes a long-form or structured candidate into the Notes tab instead of memory. This is how the agent writes notes during a session.

The existing defensive parser (`memory.rs:266-399`) is **retained**, not rewritten. It encodes real observed local-model failure modes. It is re-targeted at the new schema, not replaced.

### 7.4 Revision decision table

For each candidate, embed it, cosine against enabled memories:

| Cosine | Condition | Action | Gate |
|---|---|---|---|
| `< 0.72` | — | **ADD** | auto if `confidence ≥ 0.80`, else review |
| `0.72–0.92` | — | **REINFORCE** (bump `access_count`, `last_seen_at`, union tags) | auto |
| `≥ 0.92` | `IDENTICAL` | **REINFORCE** | auto |
| `≥ 0.92` | `CONTRADICTS` | **SUPERSEDE** — old row gets `superseded_by`, excluded from recall, retained for history | auto if `confidence ≥ 0.85` |
| `≥ 0.92` | `COMPLEMENTS` | **MERGE** — LLM writes merged text | auto if `confidence ≥ 0.85` |
| any | parser failure, or judge unavailable | — | review |

The `IDENTICAL / CONTRADICTS / COMPLEMENTS` verdict comes from one cheap LLM call receiving both texts. It fires only on near-duplicates, so it is not on the per-turn hot path.

**Extraction model routing:** uses the configured `extraction_model` (provider + model), defaulting to the session's own model, overridable in Settings to a smaller local model. Cloud is allowed.

### 7.5 Review inbox

Replaces `pending_memory_reviews` (`V004`). Migration V006 backfills in-flight rows; the `session_id UNIQUE` one-shot constraint is dropped in favour of a watermark, so a session can accumulate multiple extraction rounds. The inbox shows the proposed diff and the revision verdict, not just raw candidates.

---

## 8. Streaming rewrite (from scratch)

Approved as a rewrite. Streaming is the highest-risk area in the plan, so it is gated hardest and rebuilt first.

### 8.1 Design

```
src/stores/chatStream.ts
  zustand store becomes the single source of truth — drop the
  module-Map + version/bump mirror so no mutation site can forget a bump
  keeps the rAF chunk batching and the generation-counter cancel

src/components/chat/
  StreamingTail.tsx    the only component that re-renders at 60fps
  MarkdownRenderer    the ONE renderer: streaming tail and settled messages
  markdownBlocks.ts   pure source block splitter; only the tail re-parses
```

**Unify onto one renderer.** As of 2026-09-27 the app has two: `src/lib/markdown.ts` `renderMarkdown` (hand-rolled regex → HTML string, no GFM, no highlighting, inline `style=` attributes) renders the live tail, and `src/components/chat/MarkdownRenderer.tsx` (`react-markdown` + remark-gfm + Prism + copy button) renders settled messages. `StreamingSection` finalizes, unmounts, and `ChatViewNew` re-renders from source — so **every completed message visibly restyles itself the moment its stream ends.** The rewrite puts the streaming path on `MarkdownRenderer` too, which makes render parity structural rather than something a golden-file test has to police.

**Dropped:** `src/lib/streamingRenderer.ts` (222 lines, hand-rolled DOM) and `src/lib/streamingSegmenter.ts` (224 lines), replaced by a ~60-line pure source block splitter. The segmenter's `cutIsRenderSafe` self-verification exists because it splits *rendered output*; splitting *source blocks* and letting React memoize each one needs no such proof.

**Kept:** `src/lib/markdown.ts` off every render path, retained as the pure test oracle for the splitter alongside its 19 tests. Removal deferred.

**Preserved:** the app-lifetime listener registration, the per-session state map that survives session switching, the generation-counter cancel, the rAF chunk batching, and the three-module responsibility split (store / component tree / render).

### 8.2 Invariants — all asserted by tests, none by inspection

1. **Frozen rows never re-render during streaming.** Test counts renders of a frozen `MessageRow` before and during a stream; delta must be 0.
2. **Tail sustains 60fps.** Test drives a 4,000-token stream and asserts rAF frame count within budget.
3. **Cancel is immediate, no orphan chunks.** Test cancels mid-stream and asserts no further store writes.
4. **Output parity between the streaming tail and the settled message.** Not byte-comparison against the old renderer — the new tail and the settled message both render through `MarkdownRenderer`, so parity is structural. Assert that for a ~20-shape markdown corpus (code fences, nested lists, GFM tables, `<think>` blocks, partial fences, mismatched fence lengths) the streamed and settled renders are structurally identical, **and** that crossing the streaming→settled boundary does not change the markdown subtree. This is the safety net for the rewrite and it must pass before the old code is removed. It also pins the "message restyles on finalize" defect as fixed.
5. `MessageRow` custom comparator is preserved and extended for any new prop — the v0.6.5 lag regression guard.
6. **Corrected (non-append-only) stream content renders correctly.** The old renderer documented an append-only precondition and silently left stale frozen blocks when a provider re-sent corrected text. The new path re-derives from source every render, so this holds structurally and is pinned by a test.

### 8.3 Test count floor

The suite is **263 tests** today (verified 2026-09-27). `AGENTS.md` said 107 and `docs/RELEASE_CHECKLIST.md` said 252 — both were wrong; both are corrected by this work. The rewrite may drop by exactly the tests belonging to deleted modules (19: 7 in `streamingRenderer.test.ts`, 9 in `streamingSegmenter.test.ts`, 3 in the Task 2 `streamingParity.test.ts` harness, whose subject is deleted with it) and no more, and adds the invariants above. No test is deleted to make a gate pass; obsolete tests for deleted modules are removed only in the same commit that deletes the module.

---

## 9. UI realignment

No feature deletions. Nav order and default landing change.

| Position | Tab | Change |
|---|---|---|
| 1 | **Chat** | unchanged |
| 2 | **Notes** | promoted; gains pin toggle, linked memories, "add to chat" |
| 3 | **Memory** | promoted; gains why-recalled, supersede history, kind filters, extraction controls |
| 4 | Compare | demoted |
| 5 | Documents | demoted |
| 6 | Tasks | demoted |
| — | Settings / Hardware / Diagnostics / About | footer, unchanged |

**Chat additions:**
- Per-message "memory used" affordance showing the injected context for that turn.
- `/remember` slash command.
- A settings strip showing extraction status and semantic-recall state.

**Settings additions** (new `Knowledge` section): recall `topK`, context budget fraction, embedding model + provider, extraction model + provider, `EXTRACT_EVERY_N_EXCHANGES`, recency half-life, kind filters, test-recall panel.

Documents, Compare, and Tasks are **out of scope** for the memory rewrite and are not indexed. Stated explicitly so it is not mistaken for an oversight.

---

## 10. Provider layer

- **`ollama-cloud` preset:** base URL `https://ollama.com/api`, API key in the system keyring (reuses the V005 keyring pattern), authenticated `/api/tags`.
- **`/api/embed`** implemented for both local and cloud.
- **Per-capability routing.** Three independent settings — `chat_model`, `extraction_model`, `embedding_model` — each a provider+model pair. Local default; cloud opt-in. A user with cloud but no local embedding model is a first-class case: the cloud embedding model is used and the local index is built from it.
- Embedding rows record `model` + `dim`, so switching models triggers reindex of only the mismatched rows.

---

## 11. Phased todos

Every phase ends with `npm run typecheck`, `npm run test:run` (≥ 252 + new), `npm run build`, and `cargo check --manifest-path src-tauri/Cargo.toml` clean.

### Phase 0 — Foundation
- [ ] Create `realignment` branch from `main`; leave `main` untouched
- [ ] Write this spec + generated todos to `docs/superpowers/specs/`
- [ ] Mark the 2026-08-30 hermes plan superseded; archive, do not delete
- [ ] Reconcile the test count in `AGENTS.md` (107 → 252) and `README.md` roadmap claims
- [ ] Add `docs/GOALS.md` as the canonical product statement
- [ ] **Gate:** baseline suite green on the branch before any rewrite begins

### Phase 1 — Streaming rewrite
- [ ] Capture golden render outputs from `streamingRenderer.ts` for ~20 fixtures → `src/components/chat/__tests__/fixtures/`
- [ ] Write the 5 invariant tests (§8.2) **against the current implementation first** — tests that pass now and must pass after
- [ ] New `stores/chatStream.ts`: external store, rAF batching, generation-counter cancel
- [ ] `StreamingTail.tsx` + block-split markdown
- [ ] Wire `MessageList` / `ChatInput` / `ChatHeader` to the new store
- [ ] Delete `streamingRenderer.ts`, `streamingSegmenter.ts` and their tests
- [ ] **Gate:** golden-output parity + all 5 invariants + 60fps perf test

### Phase 2 — Unified index schema
- [ ] `V006__unified_index.sql` per §5.1
- [ ] Migration test: V001–V006 against a populated DB, assert no data loss
- [ ] Backfill in-flight review rows; drop the `session_id UNIQUE` one-shot constraint
- [ ] Rust `memory/config.rs` with every §6.2 constant
- [ ] `notes` and `memory_items` share the `memory_fts` index
- [ ] **Gate:** migration test on a populated DB, typecheck clean

### Phase 3 — Provider layer
- [ ] `ollama-cloud` preset + keyring auth
- [ ] `/api/embed` for local and cloud
- [ ] Per-capability model routing in settings and DB
- [ ] Embedding model reindex-on-change detection
- [ ] **Gate:** Rust + TS tests, `cargo clippy -D warnings` clean

### Phase 4 — Retrieval
- [ ] `memory/index.rs` — embed, store, reindex stale rows
- [ ] `memory/retrieve.rs` — BM25 ⊕ cosine ⊕ RRF ⊕ boost ⊕ MMR
- [ ] `memory_recall` command returning ranked rows with `reason`
- [ ] Known-answer test fixtures: 20 queries against a seeded corpus with expected top-3
- [ ] Recall-precision test: ≥ 90% of seeded relevant items in top-6
- [ ] Degradation paths: no embedder, cloud down, empty index, dim mismatch
- [ ] **Gate:** recall-precision test passes; degradation tests pass

### Phase 5 — Extraction + revision
- [ ] `memory/extract.rs` — watermark trigger, 40-msg/6k-token window, re-targeted defensive parser
- [ ] `memory/revise.rs` — the §7.4 decision table
- [ ] `IDENTICAL / CONTRADICTS / COMPLEMENTS` judge call
- [ ] SUPERSEDE sets `superseded_by` and excludes from recall, retains history
- [ ] `is_note` candidates route to the Notes tab
- [ ] Decision-table test: every row of §7.4 has a test
- [ ] **Gate:** decision table fully covered, extraction end-to-end test green

### Phase 6 — Notes
- [ ] `note_pin`, `note_unlink_memory`; pinned notes always injected
- [ ] Bidirectional provenance (§5.4)
- [ ] Notes never injected beyond the context budget (§12.3)
- [ ] **Gate:** note lifecycle tests, budget test

### Phase 7 — Context assembly
- [ ] `memory/context.rs` — single block, one directive, no contradictory duplication
- [ ] Precedence: pinned notes → pinned memories → session notes → retrieved topK
- [ ] Delete `chatStream.ts:736-787` (`recallMemories`) and `stores/memory.ts buildContextBlock`
- [ ] `chat_stream.rs` gains a memory-aware path; frontend passes raw input only
- [ ] Prompt-snapshot tests for the assembled block
- [ ] **Gate:** snapshot tests, typecheck, no retrieval logic left in TypeScript

### Phase 8 — UI
- [ ] Nav reorder + default landing (§9)
- [ ] Memory tab: why-recalled, kind filters, supersede history, extraction controls
- [ ] Notes tab: pin, linked memories, add-to-chat
- [ ] Review inbox: proposed diff + revision verdict
- [ ] Chat: per-message "memory used", `/remember`, settings strip
- [ ] Settings: new Knowledge section
- [ ] Route + a11y tests for every changed surface
- [ ] **Gate:** route smoke tests, axe pass, responsive pass

### Phase 9 — Release gates
- [ ] Full suite ≥ 252 + all new tests, 0 failures
- [ ] `cargo fmt`, `cargo clippy -D warnings`, `cargo test`
- [ ] Performance: 60fps tail, recall < 50ms p95 on a 5,000-item corpus
- [ ] Fresh-install and upgrade smoke on a populated DB
- [ ] Update `docs/GOALS.md`, `README.md`, `AGENTS.md`, `docs/KNOWN_LIMITATIONS.md` to the new truth
- [ ] **Gate:** all checks green, docs consistent

---

## 12. Risks

**1. Streaming rewrite regresses the v0.6.5–v0.7 fixes.** *Highest risk in the plan.* Mitigation: golden-output parity test (§8.2.4) must pass against the current renderer **before** deletion; the 5 invariants are written against the current implementation first. If parity cannot be achieved, stop and fall back to vendoring the current three modules unchanged.

**2. Full rewrite stalls and the old app rots.** Mitigation: `main` stays runnable and green; each phase is independently mergeable; no phase depends on a later one.

**3. Embedding model quality varies wildly across local models.** A 3B embedding model may rank worse than BM25 alone. Mitigation: the known-answer and recall-precision tests (§Phase 4) gate this. If a default embedding model fails them, the default flips to BM25-only and embeddings become opt-in. This is a designed outcome, not a failure.

**4. Consolidation compounds LLM errors.** A bad MERGE corrupts a memory that is then recalled forever. Mitigation: every MERGE and SUPERSEDE retains the prior text in history and is undoable; both are gated on `confidence ≥ 0.85`; borderline cases go to review.

**5. Ollama cloud API shape differs from local.** Mitigation: the cloud path is one provider implementation behind the same `Provider` trait; Phase 3 tests it independently before memory depends on it. Recall degrades to BM25-only if cloud is unreachable — never blocks a send.

**6. Scope creep returns.** Mitigation: §2 non-goals are the check. Any proposal touching MCP, tool-calling, an agent loop, a terminal, or file-editing requires a new explicit decision, recorded in `docs/GOALS.md`.

**7. 252 tests encode the old architecture.** Mitigation: obsolete tests are deleted only in the same commit as the module they test; the count must never drop.

---

## 13. Decisions taken (recorded so they are not relitigated)

| Decision | Choice | Why |
|---|---|---|
| Feature deletions | None — de-prioritize only | Owner decision. Sprawl is a nav problem, not a deletion problem |
| Notes vs memory | One index, two views | One place to tune retrieval |
| Retrieval | Hybrid FTS5 BM25 + Ollama embeddings, RRF fused | Only option that catches paraphrases and exact identifiers both |
| Write policy | Auto-apply with revision; review inbox for exceptions | "revise and extract without babysitting" |
| Taxonomy | Expanded to 6 kinds + note type | `decision` and `constraint` are the kinds that actually supersede |
| Ollama cloud | Cloud serves chat, extraction, and embeddings | Owner decision |
| Rewrite blast radius | Full app, including streaming | Owner decision, with §8.2 parity gate as the guard |
| Sequencing | New branch, `main` runnable | Rollback is a branch switch |
| Old plan | 2026-08-30 hermes plan discarded | It was written for the drifted product |
| Extraction parser | Retained, re-targeted | Encodes real local-model failure modes |
