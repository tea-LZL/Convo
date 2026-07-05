# Convo Polish & Completion Plan

**Target**: v0.7 release
**Executors**: GLM 5.2 / Deepseek V4 Pro (agentic)
**Starting state**: v0.6.8 git history, package.json still at v0.4.0, 107/107 tests failing, monolithic ChatViewNew (1218 lines), no error boundaries, no responsive breakpoints, native browser dialogs leftover, broken attachment picker, animation layer incomplete.

**Invariant**: Every phase ends with `npm run typecheck` clean. Rust changes end with `cargo check` clean. No phase ends with failing tests (unless explicitly deferring a pre-existing failure that this phase does not touch).

---

## Phase 1: Foundation — version alignment, test fix, project constants

**Goal**: Establish a trustworthy baseline so every subsequent phase has a reliable gate.

### 1.1 Version sync
- [ ] `package.json` version → `0.7.0`
- [ ] `src-tauri/Cargo.toml` version → `0.7.0`
- [ ] `src-tauri/tauri.conf.json` version → `0.7.0`
- [ ] `src/components/sidebar/Sidebar.tsx:195` — sidebar subtitle `v0.4 · local-first` → `v0.7 · local-first`
- [ ] `README.md` heading line 5 — update to `v0.7 — polish & responsive pass`
- [ ] Remove preset references from README (lines 12-13: "5 built-in presets" / "preset system prompt snippet in header") since presets were dropped in v0.6.3 migration V003

### 1.2 Fix the test suite
**Root cause**: `src/test/setup.ts` calls `localStorage.clear()` but `vitest.config.ts` sets `environment: "jsdom"` which does polyfill `localStorage` — however the mock setup overrides `globalThis.URL` with a plain object (line 45-53) via `Object.defineProperty` with `writable: true, configurable: true`, and that descriptor accidentally shadows the global `localStorage` because the test setup file's `vi.mock` + `mockReset: true` + `restoreMocks: true` interaction. The actual error `localStorage.clear is not a function` means jsdom's localStorage is not carrying over.

**Fix steps**:
- [ ] In `src/test/setup.ts`, replace the implicit reliance on jsdom's localStorage with an explicit polyfill at the top of the file (before any `vi.mock`):
  ```ts
  // Polyfill localStorage for jsdom — needed before any mockReset cycles
  if (!globalThis.localStorage) {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, String(v)),
        removeItem: (k: string) => store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
      },
    });
  }
  ```
- [ ] Verify `npm run test:run` — target 0 failures. If specific test assertions are wrong (e.g. memory store shape changed during pivot), fix the assertion, not the code, and note each fix in the commit message.
- [ ] Add a CI-equivalent gate script: `npm run typecheck && npm run test:run` and confirm it passes.

### 1.3 AGENTS.md
- [ ] Create `AGENTS.md` at repo root capturing:
  - `npm run typecheck` / `npm run test:run` / `npm run build` as the verification trio
  - `cargo check --manifest-path src-tauri/Cargo.toml` for Rust
  - The CSS-variable theming system (do NOT hardcode colors; always use `bg-surface-2`, `text-muted`, etc.)
  - The streaming architecture split: `chatStream.ts` store owns listeners, `ChatViewNew` owns the component tree, `streamingRenderer.ts` owns the DOM-direct tail render. Do not re-couple them.
  - React.memo discipline: per-row memo comparator in `messageRowAreEqual` — any new prop added to MessageRow must be added to the comparator or it will silently break streaming perf.
  - `src-tauri/src/lib.rs` invoke_handler list — any new Tauri command must be registered here or it's invisible to the frontend.

**Verify**: `npm run typecheck && npm run test:run` both pass. Version strings consistent across 4 files.

---

## Phase 2: Error boundaries, accessibility, tooltip fix

**Goal**: Prevent single-component crashes from blowing up the app. Fix the known UI bugs that don't require restructuring.

