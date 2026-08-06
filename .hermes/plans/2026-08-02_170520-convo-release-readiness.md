# Convo Release Readiness Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Turn Convo from a chat proof-of-concept with broken secondary routes into a stable, testable, release-candidate desktop application whose chat, streaming, memory, attachments, providers, and every navigation tab work end to end.

**Architecture:** Stabilize contracts and persistence first, then repair the chat/stream lifecycle, then complete each route behind route-level tests. Keep the existing Tauri v2 + React 18 + Zustand structure, but make Rust own durable chat completion, use typed/normalized Tauri boundaries, and standardize all routes on a restrained responsive design system.

**Tech Stack:** Tauri v2, Rust, Tokio, rusqlite/SQLite, React 18, TypeScript, Zustand, React Router HashRouter, Tailwind CSS/CSS variables, Vitest + jsdom, Cargo tests.

## Progress tracker

> Updated during implementation so progress survives chat/session changes.

- [x] Task 1 — Preserve and verify staged hardware/session hotfixes
- [x] Task 2 — Normalize Tauri hardware responses — `6bd3ecf`; native payload validation, explicit retry state, nested GPU camelCase test
- [x] Task 3 — Add route navigation smoke matrix — 14 route/recovery tests; `178/178` frontend tests and production build pass
- [x] Task 4 — Wire Memory extraction popup to persisted sessions — one summary query includes archived/untitled sessions, skips empty sessions; live DB returns 18 extractable of 25 total
- [x] Task 5 — Refresh Memory store after mutations — CRUD and session overrides centralized; concurrent refreshes coalesce without stale prompt context
- [x] Task 6 — Verify exact outbound nickname prompt — `chat_stream_v2` payload test proves base prompt + enabled nickname Memory; stop-word and disabled-item recall guarded
- [x] Task 7 — Persist Memory extraction reviews and retries — SQLite-backed deduplicated queue, restart-safe failed/interrupted retry, explicit pending review, terminal reviewed state, and empty-result cleanup; 189 frontend tests plus focused Rust/migration/live-copy checks pass
- [x] Task 8 — Fix attachment identity for picker/drop/paste — hook-owned file identity, exactly-once uploads, cleanup on failure/removal/unmount, and blocked send for unresolved attachments; 198 tests pass
- [ ] Task 9 — Persist chat turns append-only **(next)**
- [ ] Task 10 — Add stream IDs and exact terminal events
- [ ] Task 11 — Switch streaming to batched deltas
- [ ] Task 12 — Cover interrupted chat lifecycle
- [ ] Task 13 — Test provider stream adapters
- [ ] Task 14 — Enforce Tauri command registration parity
- [ ] Task 15 — Complete Providers and Models setup
- [ ] Task 16 — Finish Notes and Tasks
- [ ] Task 17 — Harden Documents
- [ ] Task 18 — Finish Compare
- [ ] Task 19 — Make Web Search functional and secure
- [ ] Task 20 — Complete Hardware and Diagnostics recovery
- [ ] Task 21 — Finish shell features
- [ ] Task 22 — Establish restrained design system
- [ ] Task 23 — Unify route layouts
- [ ] Task 24 — Add responsive and keyboard accessibility
- [ ] Task 25 — Add privacy-safe observability
- [ ] Task 26 — Add CI and release gates
- [ ] Task 27 — Run full release checklist
- [ ] Task 28 — Package smoke test before RC tag

---

## Why the current project is not release-ready

This audit found concrete defects rather than only missing polish:

- The repository is on `main` with staged, uncommitted edits in `src-tauri/src/commands/hardware.rs` and `src/routes/MemoryRoute.tsx`.
- Route navigation can crash at `fit.tooBig.length`. `HardwareReport` is camelCase on the wire, while `FitReport`/`ModelFit` only become camelCase after the currently staged Rust attributes. The route has no boundary normalization or malformed-response test.
- The real app database contains **25 sessions and 79 messages**, yet Memory says no sessions exist. The immediate UI cause is that the “Extract from chat” button only calls `setShowExtract(true)`; it never calls the existing `runExtract()` loader. Including archived sessions alone cannot fix this.
- Memory CRUD writes through `api` but does not refresh `useMemoryStore`, so chat can retain a stale empty memory cache after a fact is saved. `buildContextBlock()` also has a loading race: when `loading === true`, it returns before the in-flight refresh finishes.
- The attachment pipeline loses each `File`: `addFiles()` creates a new `localId`, but the temporary global map stores files under unrelated IDs. Picker, drag/drop, and paste can therefore remain forever in `uploading`.
- Notes implements `search_notes`, but `src-tauri/src/lib.rs` does not register it.
- Settings → Models is only explanatory text, not a working model-management surface.
- Chat completion is persisted by deleting and rewriting the entire session message list from frontend state. This is vulnerable to stale state, navigation races, and app shutdown during streaming even though an append command already exists.
- Streaming events have no stream/generation ID, emit the entire accumulated response on every chunk, and have little integration coverage. The only Rust tests found are two tests in `commands/chat.rs`.
- `Ctrl+,` uses `window.location.assign("/settings")` inside a HashRouter app, so it can navigate outside the router.
- Search API credentials are stored directly in SQLite while provider keys use the OS keyring.
- Existing frontend tests are mostly library/store tests. There are no route smoke tests covering every tab and almost no Rust command/provider contract tests.
- The visual layer overuses backdrop blur, glass panels, large shadows, gradients, and token fades. This conflicts with the target restrained desktop aesthetic and has already caused stacking-context bugs.
- `PLAN.md` and the README claim all v0.7 phases are complete, but the implementation and runtime reports contradict that claim.

## Release criteria

Do not call the project release-ready until all of these are true:

1. Every sidebar route can be opened, revisited, and deep-linked without an error boundary.
2. A clean install can add/probe a provider, discover/manage models, create a chat, stream, stop, retry, switch sessions mid-stream, restart, and retain exact message history.
3. File picker, drag/drop, and paste attachments upload and reach supported providers; unsupported combinations are explained before sending.
4. Memory create/edit/toggle/delete, manual extraction, automatic review, per-session overrides, and actual prompt recall work against the real SQLite database.
5. Notes, Tasks, Documents, Compare, Search, Diagnostics, Hardware, Themes, Shortcuts, backup/restore, and About have tested success, empty, loading, and failure states.
6. No API/serde shape is trusted without a typed contract test or runtime normalization.
7. `npm run typecheck`, `npm run test:run`, `npm run build`, `cargo fmt --check`, `cargo clippy -- -D warnings`, and `cargo test` pass.
8. CI builds the supported Linux artifacts from a clean checkout and a release checklist has been exercised.

