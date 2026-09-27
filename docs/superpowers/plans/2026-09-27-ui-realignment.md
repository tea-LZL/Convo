# UI Realignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the UI tell the truth about what the application now is — a memory-first client whose recall and revision both run in Rust — and give the user the two surfaces that make that auditable: why a memory was recalled, and whether semantic recall is working at all.

**Architecture:** The backend is finished. `plan_send` assembles the prompt on every send, the revision table is the live extraction path, and `memory_recall` / `knowledge_index_status` are registered commands with no UI caller. This plan adds those callers, reorders the nav to match spec §9, and adds a Settings → Knowledge section for the five knobs whose config readers actually exist.

**Tech Stack:** React 19 + Zustand + Tailwind (theme aliases only), Tauri IPC via `src/lib/api.ts`, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-27-convo-realignment-design.md` — §9 (UI realignment), §6.3 (why recalled), §6.4 (degradation), Phase 8. **The spec is the authority; this plan is the decisions it does not make.**

## Global Constraints

- **TypeScript test floor: 378 passing, 0 failures.** It may only rise. Rust floor: **275 passing**, and it may only rise.
- Gates: `npm run typecheck`, `npm run test:run`, `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.
- **Never hardcode a hex colour.** Every colour is a CSS custom property from `src/styles/globals.css` exposed as a Tailwind alias in `tailwind.config.js` — `bg-surface-1`, `bg-surface-2`, `text-muted`, `border-border`, `text-accent`, `text-danger`, `text-success`, `bg-surface-3`. User themes override the variables; a literal hex ignores them.
- **No new dependency.** No new npm package, no new crate.
- **No settings knob without a Rust config reader.** Five exist: `memory.top_k`, `memory.context_budget_fraction`, `memory.routing` (embedding and extraction model+provider), `memory.auto_extract`, `memory.embed_all_notes`. A sixth, `EXTRACT_EVERY_N_EXCHANGES`, does **not** exist — the trigger is a hardcoded `gen >= 2` at `src/stores/chatStream.ts:372`. A UI control for a key nothing reads is the dead-surface defect this project has now hit three times; do not ship one.
- Named exports. 2-space JSX indentation. Import order React → third-party → local.
- Tests accompany behaviour, not markup. A test that asserts a class string is not a test.

## Review Focus

1. **No embedding model configured.** The most likely first-run state. The Memory tab must say semantic recall is off and why — silently degrading to keyword-only is how a user concludes their memory is broken. → Task 3.
2. **The index is stale because the embedding model changed.** A different problem with a different fix. `needsReindex` must be distinguishable from `needsEmbedding` in the UI, not merged into one number. → Task 3.
3. **A query that shares no words with any memory.** Returns nothing. The panel must show that plainly rather than rendering an empty box that looks broken. → Task 3.
4. **A memory the user excluded from this chat, whose note they also expect.** Scoping a chat to memories silently drops that chat's notes from keyword recall, because the allowlist holds memory ids only. The scoping UI must say so, or it is a lie. → Task 4.
5. **Settings with a stale value.** The Knowledge section reads five keys on mount. A key that fails to read must not render as `0`, `false`, or an empty string that then gets written back. → Task 2.

---

## What is deliberately NOT in this plan

Each of these needs Rust that does not exist yet, or a product decision that is not a patch. Deferred rather than stubbed.

- **Per-message "memory used"** (spec §9). Requires a new Tauri event carrying the rows injected for one turn, plus a snapshot per message. This is the one genuinely valuable item being dropped, and it is dropped because a per-message prompt snapshot has privacy and storage consequences — persisted assistant messages would carry the user's memory contents. That is a design conversation, not a UI task.
- **`EXTRACT_EVERY_N_EXCHANGES` as a setting.** Needs a config reader, and "every N exchanges" is ambiguous across a session: per-session or global, and what happens to a session that has not reached N. A wrong guess silently stops extraction for some users.
- **Recency half-life and persisted kind filters as settings.** Need config readers; the constants exist and work. Low value until someone asks for a non-default.
- **`/remember` forcing extraction on a turn the trigger skipped.** Deferred from Task 5's scope: it needs a session-id that the chat input does not currently thread, and the same N-ambiguity as above.

## File Structure

**Created:**
- `src/routes/settings/KnowledgeSection.tsx` — the five live knobs plus a link to the recall panel.
- `src/components/memory/RecallPanel.tsx` — test-recall input, results, why-recalled reasons.
- `src/components/memory/IndexStatusBanner.tsx` — semantic-recall state, index staleness.
- `src/components/memory/SupersedeHistory.tsx` — superseded rows and their replacements.