### 2.1 Error boundary
- [ ] Create `src/components/ui/ErrorBoundary.tsx` — class component, `componentDidCatch` logs to console + renders a fallback card with "Something went wrong. Reload." button. Place it:
  - [ ] Wrapping `<Routes>` in `App.tsx` (catches route-level errors)
  - [ ] Wrapping `<ChatViewNew>` in `ChatRoute.tsx` (chat is the highest-risk area)
  - [ ] Wrapping `<StreamingSection>` in `ChatViewNew.tsx` (stream renderer is DOM-direct; if it throws, the whole chat goes down without an inner boundary)

### 2.2 Tooltip fix
- [ ] `src/components/ui/Form.tsx:201` — `Tooltip` component accepts `side?: "top" | "bottom" | "left" | "right"` but only positions for top/bottom. Add left/right positioning:
  - `side === "left"` → `right-full mr-1.5 top-1/2 -translate-y-1/2`
  - `side === "right"` → `left-full ml-1.5 top-1/2 -translate-y-1/2`
  - Keep top/bottom as-is.
- [ ] Verify the sidebar collapsed mode uses `side="right"` — it does (Sidebar.tsx:152, 165, 173, 177). This fix is load-bearing for the collapsed-sidebar tooltips.

### 2.3 Accessible focus management
- [ ] Add `aria-label` to every `<button>` in `ChatViewNew.tsx` that only contains an icon (search for `<button` in the file; most icon-only buttons in the header dropdown lack labels).
- [ ] Add `role="status"` and `aria-live="polite"` to the streaming content div (ChatViewNew.tsx:994-997) so screen readers announce streaming text.
- [ ] Add `role="alert"` to the chat error banner (ChatViewNew.tsx:475-478).

**Verify**: `npm run typecheck && npm run test:run` pass. Visually confirm tooltips render to the right of collapsed sidebar icons.

---

## Phase 3: ChatViewNew decomposition

**Goal**: Break the 1218-line monolith into focused modules. This is the structural prerequisite for Phase 4 (responsive) and Phase 5 (animations) — each module needs its own animation scope.

### 3.1 Extract components
Move these out of `ChatViewNew.tsx` into their own files under `src/components/chat/`:

- [ ] `src/components/chat/MarkdownRenderer.tsx` — lines 625-676 (REMARK_PLUGINS, MARKDOWN_COMPONENTS, MarkdownRenderer). Export `MarkdownRenderer` and `MARKDOWN_COMPONENTS` (the Documents route may reuse it).
- [ ] `src/components/chat/MessageRow.tsx` — lines 697-845 (MessageRowProps, messageRowAreEqual, MessageRow). Keep the custom comparator intact.
- [ ] `src/components/chat/MessageList.tsx` — lines 847-920 (MessageListProps, MessageList).
- [ ] `src/components/chat/StreamingSection.tsx` — lines 922-1007 (StreamingSectionProps, StreamingSection).
- [ ] `src/components/chat/ChatInput.tsx` — lines 1057-1217 (ChatInput + its sub-effects).
- [ ] `src/components/chat/AttachmentChip.tsx` — lines 1009-1054 (parseAttachments, AttachmentChip, AttachmentStripItem).
- [ ] `src/components/chat/ChatContextMenu.tsx` — lines 502-615 (the context menu JSX + its handlers). Extract as a component that takes `contextMenu` state + `setContextMenu` + the full handler set.
- [ ] `src/components/chat/ChatHeader.tsx` — lines 292-398 (the header with model dropdown, more menu, token counter). Extract as `ChatHeader({ providers, models, providerId, modelId, ... })`.
- [ ] Keep `ChatViewNew.tsx` as the orchestrator (≤300 lines target): state, effects, callbacks, and JSX composition of the extracted children.

### 3.2 Shared types
- [ ] Create `src/components/chat/types.ts` — export `MessageRowProps`, `MessageListProps`, `StreamingSectionProps`, `ChatContextMenuState`, `AttachmentData` so all child files import from one place.
- [ ] Move `formatModelLabel` and `formatTimestamp` (lines 26-37) into `src/components/chat/format.ts`.