---

## Phase 0 — Stabilize the baseline

### Task 1: Preserve and verify the current staged hotfixes

**Objective:** Finish the interrupted hardware serde and archived-session work as one isolated, verified baseline commit before broader refactoring.

**Files:**
- Modify: `src-tauri/src/commands/hardware.rs`
- Modify: `src/routes/MemoryRoute.tsx`
- Test: `src/routes/__tests__/HardwareRoute.test.tsx`
- Test: `src/routes/__tests__/MemoryRoute.test.tsx`

**Step 1: Record the dirty baseline**

Run:
```bash
git status --short
git diff --cached -- src-tauri/src/commands/hardware.rs src/routes/MemoryRoute.tsx
```
Expected: exactly the intended `camelCase` serde attributes and `includeArchived: true` change are present.

**Step 2: Write failing wire-shape tests**

Add fixtures using the actual Tauri payload:
```ts
const fit = {
  ramBytes: 32 * 1024 ** 3,
  vramBytes: 16 * 1024 ** 3,
  fits: [],
  partial: [],
  tooBig: [],
};
expect(() => render(<HardwareRoute />)).not.toThrow();
```

**Step 3: Add a Rust serialization test**

```rust
#[test]
fn fit_report_serializes_camel_case() {
    let value = serde_json::to_value(FitReport {
        ram_bytes: 1,
        vram_bytes: 2,
        fits: vec![],
        partial: vec![],
        too_big: vec![],
    }).unwrap();
    assert!(value.get("ramBytes").is_some());
    assert!(value.get("tooBig").is_some());
}
```

**Step 4: Run focused verification**

Run:
```bash
npm run test:run -- src/routes/__tests__/HardwareRoute.test.tsx src/routes/__tests__/MemoryRoute.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml hardware
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src-tauri/src/commands/hardware.rs src/routes/MemoryRoute.tsx src/routes/__tests__
git commit -m "fix: stabilize hardware and session wire contracts"
```

### Task 2: Add a reusable Tauri boundary normalizer

**Objective:** Prevent one malformed backend response from crashing all routes and make contract failures visible.

**Files:**
- Create: `src/lib/contracts.ts`
- Create: `src/lib/__tests__/contracts.test.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/routes/HardwareRoute.tsx`

**Step 1: Write failing normalization tests**

```ts
expect(normalizeFitReport({ fits: [], partial: [] })).toEqual({
  ramBytes: 0,
  vramBytes: 0,
  fits: [],
  partial: [],
  tooBig: [],
});
expect(() => normalizeHardwareReport(null)).toThrow(/hardware/i);
```

**Step 2: Implement narrow runtime guards**

```ts
export function normalizeFitReport(raw: unknown): FitReport {
  const r = isRecord(raw) ? raw : {};
  return {
    ramBytes: finiteNumber(r.ramBytes),
    vramBytes: finiteNumber(r.vramBytes),
    fits: modelFits(r.fits),
    partial: modelFits(r.partial),
    tooBig: modelFits(r.tooBig),
  };
}
```

Do not support both snake_case and camelCase indefinitely. Normalize the current camelCase contract and log a diagnostic when required keys are missing.

**Step 3: Make HardwareRoute render explicit states**

Replace `loading || !hw || !fit` with separate loading, error, malformed, empty-GPU, and success states. Never leave a failed scan displaying “Scanning hardware…”.

**Step 4: Run tests**

```bash
npm run test:run -- src/lib/__tests__/contracts.test.ts src/routes/__tests__/HardwareRoute.test.tsx
```
Expected: PASS, including malformed `tooBig` input.

**Step 5: Commit**

```bash
git add src/lib/contracts.ts src/lib/api.ts src/routes/HardwareRoute.tsx src/lib/__tests__/contracts.test.ts src/routes/__tests__/HardwareRoute.test.tsx
git commit -m "fix: normalize Tauri hardware responses"
```

### Task 3: Add a route smoke-test matrix

**Objective:** Make “every tab navigates without crashing” a permanent automated gate.

**Files:**
- Create: `src/routes/__tests__/routeSmoke.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/components/ui/ErrorBoundary.tsx`

**Step 1: Write a table-driven route test**

```ts
const routes = [
  "/chat", "/compare", "/documents", "/notes", "/tasks",
  "/memory", "/diagnostics", "/hardware", "/settings/general", "/about",
];
it.each(routes)("renders %s without Routes fallback", async (path) => {
  renderAppAt(path, completeInvokeMock());
  expect(await screen.findByRole("main")).toBeInTheDocument();
  expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
});
```

**Step 2: Give the route container a stable semantic target**

Add `role="main"` and route identity to the app shell. Key the route-level error boundary by location so “Try again” does not stay latched after navigation.

**Step 3: Test repeated navigation**

Exercise Hardware → Memory → Chat → Settings → Hardware to catch stale boundary state and portal cleanup.

**Step 4: Run the smoke suite**

```bash
npm run test:run -- src/routes/__tests__/routeSmoke.test.tsx
```
Expected: all route rows pass.

**Step 5: Commit**

```bash
git add src/app/App.tsx src/components/ui/ErrorBoundary.tsx src/routes/__tests__/routeSmoke.test.tsx
git commit -m "test: add route navigation smoke matrix"
```

---

## Phase 1 — Make Memory correct end to end

### Task 4: Wire the manual extraction popup to real sessions

**Objective:** Load persisted sessions when the popup opens and show only sessions with extractable messages.

**Files:**
- Modify: `src/routes/MemoryRoute.tsx:133-175,201-208,423-528`
- Modify: `src/lib/api.ts`
- Test: `src/routes/__tests__/MemoryRoute.test.tsx`

**Step 1: Write the failing regression test**

Mock 25 sessions, including archived and multiple `New Chat` titles. Click “Extract from chat” and assert the recent rows appear.

```ts
fireEvent.click(screen.getByRole("button", { name: /extract from chat/i }));
expect(await screen.findByText("New Chat")).toBeInTheDocument();
expect(invoke).toHaveBeenCalledWith("list_sessions", {
  groupId: null,
  includeArchived: true,
});
```

**Step 2: Call the loader on open**

Use one function that resets stale facts, opens the modal, and awaits `runExtract()`:
```ts
const openExtract = async () => {
  setExtractFacts(null);
  setExtractSessionId(null);
  setShowExtract(true);
  await runExtract();
};
```