**Modified:**
- `src/components/sidebar/Sidebar.tsx` — nav order.
- `src/routes/SettingsRoute.tsx` — register the Knowledge section.
- `src/routes/MemoryRoute.tsx` — mount the panel, banner, and history.
- `src/routes/NotesRoute.tsx` — "add to chat".
- `src/components/chat/ChatViewNew.tsx` — mount the status strip.
- `src/lib/api.ts` — nothing new; `memoryRecall` and `knowledgeIndexStatus` wrappers already exist and are uncalled.
- `src-tauri/src/commands/memory.rs` — add `superseded_by` to `list_memory`'s SELECT and to `MemoryItem`.
- `src-tauri/src/db/models.rs` — `MemoryItem.superseded_by`.
- `docs/superpowers/specs/2026-09-27-convo-realignment-design.md` — tick Phase 8.

---

### Task 1: Nav order and default landing

Spec §9 fixes the order: Chat, Notes, Memory, Compare, Documents, Tasks. It is currently
Chat, Compare, Documents, Notes, Tasks, Memory. This is the most visible mismatch between what
the app is and what it looks like, and it costs one array literal.

**Files:**
- Modify: `src/components/sidebar/Sidebar.tsx` (the nav array, currently `chat, compare, documents, notes, tasks, memory`)
- Test: `src/components/ui/__tests__/RouteShell.test.tsx` and/or a Sidebar test

**Interfaces:**
- Consumes: nothing.
- Produces: nav order `chat, notes, memory, compare, documents, tasks`. No route path changes — `/notes` and `/memory` already exist and must keep working, so every bookmark survives.

- [ ] **Step 1: Write the failing test**

Read the existing Sidebar or RouteShell test for its conventions first. Assert the rendered order of nav items by their accessible names, as a single ordered list — not as five independent `getByText` calls, which pass in any order and so would not catch this at all.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:run -- RouteShell`
Expected: FAIL on ordering.

- [ ] **Step 3: Reorder the array**

Reorder the `NAV` array (or whatever it is named) to the spec order. Change nothing else — no icons, no paths, no labels.

- [ ] **Step 4: Confirm and run the gates**

Run: `npm run test:run -- RouteShell && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git commit -m "feat(nav): Chat, Notes, Memory, Compare, Documents, Tasks

Spec section 9 fixed this order; the sidebar had Compare and Documents
above Notes and Memory, which made a memory-first client look like a
documents tool with a memory page buried under Tasks. Paths are
unchanged, so bookmarks survive."
```

---

### Task 2: Settings → Knowledge

The five knobs whose Rust readers exist. Nothing more: a control for a key nothing reads is
the dead-surface defect, and there is a `EXTRACT_EVERY_N_EXCHANGES` setting in the spec that
has no reader at all.

**Files:**
- Create: `src/routes/settings/KnowledgeSection.tsx`
- Modify: `src/routes/SettingsRoute.tsx` (add the `SettingsLink` and the `section === "knowledge"` render, alphabetical among the section list)
- Test: `src/routes/settings/__tests__/KnowledgeSection.test.tsx`

**Interfaces:**
- Consumes: `api.getSetting(key): Promise<string | null>` and `api.setSetting(key, value)`. Existing `Switch`, `TextInput`, `Select` from `src/components/ui/Form`.
- Produces: keys `memory.top_k` (int, default 6), `memory.context_budget_fraction` (0–1, default 0.15), `memory.auto_extract` (bool-ish: only the literal string `false` disables — read `config::auto_extract` in `src-tauri/src/memory/config.rs` before writing the copy, because "unset means on" is the rule and a checkbox defaulting to off would be wrong), `memory.embed_all_notes` (bool), `memory.routing` (JSON — see below).

- [ ] **Step 1: Read before writing**

Read `src-tauri/src/memory/config.rs` for the exact key names, the accepted formats, and what an absent or malformed value falls back to. Read `src/routes/settings/ModelsSection.tsx` for the section's house style, and `src/routes/SettingsRoute.tsx` for how the other sections are registered. The `memory.routing` value is a JSON blob written by a helper — find whether one already exists in `src/lib/api.ts` or `src-tauri/src/commands/knowledge.rs` before inventing a shape.

- [ ] **Step 2: Write the failing tests**

Cover: each knob renders its stored value; changing one writes the right key with the right serialisation; a key that fails to read renders as the documented fallback and is **not** written back on mount. That last one is Review Focus 5 and is the test most likely to be missing by accident.

- [ ] **Step 3: Implement**

Follow the existing section pattern: read on mount, render, write on change, and do not write on mount. For `memory.routing`, if no helper exists, add one that parses the existing shape and round-trips it without reformatting a value it did not change.

- [ ] **Step 4: Run the gates**

Run: `npm run typecheck && npm run test:run`
Expected: all green, 378 + your new tests.

- [ ] **Step 5: Commit**

```
git commit -m "feat(settings): a Knowledge section for the knobs that exist