### 3.3 Import discipline
- [ ] Every extracted file imports from `../../lib/api`, `../../hooks/useChat`, `../../stores/chatStream` as needed. No circular imports — `ChatViewNew` imports children, children never import `ChatViewNew`.
- [ ] `src/components/chat/index.ts` — barrel export for clean imports: `export { ChatViewNew } from './ChatViewNew'` etc.

**Verify**: `npm run typecheck && npm run test:run && npm run build` all pass. `ChatViewNew.tsx` is under 350 lines. `wc -l src/components/chat/*.tsx` — no file over 400 lines.

---

## Phase 4: Responsive layout

**Goal**: Convo should be usable from 320px (narrowest Tauri window is 800px but the sidebar + content should still work on half-screen) to 2560px. The current layout breaks below 800px because the sidebar and content rail are fixed-width.

### 4.1 Sidebar responsive collapse
- [ ] `src/styles/globals.css` — add a `@media (max-width: 700px)` rule that hides the expanded sidebar and forces collapsed mode. The `collapsed` prop in Sidebar.tsx is driven by `App.tsx` state — add a `useMediaQuery` hook:
  - [ ] Create `src/hooks/useMediaQuery.ts` — `useMediaQuery('(max-width: 700px)')` returns boolean. Use `matchMedia` (already polyfilled in test setup).
  - [ ] In `App.tsx`, replace `const [sidebarCollapsed, setSidebarCollapsed] = useState(false)` with:
    ```ts
    const isNarrow = useMediaQuery('(max-width: 700px)');
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const effectiveCollapsed = sidebarCollapsed || isNarrow;
    ```
  - Pass `effectiveCollapsed` to `<Sidebar>`. When `isNarrow` is true and the user clicks "expand", it should still expand (manual override). Track this with a `manualOverride` ref.
- [ ] Add a CSS transition on the sidebar width: `transition-[width] duration-200 ease-out` on the `<aside>` in Sidebar.tsx (both collapsed and expanded variants). The width changes from `w-12` to `w-60`, so add `transition-all duration-200`.

### 4.2 Chat responsive
- [ ] `ChatViewNew.tsx:919` — `MessageList` uses `max-w-3xl mx-auto`. Add responsive padding: `px-3 sm:px-4 max-w-3xl mx-auto w-full`.
- [ ] `ChatViewNew.tsx:987` — `StreamingSection` same treatment.
- [ ] `ChatViewNew.tsx:474` — `ChatInput` container `max-w-3xl mx-auto` → add `px-3 sm:px-4`.
- [ ] Chat header token counter (line 394-397): wrap in a `hidden sm:flex` so it hides on narrow screens. The model selector stays visible.
- [ ] Empty state (ChatRoute.tsx EmptyChat): the 4-card grid is `grid-cols-1 sm:grid-cols-2` — already responsive, good. Add `px-4 sm:px-8` to the outer container.

### 4.3 Settings responsive
- [ ] `SettingsRoute.tsx:21-35` — the settings left rail is `w-56` fixed. On narrow screens, convert to a horizontal scroll bar:
  - [ ] Add `useMediaQuery('(max-width: 800px)')` — when narrow, render the nav as a horizontal flex row at the top instead of a vertical rail on the left.
  - [ ] The content area `max-w-2xl mx-auto p-8` → `max-w-2xl mx-auto p-4 sm:p-8`.

### 4.4 Compare responsive
- [ ] `CompareRoute.tsx` — the column grid for 2-4 models is likely a fixed flex row. On narrow screens, stack vertically. Find the column container and add `flex-col lg:flex-row`.
- [ ] Compare prompt textarea: add `px-3 sm:px-4` padding wrapper.

### 4.5 Documents/Notes/Tasks/Memory responsive
- [ ] `DocumentsRoute.tsx` — editor layout is likely split-pane. On narrow screens, stack the editor and preview. Add `flex-col lg:flex-row` to the split container.
- [ ] `NotesRoute.tsx` — note list + editor is split-pane. Same stacking.
- [ ] `TasksRoute.tsx` — `max-w-2xl mx-auto` → add `px-3 sm:px-4`.
- [ ] `MemoryRoute.tsx` — `max-w-2xl mx-auto p-8` → `p-4 sm:p-8`.