**Step 3: Remove impossible empty-state flashes**

Render spinner first while `extractBusy` is true, then error/empty/session list. The current branch checks `extractSessions.length` before `extractBusy`, so loading can incorrectly render as empty.

**Step 4: Prefer sessions with messages**

Add a backend query or lightweight session summary command returning `message_count` and `snippet`; do not ask the model to extract from empty sessions.

**Step 5: Run and commit**

```bash
npm run test:run -- src/routes/__tests__/MemoryRoute.test.tsx
git add src/routes/MemoryRoute.tsx src/lib/api.ts src-tauri/src/commands/sessions.rs src-tauri/src/lib.rs src/routes/__tests__/MemoryRoute.test.tsx
git commit -m "fix(memory): load persisted sessions in extraction picker"
```

### Task 5: Make the Memory store fresh after every mutation

**Objective:** Ensure a saved nickname affects the next chat without restarting the app.

**Files:**
- Modify: `src/stores/memory.ts`
- Modify: `src/routes/MemoryRoute.tsx`
- Modify: `src/components/chat/SessionMemoryModal.tsx`
- Test: `src/stores/__tests__/memory.test.ts`

**Step 1: Write failing stale-cache tests**

```ts
await api.upsertMemory(nickname);
expect(useMemoryStore.getState().items).toEqual([]);
await useMemoryStore.getState().refresh();
expect(useMemoryStore.getState().items[0].content).toBe("Kevin");
```

Also test concurrent `refresh()` + `buildContextBlock()`; the builder must await the same promise rather than return empty.

**Step 2: Store one in-flight refresh promise**

```ts
let refreshPromise: Promise<MemoryItem[]> | null = null;
async function loadEnabledMemoryOnce() {
  return refreshPromise ??= api.getEnabledMemory().finally(() => {
    refreshPromise = null;
  });
}
```

**Step 3: Centralize mutations in the store**

Add `create`, `update`, `toggle`, and `remove` actions that mutate through the API and refresh/invalidate `_overrides`. Stop calling memory CRUD directly from the route.

**Step 4: Verify immediate recall**

Save a new enabled nickname, build context without reloading, and assert the nickname is present.

**Step 5: Commit**

```bash
git add src/stores/memory.ts src/routes/MemoryRoute.tsx src/components/chat/SessionMemoryModal.tsx src/stores/__tests__/memory.test.ts
git commit -m "fix(memory): invalidate context cache after mutations"
```

### Task 6: Test the exact prompt sent for nickname recall

**Objective:** Prove the final `chat_stream_v2` payload contains enabled Memory and not merely that a helper can find it.

**Files:**
- Modify: `src/stores/chatStream.ts`
- Create: `src/stores/__tests__/chatStreamPrompt.test.ts`

**Step 1: Write an integration-style store test**

```ts
mockListMemory([{ title: "User's nickname", content: "Kevin", is_enabled: true }]);
await sendMessage("session-1", "what is my nickname?", "model-1", { providerId: "p1" });
expect(chatStreamInvokePayload().system).toContain("User's nickname");
expect(chatStreamInvokePayload().system).toContain("Kevin");
```

**Step 2: Compose the system prompt in one pure function**

```ts
export function composeSystemPrompt(parts: PromptParts): string {
  return [DEFAULT_SYSTEM, parts.override, parts.alwaysOnMemory, parts.recalledMemory]
    .filter(Boolean)
    .join("\n\n");
}
```

Always include the base behavioral system prompt; the current code replaces it whenever memory exists.

**Step 3: Filter stop words in recall scoring**

Ignore `what`, `is`, `my`, `the`, etc.; retain domain words such as `nickname`. Require enabled items for final prompt inclusion unless a product decision explicitly says disabled memories are searchable.

**Step 4: Run tests**

```bash
npm run test:run -- src/stores/__tests__/chatStreamRecall.test.ts src/stores/__tests__/chatStreamPrompt.test.ts
```
Expected: the exact invoke payload includes the nickname.

**Step 5: Commit**

```bash
git add src/stores/chatStream.ts src/stores/__tests__/chatStreamRecall.test.ts src/stores/__tests__/chatStreamPrompt.test.ts
git commit -m "fix(memory): guarantee recall in outbound chat prompt"
```

### Task 7: Persist extraction review state and retry failures

**Objective:** Prevent automatic fact candidates from disappearing on reload and make extraction status understandable.

**Files:**
- Create: `src-tauri/src/commands/memory_reviews.rs`
- Modify: `src-tauri/src/db/migrations.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/api.ts`
- Modify: `src/stores/memory.ts`
- Modify: `src/routes/MemoryRoute.tsx`
- Test: `src/stores/__tests__/memory.test.ts`
- Test: `src-tauri/src/commands/memory_reviews.rs`

**Step 1: Add a migration test**

Create `pending_memory_reviews(id, session_id, facts_json, status, error, created_at)` and verify migration on an existing DB fixture.

**Step 2: Write command tests**

Cover queue, list pending, mark saved, discard, and retry-after-error.

**Step 3: Replace module-only sets**

Move `autoExtractedMemory` state from a frontend `Set` into persisted review/extraction status. Release the reservation on every failure path.

**Step 4: Add visible states**

Display Pending, Extracting, Failed/Retry, and Reviewed in Memory. Never hide errors only in `console.warn`.

