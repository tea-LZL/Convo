# Plan — Polish non-Chat features for Convo v0.8

Audited 2026-07-05. Three features (Compare, Documents, Memory) are wired end-to-end but have
correctness bugs, missing polish, and zero tests. Below is a prioritized breakdown.

---

## Phase 1 — Correctness (bugs that produce wrong results)

### 1a. Fix wrong model list calls (Compare + Documents)

| File | Problem | Fix |
|---|---|---|
| `CompareRoute.tsx:49` | `api.listModels()` fetches ALL models across every provider. When `api.listModels()` is called inside a `ps.forEach()` loop, the results for provider `p.id` are wrong — the API returns the union of all providers' models which then get assigned to `modelsByProvider[p.id]`, polluting every provider's model list with every other provider's models. | Replace with `api.listModelsForProvider(p.id)` — matches what `ChatViewNew.tsx` already uses. |
| `DocumentsRoute.tsx` | Not directly affected (documents don't load models) | N/A |

**Verification:** Open Compare with 2+ providers. Confirm each provider's dropdown only shows its own models.

### 1b. DiffPreview empty-line-at-end bug (Documents)

In `DocumentsRoute.tsx:533`: `if (line === "" && j === lines.length - 1) return null;` drops the
trailing empty line but sometimes drops a meaningful line when the diff op ends with a newline.

**Fix:** Remove the trailing-empty-line filter — let the diff library decide what to emit.

### 1c. AI edit response code-fence stripping (Documents)

`documents.rs:169-178` strips leading `` ``` `` block but only checks the first parse attempt. If the
model adds *both* a leading fence and a trailing fence, or multiple fenced blocks, the result is
truncated or incorrectly stripped. Also doesn't strip if the model outputs just a language tag on
the first line without a fence.

**Fix:** Use a robust fence-strip helper (strip from surrounding, not just prefix/suffix).

### 1d. `<think>` escaping in Documents preview (same Bug 5 from chat)

`DocumentsRoute.tsx` `MarkdownPreview` uses `react-markdown` without `escapeThinkTags`. Any
`` tags in document content will be silently stripped in preview mode. Already fixed for
chat (`MessageRow.tsx`), need to apply the same escape here.

---

## Phase 2 — Functional gaps (features users expect)

### 2a. Markdown rendering for Compare column results

Compare results (`col.content`) are rendered as plain `<div className="whitespace-pre-wrap">` —
no markdown, no code highlighting, no inline formatting. Models produce rich markdown output,
and Compare should render it.

**Fix:** Replace the plain div with `MarkdownRenderer` (same component used in `MessageRow.tsx`).
Already supports `react-markdown` + `remarkGfm` + syntax highlighting.

**Risk:** Columns are inside a grid; `react-markdown` + `SyntaxHighlighter` overhead per column.
Mitigate: `MarkdownRenderer` is already React.memo, and compare columns don't re-stream — only
update on terminal events.

### 2b. Per-session memory overrides UI (Memory)

Backend fully supports `get_session_memory_overrides` / `set_session_memory_overrides` but no
frontend ever calls them. Users should be able to toggle which memory items are active for a
specific chat session without disabling them globally.

**Fix:**
1. Add a "Memory" tab/button in `ChatHeader` that opens a modal listing enabled memory items with
   per-session checkboxes.
2. On modal open, call `api.getSessionMemoryOverrides(sessionId)` and show which items are
   excluded/included.
3. On toggle, call `api.setSessionMemoryOverrides(sessionId, itemIds)`.
4. The `useMemoryStore.buildContextBlock()` should be updated to read per-session overrides and
   filter accordingly.

### 2c. Session selector for "Extract from chat" (Memory)

Currently `runExtract()` picks sessions[0] (most recently updated) — user has no choice.

**Fix:** Before calling `api.extractFactsFromSession()`, show a session picker modal with the 20
most recent non-empty sessions, with snippet preview. Let the user select which session to
extract from.

### 2d. Compare result diff view

After all columns complete, there's no way to compare results side-by-side/line-by-line.
A diff view comparing column A vs B text would be valuable.

**Fix:** Add a "Diff" button in the post-run toolbar that replaces the grid with a side-by-side
diff using the existing `diffLines` utility.

---

## Phase 3 — Tests

All three routes have ZERO tests. Add smoke and interaction tests:

### 3a. Compare tests

| Test | Scope |
|---|---|
| `compareRoute renders empty state` | Smoke — renders without providers |
| `addModel adds a column to selected` | Unit — state logic |
| `start sets runId on success` | Unit — mock `api.runCompare` |
| `blind mode toggles model label visibility` | Integration — render with mock columns |

### 3b. Documents tests

| Test | Scope |
|---|---|
| `documentsRoute renders empty state` | Smoke |
| `createNew creates tab and sets active` | Unit — mock `api.upsertDocument` |
| `save calls upsertDocument` | Unit |
| `DiffPreview shows added/removed lines` | Unit — pure component |
| `Ctrl+S triggers save` | Integration — keyboard event |

### 3c. Memory tests

| Test | Scope |
|---|---|
| `memoryRoute renders item list` | Smoke |
| `search filters via api.searchMemory` | Unit — debounced |
| `toggle calls api.toggleMemory` | Unit |
| `extract opens modal with facts` | Unit |

---

## Phase 4 — Polish (UX enhancements)

| Feature | Change |
|---|---|
| **Compare** | Show elapsed timer per column during streaming (currently only shows after done). Move timer to column header. |
| **Compare** | Token counts per column during streaming (done col shows tokens, streaming col shows "..." — unify). |
| **Compare** | Add error boundaries per column so one failing provider doesn't crash the whole page. |
| **Documents** | Debounced autosave (2s after last edit). Mark dirty flag, auto-persist to DB. |
| **Documents** | Keyboard shortcut hints in toolbar: `Ctrl+S` save, `Ctrl+P` preview toggle. |
| **Documents** | Syntax highlighting in editor mode (CodeMirror or Monaco would be ideal; at minimum add a language selector dropdown that highlights via `lucide-react`). |
| **Memory** | Replace `dangerouslySetInnerHTML` snippet rendering with a safe markdown renderer (or just keep as plain text since FTS5 outputs are trusted). |
| **Memory** | Bulk select/delete (checkbox mode). |
| **Memory** | Quick-start cards in empty state: "Set a user preference", "Log a project fact", "Create a skill". |
| **Memory** | Duplicate detection: when saving, search FTS for near-duplicates and warn. |

---

## Execution order

1. **Phase 1** (correctness) — ship immediately, no new tests needed beyond verification trio.
2. **Phase 2** (functional gaps) — feature work, add tests in Phase 3 concurrently.
3. **Phase 3** (tests) — add tests alongside Phase 2 work.
4. **Phase 4** (polish) — final UX pass, separate PR.

**Verification trio** after each phase:
```bash
npm run typecheck && npm run test:run && npm run build
```

Plus Rust check for any backend changes:
```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

---

## Files summary

| File | Phases touched |
|---|---|
| `src/routes/CompareRoute.tsx` | 1a, 2a, 2d, 3a, 4 |
| `src/routes/DocumentsRoute.tsx` | 1b, 1c, 1d, 3b, 4 |
| `src/routes/MemoryRoute.tsx` | 2c, 3c, 4 |
| `src/stores/memory.ts` | 2b |
| `src-tauri/src/commands/documents.rs` | 1c |
| `src/components/chat/ChatHeader.tsx` | 2b |
| New: `src/components/memory/SessionOverrideModal.tsx` | 2b |
| New: `src/lib/__tests__/compare.test.tsx` | 3a |
| New: `src/lib/__tests__/documents.test.tsx` | 3b |
| New: `src/lib/__tests__/memory.test.tsx` | 3c |