**Verify**: `npm run typecheck && npm run build` pass. Manually resize Tauri window from 800px to 2560px — no layout breakage, sidebar auto-collapses below 700px, all content padding scales.

---

## Phase 5: Animation & transitions

**Goal**: Make the UI feel responsive and alive. Every state change should have a visual continuation, not an instant snap. The existing animation set is minimal: `fade-in`, `slide-up`, `scale-in`, `pulse-dot`, `ripple`. We add entrance, exit, and layout transitions without over-animating.

### 5.1 CSS keyframe additions
In `src/styles/globals.css`, add:

- [ ] `@keyframes messageIn` — `{ from: { opacity: 0; transform: translateY(6px); }, to: { opacity: 1; transform: translateY(0); } }` with `.animate-message-in { animation: messageIn 0.24s ease-out both; }`.
- [ ] `@keyframes sidebarSlide` — for the sidebar collapse/expand. `{ from: { width: var(--sidebar-w-from); }, to: { width: var(--sidebar-w-to); } }`. This is tricky because width transitions need explicit values; use `transition: width 200ms cubic-bezier(0.4,0,0.2,1)` on the `<aside>` instead of keyframes.
- [ ] `@keyframes shimmer` — skeleton loading. `{ 0%: { background-position: -200% 0; }, 100%: { background-position: 200% 0; } }` with `.skeleton { background: linear-gradient(90deg, var(--color-surface-2) 25%, var(--color-surface-3) 50%, var(--color-surface-2) 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }`.
- [ ] `@keyframes thinkingCollapse` — `{ from: { max-height: 500px; opacity: 1; }, to: { max-height: 0; opacity: 0; } }` for thinking section collapse. Apply via `overflow-hidden transition-all duration-200` on the thinking body div (ChatViewNew.tsx:788-792).
- [ ] `@media (prefers-reduced-motion: reduce)` — keep existing block, add new animations to the disable list.

### 5.2 Component-level transitions
- [ ] **Message rows**: add `animate-message-in` to the MessageRow's outer `<div>` (ChatViewNew.tsx:753). Keep existing React.memo — the animation runs once on mount, doesn't interfere with re-render skipping.
- [ ] **Thinking section**: replace the instant show/hide with `transition-all duration-200` + `max-height` toggle. When `thinkingOpen` is false, the body div gets `max-h-0 opacity-0 overflow-hidden`; when true, `max-h-[500px] opacity-100`.
- [ ] **Sidebar collapse/expand**: add `transition-all duration-200 ease-out` to both `<aside>` variants in Sidebar.tsx (lines 148 and 188).
- [ ] **Dropdown menus**: add exit animation. The current `animate-scale-in` only plays on mount. Wrap the dropdown menu in a mount/unmount wrapper that plays `animate-scale-out` before unmounting. Create a `<AnimatedUnmount>` helper in `src/components/ui/AnimatedUnmount.tsx` that uses `useRef + useEffect + requestAnimationFrame` to defer unmount until the exit animation finishes (150ms).
- [ ] **Modals**: same exit animation treatment. `Modal.tsx` currently returns `null` when `!open`. Wrap in `<AnimatedUnmount>` so the backdrop fade-out + modal scale-out play before unmount.
- [ ] **Route transitions**: add a `key={location.pathname}` on the `<main>` in App.tsx and an `animate-fade-in` class. Each route change triggers a subtle fade. Don't use React Transition Group — a key-swap + CSS animation is enough.
- [ ] **Session rows in sidebar**: add `animate-message-in` to each `SessionRow` div. Stagger via `animationDelay: ${i * 20}ms` (cap at 200ms).
- [ ] **Empty state cards**: add `hover:-translate-y-0.5 hover:shadow-panel transition-all duration-200` to the 4 cards in ChatRoute.tsx EmptyChat (lines 110-141) and the starter buttons (lines 170-188).
- [ ] **Buttons**: the existing `active:scale-[0.98]` is good. Add `transition-colors duration-150` to the primary variant where missing (most buttons already have it via `transition-all`).