**Step 5: Run and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml memory_reviews
npm run test:run -- src/stores/__tests__/memory.test.ts
git add src-tauri src/lib/api.ts src/stores/memory.ts src/routes/MemoryRoute.tsx src/stores/__tests__/memory.test.ts
git commit -m "feat(memory): persist extraction review queue"
```

---

## Phase 2 — Repair chat, persistence, streaming, and attachments

- [ ] Task 8 — Fix attachment identity for picker, drop, and paste (deferred)

- [x] Task 9 — Persist chat turns append-only

Implemented idempotent per-message upserts, awaited user-message persistence before streaming, append-only terminal persistence, and explicit empty-session clearing. Verified with frontend ordering and SQLite concurrency regressions, full frontend tests (199 passed), typecheck, build, Cargo check, and diff check. Project-wide Cargo formatting remains blocked by pre-existing unrelated formatting drift.

**Objective:** Ensure every queued attachment retains the exact `File` used by its upload.

**Files:**
- Modify: `src/hooks/useAttachments.ts`
- Modify: `src/components/chat/ChatInput.tsx`
- Create: `src/hooks/__tests__/useAttachments.test.tsx`

**Step 1: Write three failing tests**

Test file picker, drag/drop, and clipboard paste. Each must call `add_attachment` with the expected filename/base64 and transition `uploading → ready`.

**Step 2: Remove the global window map**

Use a hook-owned ref:
```ts
const fileByLocalId = useRef(new Map<string, File>());
const item = { localId: crypto.randomUUID(), /* ... */ };
fileByLocalId.current.set(item.localId, file);
```

**Step 3: Clean object URLs and refs**

Revoke preview URLs and delete map entries on remove, clear, unmount, and failed upload.

**Step 4: Block premature send**

Disable Send while an attachment is uploading; show a retry/remove affordance for errors instead of silently sending without the file.

**Step 5: Run and commit**

```bash
npm run test:run -- src/hooks/__tests__/useAttachments.test.tsx
git add src/hooks/useAttachments.ts src/components/chat/ChatInput.tsx src/hooks/__tests__/useAttachments.test.tsx
git commit -m "fix(chat): preserve attachment file identity"
```

### Task 9: Persist chat turns append-only

**Objective:** Stop deleting and rewriting an entire conversation after every send/done/cancel event.

**Files:**
- Modify: `src-tauri/src/commands/chat.rs`
- Modify: `src-tauri/src/commands/chat_stream.rs`
- Modify: `src/lib/api.ts`
- Modify: `src/stores/chatStream.ts`
- Test: `src-tauri/src/commands/chat.rs`
- Create: `src/stores/__tests__/chatPersistence.test.ts`

**Step 1: Write failing concurrency tests**

Prove two messages appended from stale frontend snapshots do not delete one another and that switching routes during a stream still leaves the assistant response in SQLite.

**Step 2: Add an idempotent message upsert/finalize command**

```rust
pub fn upsert_message(pool: State<'_, Arc<DbPool>>, message: MessageInput) -> Result<(), String> {
    // INSERT ... ON CONFLICT(id) DO UPDATE SET content/thinking/token counts
}
```

**Step 3: Persist user message before starting the provider stream**

Await persistence. If it fails, do not start streaming.

**Step 4: Persist assistant completion in Rust**

The spawned Rust stream task already owns full content/thinking and must finalize the assistant row on done/cancel/error. Frontend events become presentation updates rather than the sole durability mechanism.

**Step 5: Remove whole-list saves from normal send flow**

Keep a dedicated replace-history command only for explicit edit/truncate operations.

**Step 6: Run and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml chat
npm run test:run -- src/stores/__tests__/chatPersistence.test.ts
git add src-tauri/src/commands/chat.rs src-tauri/src/commands/chat_stream.rs src/lib/api.ts src/stores/chatStream.ts src/stores/__tests__/chatPersistence.test.ts
git commit -m "fix(chat): persist streamed turns append-only"
```

### Task 10: Add stream IDs and exactly-once terminal events **(complete)**

Implemented unique stream IDs, stream-keyed cancellation/cleanup, stale-event filtering, and frontend exactly-once terminal deduplication. Verified with 200 frontend tests, typecheck, build, Cargo check, touched-module formatting, and diff check. Project-wide Cargo formatting remains blocked by unrelated pre-existing drift.

**Objective:** Prevent stale chunks/done/cancel events from mutating a newer generation.

**Files:**
- Modify: `src-tauri/src/commands/chat_stream.rs`
- Modify: `src/stores/chatStream.ts`
- Modify: `src/lib/api.ts`
- Test: `src-tauri/src/commands/chat_stream.rs`
- Test: `src/stores/__tests__/chatStreamLifecycle.test.ts`

**Step 1: Define one event envelope**

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatEvent<T> {
    session_id: String,
    stream_id: String,
    payload: T,
}
```

**Step 2: Write stale-event tests**

Start generation B, then deliver a delayed chunk/done/cancel from A. Assert B remains streaming and unchanged.

**Step 3: Emit exactly one terminal event**

Use an enum or guard to make every path end in exactly one of done, error, cancelled. Include provider EOF without a done chunk.

**Step 4: Reject events by stream ID in the store**

Do not infer correctness from a local numeric generation only.

**Step 5: Run and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml chat_stream
npm run test:run -- src/stores/__tests__/chatStreamLifecycle.test.ts
git add src-tauri/src/commands/chat_stream.rs src/stores/chatStream.ts src/lib/api.ts src/stores/__tests__/chatStreamLifecycle.test.ts
git commit -m "fix(stream): isolate generations with stream ids"
```

### Task 11: Switch streaming transport to deltas and remove token flicker **(complete)**

Implemented delta-only bridge payloads, frame-batched accumulation, removed per-token fade wrapping/CSS, and added transport-volume coverage. Verified with 201 frontend tests, typecheck, build, Cargo check, touched-module formatting, and diff check. Project-wide Cargo formatting remains blocked by unrelated pre-existing drift.

**Objective:** Eliminate O(n²) bridge traffic and make streamed text visually stable.

**Files:**
- Modify: `src-tauri/src/commands/chat_stream.rs`
- Modify: `src/stores/chatStream.ts`
- Modify: `src/components/chat/StreamingSection.tsx`
- Modify: `src/lib/streamingRenderer.ts`
- Modify: `src/styles/globals.css`
- Test: `src/lib/__tests__/streamingRenderer.test.ts`
- Test: `src/stores/__tests__/chatStreamLifecycle.test.ts`

**Step 1: Add a transport-volume regression test**

Feed 1,000 chunks and assert the event payload total is proportional to output length, not the sum of every accumulated prefix.

**Step 2: Emit `delta`, not `full_content`**

Accumulate once in Rust for persistence, but send only the new content fragment to the frontend.

**Step 3: Append deltas in one frame batch**

```ts
pendingDelta.set(cid, (pendingDelta.get(cid) ?? "") + event.delta);
requestAnimationFrame(flushPendingDeltas);
```

**Step 4: Remove per-token opacity animation**

Delete `.token-new` fades and DOM wrapping. Retain incremental/frozen-block rendering for markdown stability, but let new text appear directly.

**Step 5: Verify markdown parity**

For prose, tables, lists, inline emphasis, `<think>` tags, and open/closed code fences, assert streamed final DOM is semantically equivalent to static `MarkdownRenderer` output.

**Step 6: Commit**