Five settings, each with a config reader in memory/config.rs: recall
topK, the context budget fraction, automatic extraction, embedding all
notes, and the embedding/extraction model routing.

The spec also lists EXTRACT_EVERY_N_EXCHANGES. It has no reader — the
trigger is a hardcoded gen >= 2 — so there is no control for it here. A
setting that nothing reads is worse than a missing one: it looks
configured, and it is not."
```

---

### Task 3: Semantic status and the test-recall panel

The two commands that exist and nothing calls. Together they are what makes the retrieval
system auditable, and their absence is why a user with no embedding model has no way to know
recall is degraded.

**Files:**
- Create: `src/components/memory/IndexStatusBanner.tsx`, `src/components/memory/RecallPanel.tsx`
- Modify: `src/routes/MemoryRoute.tsx` (mount both, above the list)
- Test: tests for both components

**Interfaces:**
- Consumes: `api.knowledgeIndexStatus(): Promise<KnowledgeIndexStatus>` → `{ memoryCount, noteCount, embeddedCount, needsEmbedding, needsReindex, embeddingModel, semanticNote }`. `api.memoryRecall(query, sessionId?, topK?, kinds?): Promise<RankedMemory[]>` → `{ ownerType, ownerId, kind, title, content, score, reason }`.
- Produces: both components, self-contained, no new store.

- [ ] **Step 1: Read before writing**

Read the two Rust commands in `src-tauri/src/commands/knowledge.rs` so the field semantics are right, not guessed. In particular `semantic_note` is already a user-facing sentence produced in Rust — **render it, do not rewrite it.** A second wording of the same warning in TypeScript is how the two drift apart.

- [ ] **Step 2: Write the failing tests**

Cover Review Focus 1, 2, and 3:
- no embedding model → the banner shows `semanticNote`, and does **not** claim recall is working;
- `needsReindex` true → a distinct message from `needsEmbedding > 0`; the two must not render the same string;
- a recall returning `[]` → an explicit "nothing matched" state, not an empty region;
- a recall returning hits → each row shows its `reason` verbatim. The reason is built in Rust from route, recall count, and age; it is the audit trail, so truncating or rewording it defeats the panel.

- [ ] **Step 3: Implement**

`IndexStatusBanner` fetches on mount and after any pin/toggle mutation. Render nothing at all when there is no problem and no configuration to show — a permanent banner on a healthy index is noise. `RecallPanel` takes a query, calls `memoryRecall`, and renders owner type, kind, title, content, score, and reason.

Use `text-muted` and `border-border` for the chrome; `text-danger` for a degraded state only if such an alias exists in `tailwind.config.js` — check before using it, and use the nearest existing alias if not.

- [ ] **Step 4: Run the gates**

Run: `npm run typecheck && npm run test:run`
Expected: green.

- [ ] **Step 5: Commit**

```
git commit -m "feat(memory): why-recalled, and whether semantic recall works

memory_recall and knowledge_index_status have been registered commands
with no caller since they landed, so a user with no embedding model got
keyword-only recall and no indication of it. The panel renders the
reason string from Rust verbatim: it names the routes that matched, how
often the item has been recalled, and how old it is, and a second
wording in TypeScript is how the two drift.

The banner renders Rust's semantic_note rather than rewording it, and
says nothing when the index is healthy."
```

---

### Task 4: Supersede history, and an honest scoping control

Two spec items that share a root cause: the user cannot see what the system already decided.

**Files:**
- Create: `src/components/memory/SupersedeHistory.tsx`
- Modify: `src-tauri/src/commands/memory.rs` (add `superseded_by` to `list_memory`'s SELECT and to `MemoryItem`), `src-tauri/src/db/models.rs`, `src/lib/api.ts` (`MemoryItem.superseded_by`), `src/routes/MemoryRoute.tsx`, `src/components/chat/SessionMemoryModal.tsx`
- Test: tests for each

**Interfaces:**
- Consumes: `MemoryItem` gains `superseded_by: string | null`, which is **not** currently selected by any `memory_items` reader — `NoteLink` has the field, `MemoryItem` does not. This is the one place this plan touches Rust, and it is two lines, because a history UI that always reads "no history" is the dead-surface defect again.
- Produces: a superseded row renders struck through with its replacement's title, and the replacement is reachable.

- [ ] **Step 1: Write the failing Rust test**

A superseded memory and its replacement, listed together, with `superseded_by` populated on the old one. Assert through `list_memory`'s reader so the test fails if the column is dropped from the SELECT again.

- [ ] **Step 2: Add the column and run the Rust gates**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --all && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: green, 275 + 1.

- [ ] **Step 3: Write the failing frontend tests**

- a superseded row renders struck through and names its replacement;
- a live row renders neither;
- **Review Focus 4:** the scoping modal states that scoping a chat to memories also removes that chat's notes from recall, because the session allowlist holds memory ids only. Verify that claim in `note_bm25` in `src-tauri/src/memory/retrieve.rs` before writing the copy — if it is not true, do not add the sentence.

- [ ] **Step 4: Implement and run the gates**

Run: `npm run typecheck && npm run test:run && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: green.