### 5.3 Skeleton screens
- [ ] Create `src/components/ui/Skeleton.tsx` — a `Skeleton` component that renders a `div` with the `skeleton` class + configurable `width`/`height`/`rounded` props.
- [ ] Replace the pulsing-dot loading in `ChatRoute.tsx:72-80` with a skeleton of 3 message-shaped blocks (user bubble + assistant text lines).
- [ ] Replace the loading states in `NotesRoute.tsx`, `TasksRoute.tsx`, `MemoryRoute.tsx` with skeletons matching their layout.

### 5.4 Streaming polish
- [ ] The `token-new` CSS fade (globals.css:191-200) is good. The streaming "waiting" dots (ChatViewNew.tsx:999-1003) use `animate-pulse-dot` — keep.
- [ ] Add a subtle "typing indicator" cursor at the end of `StreamingSection`'s content div: a `▋` character with `animate-pulse` that appears when `streamContent` is present but no new chunk has arrived in 1s. This is a minor enhancement; skip if it adds complexity.

**Verify**: `npm run typecheck && npm run test:run && npm run build`. Visually: open/close sidebar (smooth), send a message (message appears with slide-in), open/close modal (exit animation), switch routes (fade), collapse thinking section (height transition). Respect `prefers-reduced-motion` — all animations should be near-instant when enabled.

---

## Phase 6: Native dialog replacement & attachment picker fix

**Goal**: Remove browser-native dialogs (`window.confirm`, `window.prompt`) in favor of the existing `Modal` component. Fix the broken attachment picker.

### 6.1 Confirm dialog component
- [ ] Create `src/components/ui/ConfirmDialog.tsx` — a reusable confirmation modal wrapping `Modal.tsx`. Props: `open`, `onClose`, `onConfirm`, `title`, `message`, `confirmLabel`, `confirmVariant: "danger" | "primary"`.
- [ ] Replace `window.confirm` in Sidebar.tsx:128 (delete session) — use a state-driven `<ConfirmDialog>`.
- [ ] Replace `window.confirm` in ChatViewNew.tsx:382 (clear session) — same.
- [ ] Replace `window.prompt` in Sidebar.tsx:98 (rename session) — use a state-driven `<Modal>` with a `<TextInput>`. Create a `RenameSessionModal` inline in Sidebar.tsx.

### 6.2 Attachment picker fix
- [ ] In `ChatViewNew.tsx` `openPicker` (lines 1108-1138), the Tauri dialog returns file paths but the code does `void paths` and falls back to `<input type=file>`. Fix this:
  - [ ] Use `@tauri-apps/plugin-fs` `readFile` to read the selected file bytes, then construct a `File` object from the bytes + filename, and pass to `attachments.addFiles([file])`.
  - [ ] Remove the hidden `<input type=file>` fallback from the success path. Keep it only in the `catch` block for when the Tauri dialog is unavailable (webview fallback).
  - [ ] The `@tauri-apps/plugin-fs` is already in `package.json` dependencies and registered in `lib.rs` as `tauri_plugin_fs`. The `capabilities/default.json` needs `fs:read` scope — check and add if missing.

**Verify**: `npm run typecheck && npm run test:run && npm run build`. Delete a session (Modal, not browser dialog). Rename a session (Modal with text input). Attach a file via the paperclip (Tauri dialog opens, file is read and attached, not silently ignored).

---

## Phase 7: Consistency pass — empty states, stale references, README

### 7.1 Empty state unification
- [ ] `ChatViewNew.tsx:406-409` — the "Send a message to start the conversation" text is unreachable in practice (ChatRoute shows EmptyChat when no session), but if `isEmpty` is true with a session loaded (e.g. user clears all messages), this plain text is shown with no starter prompts. Make it consistent: extract the starter prompt list from ChatRoute's EmptyChat into a shared `src/components/chat/ChatEmptyState.tsx` that both the session-less and message-less states render.