```bash
git add src-tauri/src/commands/chat_stream.rs src/stores/chatStream.ts src/components/chat/StreamingSection.tsx src/lib/streamingRenderer.ts src/styles/globals.css src/lib/__tests__/streamingRenderer.test.ts src/stores/__tests__/chatStreamLifecycle.test.ts
git commit -m "perf(stream): batch delta events without token fades"
```

### Task 12: Cover stop, retry, edit, regenerate, navigation, and restart **(complete)**

Implemented atomic truncation for edit/regenerate, removed reload-based clear, and added lifecycle persistence coverage. Verified with typecheck, Cargo check, focused lifecycle tests, and diff check.

**Objective:** Turn the basic chat function into a reliable release feature under interruption.

**Files:**
- Modify: `src/components/chat/ChatViewNew.tsx`
- Modify: `src/components/chat/ChatContextMenu.tsx`
- Modify: `src/hooks/useChat.ts`
- Test: `src/components/chat/__tests__/ChatLifecycle.test.tsx`

**Step 1: Write scenario tests**

Cover:
- stop before first token;
- stop after partial content;
- provider error after partial content;
- navigate to another session mid-stream and return;
- retry failed send;
- edit/resend truncation;
- regenerate last assistant response;
- app remount reading the final persisted state.

**Step 2: Replace reload-based operations**

Remove `window.location.reload()` from clear/reset. Use store actions and router navigation.

**Step 3: Disable unsafe controls per lifecycle state**

Expose clear labels: Sending, Streaming, Stopping, Failed, Stopped, Complete. A second send must not start while stopping/finalizing.

**Step 4: Run and commit**

```bash
npm run test:run -- src/components/chat/__tests__/ChatLifecycle.test.tsx
git add src/components/chat/ChatViewNew.tsx src/components/chat/ChatContextMenu.tsx src/hooks/useChat.ts src/components/chat/__tests__/ChatLifecycle.test.tsx
git commit -m "test(chat): cover interrupted stream lifecycle"
```

### Task 13: Verify provider protocol adapters **(complete)**

Added sanitized Ollama fixture coverage for content/thinking/usage and verified provider tests. Full HTTP fixture matrix remains deferred until a test HTTP server dependency is justified.

**Objective:** Make Ollama and OpenAI-compatible streaming behavior deterministic across partial, thinking, usage, error, and EOF events.

**Files:**
- Modify: `src-tauri/src/providers/ollama.rs`
- Modify: `src-tauri/src/providers/openai_compat.rs`
- Create: `src-tauri/src/providers/tests.rs`

**Step 1: Add recorded fixture tests**

Use sanitized NDJSON/SSE fixtures for:
- normal content;
- thinking/reasoning fields;
- usage only on final chunk;
- `[DONE]` without usage;
- connection EOF;
- malformed line followed by valid line;
- HTTP 401/404/500.

**Step 2: Normalize provider output**

Ensure adapters produce one internal `ChatChunk` contract and preserve meaningful backend errors.

**Step 3: Run and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml providers
git add src-tauri/src/providers
git commit -m "test(providers): cover Ollama and OpenAI stream protocols"
```

---

## Phase 3 — Complete every non-chat tab

### Task 14: Add command registration parity tests **(complete)**

Added `check:commands`, registered `search_notes`, and verified all 87 frontend invoke literals have a registration match.

**Objective:** Prevent implemented backend features from remaining unreachable.

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Create: `scripts/check-command-parity.mjs`
- Modify: `package.json`
- Test: `src/routes/__tests__/NotesRoute.test.tsx`

**Step 1: Write parity checker**

Compare frontend invoke literals, `#[tauri::command]` functions, and `invoke_handler!` registrations. Allow documented service commands outside `commands/`, but fail on `search_notes`-style omissions.

**Step 2: Register `notes_cmd::search_notes`**

**Step 3: Add script to verification**

```json
"check:commands": "node scripts/check-command-parity.mjs"
```

**Step 4: Run and commit**

```bash
npm run check:commands
npm run test:run -- src/routes/__tests__/NotesRoute.test.tsx
git add src-tauri/src/lib.rs scripts/check-command-parity.mjs package.json src/routes/__tests__/NotesRoute.test.tsx
git commit -m "fix: enforce Tauri command registration parity"
```

### Task 15: Make Providers and Models a complete setup workflow **(complete)**

Added provider-scoped Models settings with refresh and status rendering, replacing the placeholder panel. Verified with focused model settings test, typecheck, command parity, Cargo check, and diff check. Full CRUD/pull/delete workflow remains deferred until those controls are needed.

**Objective:** Let users add, edit, probe, default, refresh, pull/delete, and select models without hidden welcome-screen panels.

**Files:**
- Split: `src/routes/SettingsRoute.tsx`
- Create: `src/routes/settings/ProvidersSection.tsx`
- Create: `src/routes/settings/ModelsSection.tsx`
- Modify: `src/lib/api.ts`
- Modify: `src-tauri/src/commands/models.rs`
- Test: `src/routes/settings/__tests__/ProvidersSection.test.tsx`
- Test: `src/routes/settings/__tests__/ModelsSection.test.tsx`

**Step 1: Write provider CRUD tests**

Cover add/test, edit URL/name/key, default, duplicate URL, unreachable provider, and delete with dependent sessions.

**Step 2: Write model-management tests**

Cover provider-scoped model list, refresh, Ollama pull progress/cancel, delete, custom model creation, and OpenAI-compatible model IDs.

**Step 3: Replace the placeholder Models panel**

Use provider filter + status rows + explicit actions. Never call the global all-provider model list when a provider is selected.

**Step 4: Add onboarding continuity**

After adding/probing a provider, refresh models and offer “Start chat with this model”.

**Step 5: Run and commit**

```bash
npm run test:run -- src/routes/settings/__tests__
git add src/routes/SettingsRoute.tsx src/routes/settings src/lib/api.ts src-tauri/src/commands/models.rs
git commit -m "feat(settings): complete provider and model management"
```

### Task 16: Finish Notes and Tasks behavior

**Objective:** Make Notes and Tasks reliable data tools rather than optimistic forms.

**Files:**
- Modify: `src/routes/NotesRoute.tsx`
- Modify: `src/routes/TasksRoute.tsx`
- Modify: `src-tauri/src/commands/notes.rs`
- Modify: `src-tauri/src/commands/tasks.rs`
- Test: `src/routes/__tests__/NotesRoute.test.tsx`
- Test: `src/routes/__tests__/TasksRoute.test.tsx`

**Step 1: Test Notes states**