- [ ] **Step 5: Commit**

```
git commit -m "feat(memory): supersede history, and an honest scoping control

A supersede keeps the old row and points it at its replacement rather
than deleting it, so the history of a correction stays readable — and
nothing showed it, because no memory_items reader selected
superseded_by. Two lines of Rust; the alternative was a history panel
that always read empty.

The scoping modal also says that scoping a chat to memories removes that
chat's notes from recall. It does: note_bm25 answers to the same
allowlist, and the allowlist holds memory ids only. Pre-existing, and
previously invisible."
```

---

### Task 5: "Add to chat" from Notes, and a slash command for memory

Spec §9 gives Notes an "add to chat" affordance. Chat gets `/remember`.

**Files:**
- Modify: `src/routes/NotesRoute.tsx`, `src/components/chat/ChatInput.tsx` (or wherever input is handled)
- Test: tests for each

**Interfaces:**
- Consumes: `api.memoryExtractAndRevise` already exists. "Add to chat" needs no backend at all: append the note's body to the chat input's draft and let the user send it.
- Produces: a per-note action and a built-in slash command.

- [ ] **Step 1: Read before writing**

Find how the chat input holds its draft and how built-in commands are dispatched. Note that `src-tauri/src/commands/slash.rs` is **user-defined** commands with stored bodies, not a built-in registry — a built-in is a frontend concern unless a different mechanism already exists. Read `ChatInput.tsx` before assuming how `/` is handled today.

- [ ] **Step 2: Write the failing tests**

- "add to chat" puts the note body in the draft and does not send it;
- `/remember` triggers `memoryExtractAndRevise` for the current session and reports through the same `reportRevisions` path the automatic trigger uses, so a user sees the same "2 remembered, 1 needs review" toast;
- an unknown slash command still behaves as it does today.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the gates**

Run: `npm run typecheck && npm run test:run`
Expected: green.

- [ ] **Step 5: Commit**

```
git commit -m "feat(notes,chat): add-to-chat, and /remember

Both are frontend: add-to-chat needs no backend, and /remember calls the
memory_extract_and_revise command the automatic trigger already uses, so
it reports through the same toast rather than inventing a second one."
```

---

### Task 6: Test sweep and the Phase 8 close-out

**Files:**
- Modify: existing test files as needed
- Modify: `docs/superpowers/specs/2026-09-27-convo-realignment-design.md`

- [ ] **Step 1: Route and accessibility pass**

Run the full suite. Then check every surface changed in Tasks 1–5 for: a reachable accessible name on every interactive element, keyboard operability of the new controls (the pin and recall-panel inputs especially), and a visible focus style that uses a theme alias rather than a literal colour.

- [ ] **Step 2: Check the deferred list is still true**

Re-verify that `EXTRACT_EVERY_N_EXCHANGES`, recency half-life, and kind filters still have no config readers, and that the per-message "memory used" event still does not exist. If any of them was added in the meantime, the deferral note in this plan is stale and the spec should say so.

- [ ] **Step 3: Tick Phase 8 honestly**

Tick only the boxes that are actually done. **Leave unticked**: per-message "memory used" (needs a Rust event and a storage decision about memory contents in persisted messages), and the `EXTRACT_EVERY_N_EXCHANGES` setting (no reader). A ticked box on deferred work is how a future plan trusts a claim nobody verified.

- [ ] **Step 4: Run every gate**

Run: `npm run typecheck && npm run test:run && npm run build && cargo test --manifest-path src-tauri/Cargo.toml && cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: all clean.

- [ ] **Step 5: Commit**

```
git commit -m "docs: close out Phase 8, minus the two items that need Rust

Per-message memory-used and EXTRACT_EVERY_N_EXCHANGES stay unticked. The
first needs a new event and a decision about whether memory contents
belong in persisted assistant messages; the second needs a config reader
and a definition of what N counts."
```

---

## Not in this plan

- **Release gates (Phase 9).** Signed installer, updater, release checklist.
- **The extraction-failure visibility gap.** `memory_extract_and_revise` returns `[]` both when extraction found nothing and when the model was unreachable, so a broken extraction setup is a silent no-op. It needs a Rust change to distinguish them and a product decision about what the user sees. Highest-value item still open, and it is not a UI task.
- **`memoryRecall` and `knowledgeIndexStatus` in any other surface.** Task 3 mounts them in the Memory tab. The spec's "settings strip" in Chat is the same information in a second place; two copies of a status message is one too many, and the ledger should say which was chosen.