### 7.2 Slash command cleanup
- [ ] Check `src/lib/slashCommands.ts` for a `/preset` command — if it exists, remove it (presets were dropped in v0.6.3). Search for "preset" in slashCommands.ts and the DB layer.
- [ ] Run `grep -ri "preset" src/ --include="*.ts" --include="*.tsx"` and clean up any remaining references (comments, imports, types).

### 7.3 README refresh
- [ ] Update the Features section to remove presets (lines 12-13).
- [ ] Update the Architecture section to reflect the Phase 3 file split (chat/ directory now has multiple components).
- [ ] Update the Roadmap section — add the responsive + animation passes as completed in v0.7, and add new future directions (error boundaries, accessibility, webview file dialog).
- [ ] Update the keyboard shortcuts table if any changed.

### 7.4 Final consistency
- [ ] `git diff --stat` — review all changed files.
- [ ] `grep -rn "TODO\|FIXME\|WIP" src/ src-tauri/src/` — clean up any remaining.
- [ ] Confirm `src-tauri/src/lib.rs` invoke_handler list matches any new commands added during this plan (none expected unless Phase 6 adds one).

**Verify**: Full trio: `npm run typecheck && npm run test:run && npm run build`. `cargo check --manifest-path src-tauri/Cargo.toml` (may need long timeout on first compile). Review the full diff for completeness.

---

## Execution notes for the agent

1. **Phase ordering is strict**: each phase's output is the next phase's input. Do not parallelize across phases. Within a phase, independent steps may be batched.

2. **The test suite is the gate**: if `npm run test:run` fails at the end of any phase, fix it before moving on. The only acceptable failing tests are pre-existing failures that the current phase explicitly defers (none should remain after Phase 1).

3. **Rust changes are minimal**: this plan is frontend-heavy. The only Rust-adjacent change is the attachment picker (Phase 6), which uses the already-registered `tauri-plugin-fs`. If `cargo check` takes too long on first run, run it once at the start to warm the build cache, then again at the end.

4. **Style discipline**: all new components must use the CSS-variable Tailwind aliases (`bg-surface-2`, `text-muted`, `border-border`, `text-accent`, etc.). Never hardcode hex colors. The theme system depends on this.

5. **Memo discipline**: when extracting MessageRow (Phase 3), the `messageRowAreEqual` comparator must move with it undamaged. Any new prop added to MessageRow in later phases must be added to the comparator. If this is forgotten, streaming will silently re-render all rows at 60fps and the lag bugs from v0.6.5-v0.6.6 will return.

6. **File creation**: use `write_file` for new files, `patch` for edits. Match existing import style (`import { X } from "..."`), existing indentation (2-space JSX), and existing export style (named exports, not default).

7. **Commit after each phase**: the agent should commit with a message like `feat(v0.7): Phase N — description`. Do not push. Do not rewrite history.

8. **Versioning**: the version bump happens in Phase 1 so all subsequent commits carry the correct version. Do not bump to v0.7.0 again in later phases.

---

## Phase verification summary

| Phase | Gate | Exit criteria |
|-------|------|---------------|
| 1 | typecheck + test:run | 0 test failures, 4 version strings synced, AGENTS.md exists |
| 2 | typecheck + test:run | ErrorBoundary wraps Routes + ChatViewNew + StreamingSection, Tooltip renders left/right |
| 3 | typecheck + test:run + build | ChatViewNew < 350 lines, 8 new files in chat/, no circular imports |
| 4 | typecheck + build | useMediaQuery hook, responsive sidebar/settings/compare/documents |
| 5 | typecheck + test:run + build | 4 new CSS keyframes, AnimatedUnmount, Skeleton, all transitions respect prefers-reduced-motion |
| 6 | typecheck + test:run + build | ConfirmDialog replaces 2 window.confirm + 1 window.prompt, attachment picker reads Tauri dialog paths |
| 7 | full trio + cargo check | Empty state unified, preset remnants removed, README accurate, diff clean |