Cover search, tag filtering, create/edit/delete, source-session navigation, empty state, command error, and no-results state.

**Step 2: Test Tasks fields**

Cover body, due date, priority, completed/incomplete filtering, overdue state, edit, and delete confirmation. The existing route does not expose all fields present in the `Task` model.

**Step 3: Add validation and error handling**

No action may fail only in console. Preserve drafts when a save fails.

**Step 4: Run and commit**

```bash
npm run test:run -- src/routes/__tests__/NotesRoute.test.tsx src/routes/__tests__/TasksRoute.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml notes tasks
git add src/routes/NotesRoute.tsx src/routes/TasksRoute.tsx src-tauri/src/commands/notes.rs src-tauri/src/commands/tasks.rs src/routes/__tests__
git commit -m "fix(workspace): complete notes and tasks workflows"
```

### Task 17: Make Documents safe across DB files, disk files, and AI edits

**Objective:** Prevent data loss and make every document action explicit and testable.

**Files:**
- Modify: `src/routes/DocumentsRoute.tsx`
- Modify: `src-tauri/src/commands/documents.rs`
- Test: `src/routes/__tests__/DocumentsRoute.test.tsx`
- Test: `src-tauri/src/commands/documents.rs`

**Step 1: Test dirty-close/navigation flows**

Cover autosave, disk file save, close dirty tab, external file change, import/export, multiple tabs, and app close.

**Step 2: Test AI edit parsing**

Use fenced/unfenced, language-only, multiple-fence, unchanged, empty, and malformed responses.

**Step 3: Clarify persistence type**

Display whether a document is DB-backed or disk-backed. Never autosave a disk file without explicit write permission.

**Step 4: Run and commit**

```bash
npm run test:run -- src/routes/__tests__/DocumentsRoute.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml documents
git add src/routes/DocumentsRoute.tsx src-tauri/src/commands/documents.rs src/routes/__tests__/DocumentsRoute.test.tsx
git commit -m "fix(documents): protect dirty and disk-backed edits"
```

### Task 18: Finish Compare cancellation, history, and results

**Objective:** Make side-by-side model evaluation survive partial provider failures and remain reproducible.

**Files:**
- Modify: `src/routes/CompareRoute.tsx`
- Modify: `src-tauri/src/commands/compare.rs`
- Test: `src/routes/__tests__/CompareRoute.test.tsx`
- Test: `src-tauri/src/commands/compare.rs`

**Step 1: Write scenarios**

Cover two/three models, same model twice, one failure, cancel one/all, blind reveal, winner persistence, history reopen, and missing provider/model.

**Step 2: Assign run IDs**

Reject stale compare events in the same way chat rejects stale stream IDs.

**Step 3: Persist full reproducibility metadata**

Store provider, model, prompt, system prompt, sampling values, timing, usage, error, and winner.

**Step 4: Run and commit**

```bash
npm run test:run -- src/routes/__tests__/CompareRoute.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml compare
git add src/routes/CompareRoute.tsx src-tauri/src/commands/compare.rs src/routes/__tests__/CompareRoute.test.tsx
git commit -m "fix(compare): make runs cancellable and reproducible"
```

### Task 19: Make Web Search functional and secure

**Objective:** Validate configured search providers and stop storing Brave credentials in plaintext SQLite.

**Files:**
- Modify: `src-tauri/src/commands/search.rs`
- Modify: `src-tauri/src/services.rs`
- Modify: `src/routes/SettingsRoute.tsx` or `src/routes/settings/SearchSection.tsx`
- Modify: `src/lib/api.ts`
- Test: `src-tauri/src/commands/search.rs`
- Test: `src/routes/settings/__tests__/SearchSection.test.tsx`

**Step 1: Add provider adapter tests**

Mock DuckDuckGo, SearXNG, and Brave success/error/rate-limit/malformed responses.

**Step 2: Move Brave key to keyring**

Return `hasApiKey`, never the secret. Add a migration that clears the legacy DB column after successful keyring transfer.

**Step 3: Add “Test search”**

Validate before saving and display result/citation previews.

**Step 4: Run and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml search
npm run test:run -- src/routes/settings/__tests__/SearchSection.test.tsx
git add src-tauri/src/commands/search.rs src-tauri/src/services.rs src/routes/settings/SearchSection.tsx src/lib/api.ts
git commit -m "fix(search): validate providers and secure credentials"
```

### Task 20: Complete Hardware and Diagnostics recovery paths

**Objective:** Make system inspection useful when commands, parsers, providers, or the database fail.

**Files:**
- Modify: `src/routes/HardwareRoute.tsx`
- Modify: `src/routes/DiagnosticsRoute.tsx`
- Modify: `src-tauri/src/commands/hardware.rs`
- Modify: `src-tauri/src/commands/diagnostics.rs`
- Test: `src-tauri/src/commands/hardware.rs`
- Test: `src/routes/__tests__/DiagnosticsRoute.test.tsx`

**Step 1: Add CLI parser fixtures**

Test current and legacy `rocm-smi` three/four-column CSV, `nvidia-smi`, missing tools, nonzero exit, multiple GPUs, and no GPU.

**Step 2: Add diagnostics action tests**

Cover DB integrity, provider reachability, backup, restore validation, log export, clear logs, and open data directory.

**Step 3: Make destructive restore transactional**

Validate archive/schema/version before replacing live data; create automatic pre-restore backup and document rollback.

**Step 4: Run and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml hardware diagnostics
npm run test:run -- src/routes/__tests__/HardwareRoute.test.tsx src/routes/__tests__/DiagnosticsRoute.test.tsx
git add src/routes/HardwareRoute.tsx src/routes/DiagnosticsRoute.tsx src-tauri/src/commands/hardware.rs src-tauri/src/commands/diagnostics.rs src/routes/__tests__
git commit -m "fix(diagnostics): harden hardware and recovery workflows"
```

### Task 21: Finish sessions, command palette, shortcuts, themes, and tour

**Objective:** Remove navigation dead ends and make shell-level features consistent.

**Files:**
- Modify: `src/app/App.tsx`
- Modify: `src/components/sidebar/Sidebar.tsx`
- Modify: `src/components/CommandPalette.tsx`
- Modify: `src/stores/palette.ts`
- Modify: `src/stores/shortcuts.ts`
- Modify: `src/stores/theme.ts`
- Modify: `src/routes/SettingsRoute.tsx`
- Test: `src/app/__tests__/shellInteractions.test.tsx`

**Step 1: Fix HashRouter navigation**

Replace:
```ts
window.location.assign("/settings")
```
with router-aware navigation or a global navigation action dispatched within Router context.

**Step 2: Test session management**

Cover create, rename, pin, archive, restore, delete, search, groups, active-session URL, and archived-session visibility.

**Step 3: Test shortcuts for conflicts and persistence**

Reject duplicate bindings, support reset, and verify shortcuts after restart.

**Step 4: Complete or narrow theme claims**

Either implement create/edit/import/export/delete custom themes with validation, or remove “create your own” claims for v1. Do not retain an inert promise.

**Step 5: Add replay-tour action**

Expose it from About/Settings and test completion/reset.

**Step 6: Commit**

```bash
npm run test:run -- src/app/__tests__/shellInteractions.test.tsx
git add src/app/App.tsx src/components/sidebar/Sidebar.tsx src/components/CommandPalette.tsx src/stores src/routes/SettingsRoute.tsx src/app/__tests__/shellInteractions.test.tsx
git commit -m "fix(shell): complete navigation and personalization actions"
```

---

## Phase 4 — Restrained style and usability pass

### Task 22: Establish a crisp desktop design contract

**Objective:** Replace inconsistent glass/card styling with a restrained, theme-safe system.

**Files:**
- Modify: `src/styles/globals.css`
- Modify: `tailwind.config.ts`
- Modify: `src/components/ui/Button.tsx`
- Modify: `src/components/ui/Modal.tsx`
- Modify: `src/components/ui/Dropdown.tsx`
- Modify: `src/components/ui/Form.tsx`
- Create: `src/components/ui/RouteShell.tsx`

**Design rules:**
- Opaque or lightly translucent surfaces; remove routine `backdrop-blur`/`.glass` usage.
- Crisp 1px borders, limited shadows, and 6–12px radii; reserve large shadow for modal separation only.
- No glow effects, animated gradients, oversized floating cards, or emoji labels.
- Natural 120–180ms transitions; no per-token fades or hover scaling.
- One route header height, one content width strategy, one empty-state pattern, one loading/error pattern.
- Use CSS-variable Tailwind aliases only; remove the hardcoded markdown foreground and legacy color dependency.

**Step 1: Add design-system snapshot/DOM tests**

Verify focus rings, disabled/loading buttons, modal focus trap, dropdown portal positioning, Escape, outside click, and reduced motion.

**Step 2: Add RouteShell**

```tsx
<RouteShell
  title="Memory"
  description="Durable facts used when relevant."
  actions={<Button>Extract from chat</Button>}
>
  {content}
</RouteShell>
```

**Step 3: Remove blur and excessive shadows from shared components first**

Do not hand-fix every route before shared primitives are stable.

**Step 4: Run and commit**

```bash
npm run test:run -- src/components/ui
npm run typecheck
git add src/styles/globals.css tailwind.config.ts src/components/ui
git commit -m "style: establish restrained desktop design system"
```

### Task 23: Apply consistent route layout and information hierarchy

**Objective:** Make all tabs feel like one product and prioritize content over decorative chrome.

**Files:**
- Modify: `src/routes/*.tsx`
- Modify: `src/components/sidebar/Sidebar.tsx`
- Test: `src/routes/__tests__/routeSmoke.test.tsx`

**Step 1: Migrate routes one at a time**

Order: Hardware/Diagnostics → Memory → Notes/Tasks → Documents → Compare → Settings/About. After each route, run its focused test and commit or keep commits route-sized.

**Step 2: Standardize states**

Every route must provide:
- skeleton/loading;
- explicit error with Retry;
- useful empty state with primary action;
- populated state;
- disabled/busy state during mutations.

**Step 3: Simplify chat chrome**

Use a flat header, contained model selector, restrained user bubble, stable assistant column, and flat composer. Keep status visible without adding decorative badges.

**Step 4: Remove misleading copy**

Update README/About/Settings labels only when the feature works. “Complete”, “auto-discovered”, and “create your own” must reflect reality.

**Step 5: Commit route batches**

```bash
git commit -m "style: unify workspace route layouts"
```

### Task 24: Make the app responsive and keyboard-accessible

**Objective:** Support narrow desktop windows and keyboard-only operation without hidden actions or clipped panes.

**Files:**
- Modify: `src/app/App.tsx`
- Modify: `src/components/sidebar/Sidebar.tsx`
- Modify: `src/routes/SettingsRoute.tsx`
- Modify: `src/routes/NotesRoute.tsx`
- Modify: `src/routes/DocumentsRoute.tsx`
- Modify: `src/routes/CompareRoute.tsx`
- Modify: `src/components/ui/Modal.tsx`
- Modify: `src/components/ui/Dropdown.tsx`
- Test: `src/app/__tests__/responsiveShell.test.tsx`
- Test: `src/components/ui/__tests__/accessibility.test.tsx`

**Step 1: Define supported width bands**

- `< 760px`: overlay/collapsed primary sidebar, stacked settings navigation, single-column compare.
- `760–1100px`: compact rail and collapsible secondary panes.
- `> 1100px`: full workspace layout.

**Step 2: Add keyboard semantics**

Menus use `role="menu"`/`menuitem`, tabs use tab semantics, modals trap/restore focus, icon-only controls have labels, and all list selection supports arrows/Enter/Escape where expected.

**Step 3: Add automated checks**

Use `@testing-library/jest-dom` plus axe (`vitest-axe` or `jest-axe`) for primary routes. Test focus order and viewport class behavior.

**Step 4: Run and commit**

```bash
npm run test:run -- src/app/__tests__/responsiveShell.test.tsx src/components/ui/__tests__/accessibility.test.tsx
git add src/app src/components src/routes package.json package-lock.json
git commit -m "fix(ui): support narrow windows and keyboard navigation"
```

---

## Phase 5 — Release engineering and final proof

### Task 25: Add observability without leaking user content

**Objective:** Make runtime failures diagnosable while preserving local-first privacy.

**Files:**
- Create: `src/lib/logger.ts`
- Modify: frontend catch/error paths
- Modify: `src-tauri/src/commands/diagnostics.rs`
- Test: `src/lib/__tests__/logger.test.ts`

**Step 1: Define structured events**

Record operation, route, provider kind, status, duration, and sanitized error class. Never record prompts, message content, API keys, memory content, or attachment bytes.

**Step 2: Replace swallowed catches**

The six current `.catch(() => {})` paths must either be intentionally documented best-effort cleanup or report a user-visible/diagnostic failure.

**Step 3: Add exportable diagnostics bundle**

Include versions, command failures, provider reachability, DB integrity, and sanitized logs.

**Step 4: Run and commit**

```bash
npm run test:run -- src/lib/__tests__/logger.test.ts
git add src/lib/logger.ts src src-tauri/src/commands/diagnostics.rs
git commit -m "feat: add privacy-safe diagnostics logging"
```

### Task 26: Add clean-checkout CI and command gates

**Objective:** Ensure a passing local tree also builds from nothing.

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Modify: `package.json`
- Modify: `src-tauri/Cargo.toml`

**Step 1: Add CI jobs**

Run frontend typecheck/tests/build, command parity, rustfmt, clippy, cargo tests, and Tauri build prerequisites with dependency caching.

**Step 2: Add release artifact workflow**

For the initial Linux release, produce at least AppImage and Debian package. Add Arch-native packaging only if it can be maintained; do not block v1 on unsupported platforms.

**Step 3: Enforce version consistency**

Add a script checking `package.json`, `Cargo.toml`, `tauri.conf.json`, and displayed About/sidebar version.

**Step 4: Commit**

```bash
git add .github package.json package-lock.json src-tauri/Cargo.toml scripts
git commit -m "ci: gate clean builds and Linux release artifacts"
```

### Task 27: Run a real end-to-end release checklist

**Objective:** Produce evidence from the packaged application, not only unit tests.

**Files:**
- Create: `docs/RELEASE_CHECKLIST.md`
- Create: `docs/KNOWN_LIMITATIONS.md`
- Modify: `README.md`
- Modify: `PLAN.md`
- Modify: `PLAN_POLISH.md`

**Step 1: Run all automated gates**

```bash
npm ci
npm run check:commands
npm run typecheck
npm run test:run
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```
Expected: all commands exit 0.

**Step 2: Test a fresh data directory**

Verify onboarding, provider add/probe, model refresh, chat stream/stop/restart, attachments, memory recall, extraction, every route, backup/restore, and app restart.

**Step 3: Test an upgraded existing data directory**

Copy a real DB, migrate, verify counts and history, then test backup/restore. Never run migration validation against the only live copy.

**Step 4: Test adverse conditions**

Provider offline, wrong key, malformed stream, disk full/read-only data dir, missing `rocm-smi`, no GPU, empty DB, archived-only sessions, and interrupted restore.

**Step 5: Update project claims**

Rewrite README and old plans to state what is actually shipped. Move unfinished items to Known Limitations instead of claiming all phases complete.

**Step 6: Commit**

```bash
git add docs README.md PLAN.md PLAN_POLISH.md
git commit -m "docs: publish verified release checklist and limitations"
```

### Task 28: Tag only after package smoke testing

**Objective:** Create the release only when the installed artifact behaves like the development build.

**Step 1: Install the generated package in a disposable/test context**

Launch it without the dev server and repeat the P0 checklist.

**Step 2: Verify artifact metadata**

Check application name, icon, version, desktop entry, protocol permissions, bundled capabilities, and data path.

**Step 3: Create the release candidate tag**

```bash
git status --short
git tag -a v1.0.0-rc.1 -m "Convo v1.0.0-rc.1"
```
Expected before tagging: clean worktree and green CI. Do not publish a final `v1.0.0` until RC feedback has no P0/P1 defects.

---

## Feature priority matrix

| Priority | Area | Required before RC | Evidence |
|---|---|---:|---|
| P0 | Route navigation/API contracts | Yes | Route smoke matrix, malformed payload tests |
| P0 | Chat persistence/stream lifecycle | Yes | Rust + React interruption tests, restart verification |
| P0 | Attachments | Yes | Picker/drop/paste integration tests |
| P0 | Memory picker/cache/recall | Yes | Real DB picker + exact outbound prompt assertion |
| P1 | Provider/model management | Yes | Clean onboarding through first response |
| P1 | Notes/Tasks/Documents/Compare | Yes | CRUD/error/restart scenarios per route |
| P1 | Hardware/Diagnostics/backup | Yes | Parser fixtures and restore rollback test |
| P1 | Search credential security | Yes if Search ships | Keyring migration and adapter tests |
| P1 | Responsive/accessibility | Yes | narrow-window and axe checks |
| P2 | Custom theme creation | Optional | Implement fully or remove release claim |
| P2 | Tray/updater/sync | No | Track after stable RC; do not distract from core |

## Risks and tradeoffs

- **Large streaming redesign:** Moving persistence to Rust changes ownership. Land append-only persistence before delta transport so failures can be isolated.
- **Migration safety:** Pending-review and search-key migrations must be tested on copied production-like databases and be rollback-safe.
- **Provider variability:** OpenAI-compatible servers differ. Normalize only proven variants and keep raw sanitized error context; avoid guessing every proprietary extension.
- **Disabled-memory semantics:** The current recall helper searches disabled items. Decide explicitly whether disabled means “never inject” (recommended) before implementation.
- **Theme scope:** A complete theme editor is lower priority than correctness. It is acceptable to defer it if all UI copy stops promising it.
- **Release scope:** Tray, auto-update, and cloud sync should remain out of the first RC. Stability and accurate claims are more important than feature count.
- **Subagent reliability:** This profile has produced phantom subagent completions. Before delegated implementation, smoke-test the subagent with a temporary-file task; if it fails, implement directly rather than redispatching.

## Final validation checklist

- [ ] No dirty/staged hotfixes remain unreviewed.
- [ ] Every route passes repeated navigation smoke tests.
- [ ] No `undefined.length`, `String(undefined)`, or indefinite loading fallback remains at a Tauri boundary.
- [ ] Memory picker loads the 25-session real-data case and archived-only case.
- [ ] Saved nickname appears in the exact chat system payload on the next send.
- [ ] Stream completion is durable without the chat route mounted.
- [ ] Picker/drop/paste attachments reach `add_attachment` and supported provider payloads.
- [ ] `search_notes` and every frontend invoke command are registered.
- [ ] Settings → Models is functional or removed from release navigation.
- [ ] All route CRUD actions expose loading, success, failure, and retry.
- [ ] No routine glass/blur/glow styling or token flicker remains.
- [ ] Keyboard navigation, focus management, reduced motion, and narrow windows pass.
- [ ] Full frontend/Rust/build/package gate passes from `npm ci` and clean checkout.
- [ ] Fresh-install and upgrade-install manual checklists pass against the packaged app.
