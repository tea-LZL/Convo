# Streaming Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-rolled DOM streaming renderer with a React-native block-splitter renderer, so that streamed markdown and settled markdown are rendered by the *same* code path, while preserving the 60fps tail and zero-frozen-row-re-render guarantees.

**Architecture:** A pure source-text block splitter (`markdownBlocks.ts`) divides the accumulated message into blocks that can no longer change plus one live tail block. A memoized `MarkdownRenderer` renders each block. Frozen blocks' source strings never change, so `React.memo` skips them entirely; only the tail re-parses. The DOM-direct `streamingRenderer.ts` and `streamingSegmenter.ts` are deleted.

**Tech Stack:** React 18, TypeScript, zustand 4, react-markdown 9, remark-gfm 4, Vitest 2 + jsdom, Tauri v2.

**Spec:** `docs/superpowers/specs/2026-09-27-convo-realignment-design.md` §8, plus `docs/GOALS.md`. The plan argues from the spec; the spec travels with it.

---

## Global Constraints

- **Test floor: 263 passing tests, 0 failures.** Verified baseline as of 2026-09-27. This plan adds tests; it never removes a passing test except in the same commit that deletes the module it covers.
- `main` stays runnable. All work lands on the `realignment` branch.
- Every task ends with `npm run typecheck` and `npm run test:run` both clean.
- **No hardcoded hex colors.** All styling via CSS custom properties / Tailwind theme aliases (`bg-surface-2`, `text-muted`, `border-border`, `text-accent`).
- Named exports only, no default exports. 2-space JSX indentation.
- Import order: React → third-party → local (`../../lib/`, `../../stores/`).
- `src-tauri` is **untouched** by this plan. No Rust changes, no `cargo check` gate needed here.
- Every prop added to `MessageRow` **must** be added to `messageRowAreEqual` in the same commit. A stale comparator reintroduces the v0.6.5 60fps lag bug.
- The retrieval constants and the unified-index schema are **out of scope** — those are Plans 2–4.

---

## Review Focus

Five input classes the spec implies that no existing test exercises. Each is pinned to a test in the task that owns the code.

1. **Rewritten (non-append-only) stream content.** `streamingRenderer.ts:60-66` documents an append-only PRECONDITION; a provider that re-sends corrected earlier text silently leaves stale frozen blocks. A user sees the old text forever. → Task 3, Task 6.
2. **Multi-byte and RTL content.** Block splitting works on UTF-16 code-unit offsets. Splitting inside a grapheme cluster (emoji ZWJ sequences, combining marks) or mid-RTL-run can emit mojibake or reversed runs. → Task 3.
3. **A single 20,000-character line with no blank lines** (minified JSON, a long URL, a data blob). The splitter must stay linear; a naive rescan per frame is O(N²) and is exactly the regression the v0.7 rewrite risks reintroducing. → Task 3.
4. **Mismatched code fences** — a 4-backtick opener closed by 3 backticks, or a fence that never closes. `streamingSegmenter.ts:33-37` documents both as known mis-detections. → Task 3.
5. **Degenerate streams** — empty content, whitespace-only, a single newline, trailing blank lines at end of stream. Must emit no phantom block and not crash. → Task 3.

---

## File Structure

**Created:**
- `src/lib/markdownBlocks.ts` — pure splitter. No React, no DOM, no rendering.
- `src/lib/__tests__/markdownBlocks.test.ts` — splitter unit tests + the 5 Review Focus cases.
- `src/components/chat/StreamingTail.tsx` — React-native streaming render. Replaces `StreamingSection.tsx`.
- `src/components/chat/__tests__/StreamingTail.test.tsx` — render-parity and frozen-block tests.
- `src/components/chat/__tests__/fixtures/streamShapes.ts` — shared markdown shape corpus.

**Modified:**
- `src/stores/chatStream.ts` — drop the `version`/`bump` mirror; expose per-session slice selectors.
- `src/components/chat/ChatViewNew.tsx` — swap `StreamingSection` for `StreamingTail`.
- `src/components/chat/MessageRow.tsx` — use the shared `MARKDOWN_COMPONENTS` if the tail needs the same renderer.
- `AGENTS.md`, `README.md`, `docs/superpowers/specs/2026-09-27-convo-realignment-design.md`, `docs/GOALS.md` — test-count corrections.

**Deleted (each in the same commit that stops its last importer):**
- `src/lib/streamingRenderer.ts`
- `src/lib/streamingSegmenter.ts`
- `src/lib/__tests__/streamingRenderer.test.ts`
- `src/lib/__tests__/streamingSegmenter.test.ts`
- `src/components/chat/StreamingSection.tsx`
- `src/lib/markdown.ts` — **kept, not deleted.** Off every render path after Task 6, but retained as the pure test oracle for the block splitter alongside its 19 tests. Removal deferred to Plan 5.

---

## Why one renderer

Read this before Task 4. It changes the approach.

Convo currently has **two different markdown renderers** and uses each at a different time:

| Phase | Renderer | What it is |
|---|---|---|
| While streaming | `src/lib/markdown.ts` `renderMarkdown()` | Hand-rolled regex → HTML string. `escapeHtml` + `inlineToHtml`. No GFM, no syntax highlighting, no copy button, inline `style=` attributes. |
| After the stream ends | `src/components/chat/MarkdownRenderer.tsx` | `react-markdown` + `remark-gfm` + `react-syntax-highlighter` + copy button. |

`StreamingSection.tsx:37-48` calls `renderer.finalize()`, then the component returns `null` and `ChatViewNew` re-renders the message from source through `MarkdownRenderer`.

**Consequence: every completed message restyles itself the moment its stream ends.** GFM tables render one way mid-stream and another way settled. Task lists, strikethrough, and nested list indentation differ. Code blocks lose their language badge and copy button, or gain them. This is a live user-visible defect in the current app, independent of anything in this plan.

The approved rewrite therefore makes the streaming path use `MarkdownRenderer` too. This is better than the spec's proposed "byte-identical golden HTML" gate: parity becomes **structural** — the same function renders both — so parity cannot drift. The golden test changes from comparing HTML strings to comparing rendered structure (§Task 6, Step 4).

---

### Task 1: Correct the documented baseline

The test count is wrong in three places, and the README claims work is complete that is not.

**Files:**
- Modify: `AGENTS.md` (the "107 tests" line in the Verification trio section)
- Modify: `README.md` (roadmap "All seven planned phases are complete (v0.7)")
- Modify: `docs/GOALS.md` (the 252 test floor in the "How we know it works" table)
- Modify: `docs/superpowers/specs/2026-09-27-convo-realignment-design.md` (§8.3 test count floor)

**Interfaces:**
- Consumes: nothing.
- Produces: a single authoritative test floor of **263** that Tasks 2–7 hold to.

- [ ] **Step 1: Verify the real number**

Run: `npm run test:run 2>&1 | grep -E "Tests +[0-9]+ passed"`
Expected: `Tests  263 passed (263)`. If it is not 263, use whatever it actually is as the floor and note the discrepancy in the commit body.

- [ ] **Step 2: Fix `AGENTS.md`**

Change the Verification trio comment from `vitest run (107 tests, must be 0 failures)` to `vitest run (263 tests, must be 0 failures — floor; never drops)`.

- [ ] **Step 3: Fix `docs/GOALS.md`**

Change the "Test floor" row of the gates table from `Suite never drops below 252 passing tests` to `Suite never drops below 263 passing tests`.

- [ ] **Step 4: Fix the spec's §8.3**

Change "The suite is 252 tests today" to "The suite is 263 tests today (verified 2026-09-27; `AGENTS.md` said 107 and `docs/RELEASE_CHECKLIST.md` said 252 — both were wrong)".

- [ ] **Step 5: Fix the README roadmap**

Replace the claim that all seven planned phases are complete with a pointer to the realignment: add a line under the roadmap reading `v0.7 shipped a workspace-shaped app; the product was subsequently realigned to a memory-first Ollama chat client. See docs/GOALS.md — that document is canonical and this roadmap is not.`

- [ ] **Step 6: Verify no stale numbers remain**

Run: `grep -rn "107 tests\|252 " AGENTS.md README.md docs/ | grep -v "2026-09-27-convo-realignment-design"`
Expected: no output. (The spec's own explanatory sentence is excluded by the `grep -v` and is intentionally retained.)

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md README.md docs/GOALS.md docs/superpowers/specs/2026-09-27-convo-realignment-design.md
git commit -m "docs: correct test floor to 263 and point roadmap at GOALS.md"
```

---

### Task 2: Characterize the current renderer before replacing it

This is the safety net. These tests pass against today's code and must still pass after the rewrite. Written **first**, so a rewrite regression is caught by a test that already existed.

**Files:**
- Create: `src/components/chat/__tests__/fixtures/streamShapes.ts`
- Create: `src/lib/__tests__/streamingParity.test.ts`

**Interfaces:**
- Consumes: `renderMarkdown(text: string): string` from `src/lib/markdown.ts`; `createStreamRenderer(el, opts): StreamRenderer` from `src/lib/streamingRenderer.ts`.
- Produces: `STREAM_SHAPES: StreamShape[]` where

```ts
export interface StreamShape {
  /** Stable id used in test names. */
  name: string;
  /** The complete message text. */
  full: string;
  /** Prefix lengths at which the renderer is fed `full.slice(0, n)`. */
  cutPoints: number[];
}
```

Task 3 imports `STREAM_SHAPES` to test the new splitter against the same corpus. Task 6 imports it for the parity gate.

- [ ] **Step 1: Write the shape corpus**

Create `fixtures/streamShapes.ts` exporting `STREAM_SHAPES`. Include at least these 20 shapes, each with `cutPoints` that land mid-construct as well as at boundaries:

`paragraph`, `twoParagraphs`, `headingThenParagraph`, `nestedList`, `looseListWithBlankLines`, `gfmTable`, `taskList`, `blockquote`, `blockquoteWithLazyContinuation`, `closedCodeFence`, `codeFenceWithLanguage`, `tildeFence`, `unclosedCodeFence`, `fourBacktickOpenerThreeBacktickClose`, `inlineEmphasisAcrossLines`, `inlineCodeSpanningFenceText`, `htmlLikeAngleBrackets`, `linkWithParens`, `strikethroughAndAutolink`, `mixedEverything`, `trailingBlankLines`, `whitespaceOnly`, `singleNewline`, `veryLongSingleLine` (20,000 chars, generated in the factory not as a literal).

- [ ] **Step 2: Write the cut-safety characterization test**

In `streamingParity.test.ts`, for every shape, for every cut point `n`, assert the segmenter's safety contract holds:

```ts
const { boundaries } = /* findBoundaries is private; assert via splitFinalized */
const cut = splitFinalized(shape.full.slice(0, n), renderMarkdown, 0);
expect(renderMarkdown(shape.full.slice(0, cut)) + renderMarkdown(shape.full.slice(0, n).slice(cut)))
  .toBe(renderMarkdown(shape.full.slice(0, n)));
```

This test passes today. It is the definition of "freezing did not change the output" and it is what the new splitter must also satisfy.

- [ ] **Step 3: Write the replay characterization test**

For every shape, drive `createStreamRenderer` through `cutPoints` in ascending order, calling `update(shape.full.slice(0, n))` then `finalize()`. Assert `container.innerHTML` equals `renderMarkdown(shape.full)`.

This is the "what does the user actually see" assertion. It passes today for well-formed input and is expected to fail today for `fourBacktickOpenerThreeBacktickClose` — the documented `streamingSegmenter.ts:33-37` limitation. If it fails for that shape only, mark it `.fails` with a comment naming the known limitation rather than leaving a red test. The new implementation is expected to pass it; Task 6 promotes it to a hard assertion.

- [ ] **Step 4: Write the append-only precondition violation test**

Document the precondition violation from Review Focus case 1: feed the renderer `update("para one\n\npara two")`, then `update("para ONE\n\npara two")`. Assert current behavior so the change is visible:

```ts
// Records today's behavior: a non-append-only update leaves stale frozen
// blocks. Task 6 makes the new renderer self-heal; this test is inverted there.
```

Assert `container.textContent` still contains `para one` (lowercase `one`). Do not fix it in this task.

- [ ] **Step 5: Run the tests to verify they pass (or fail as annotated)**

Run: `npm run test:run -- src/lib/__tests__/streamingParity.test.ts`
Expected: PASS, with the two annotated cases behaving as described in Steps 3 and 4.

- [ ] **Step 6: Verify the full suite is still green**

Run: `npm run typecheck && npm run test:run`
Expected: 263 + the new tests, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add src/components/chat/__tests__/fixtures/streamShapes.ts src/lib/__tests__/streamingParity.test.ts
git commit -m "test(stream): characterize current renderer before replacing it"
```

---

### Task 3: Pure block splitter

**Files:**
- Create: `src/lib/markdownBlocks.ts`
- Create: `src/lib/__tests__/markdownBlocks.test.ts`

**Interfaces:**
- Consumes: `STREAM_SHAPES` from `Task 2` fixtures.
- Produces:

```ts
/** Blocks that can no longer change, plus the live growing tail. */
export interface BlockSplit {
  /** Source of each finalized block, in order. Never changes once produced. */
  frozen: string[];
  /** The still-growing trailing block. Changes on nearly every frame. */
  tail: string;
}

/**
 * Split accumulated markdown source into finalized blocks and a live tail.
 *
 * Contract: every block in `frozen` is a maximal top-level run of source that
 * cannot be extended by more input. A caller MAY render `frozen` once and
 * never touch it again.
 *
 * Pure. No DOM, no React, no rendering, no global state.
 */
export function splitBlocks(text: string): BlockSplit;
```

- [ ] **Step 1: Write the failing splitter tests**

In `markdownBlocks.test.ts`:

```ts
it("never splits inside a fenced code block", () => {
  const { frozen, tail } = splitBlocks("intro\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nafter");
  expect(frozen).toContain("```ts\nconst a = 1;\nconst b = 2;\n```");
});

it("keeps the unterminated fence in the tail", () => {
  const { frozen, tail } = splitBlocks("intro\n\n```ts\nconst a = 1;");
  expect(tail).toBe("```ts\nconst a = 1;");
});

it("returns an empty tail for text with no trailing block", () => {
  const { tail } = splitBlocks("one\n\ntwo\n\n");
  expect(tail).toBe("");
});
```

Then the parametrized sweep over `STREAM_SHAPES`, asserting for every cut point `n` of every shape:

```ts
const split = splitBlocks(shape.full.slice(0, n));
// Concatenating every block must reproduce the input exactly.
expect([...split.frozen, split.tail].join("")).toBe(shape.full.slice(0, n));
// The last frozen block must not be extendable: feeding more text must not
// change it. Assert by re-splitting the next cut point and comparing.
```

- [ ] **Step 2: Add the five Review Focus cases**

Each as its own named test:

- `rewrittenEarlierTextIsNotAppendOnly` — `splitBlocks` is a pure function of its input, so calling it on corrected text yields the corrected split. Assert `splitBlocks("para ONE\n\ntwo").frozen` reflects the new text. (The new renderer is stateless per render, so this is free — the test pins it.)
- `splitsOnCodePointBoundariesNotCodeUnits` — text containing `"👨‍👩‍👧‍👦 family emoji"`, a combining sequence `"é"`, and an RTL run `"אבגדה"`. Assert every frozen block ends at a code-point boundary: `expect(block).not.toMatch(/[\u200D]$/)` and every block re-encodes to itself after a lone-surrogate check.
- `staysLinearOnAVeryLongSingleLine` — 20,000 chars, no blank lines. Assert `splitBlocks` returns and that `frozen` has at most 1 entry. (Correctness of speed is gated by the perf test in Task 7, not by wall-clock in a unit test.)
- `mismatchedFenceLengths` — the `fourBacktickOpenerThreeBacktickClose` shape. Assert the 3-backtick line does **not** close a 4-backtick fence, so the block stays in `tail`.
- `degenerateInputs` — `""`, `"   "`, `"\n"`, `"\n\n\n"`, `"a\n\n\n\nb"`. Assert no throw and no empty-string entries in `frozen`.

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test:run -- src/lib/__tests__/markdownBlocks.test.ts`
Expected: FAIL — `splitBlocks` is not exported (module does not exist).

- [ ] **Step 4: Implement `splitBlocks` in `src/lib/markdownBlocks.ts`**

Single-pass line scanner, O(n) in the text length, with a cursor that only ever moves forward. A block is finalized when one of these holds at top level (not inside a fence):

- a blank-line run is followed by another non-blank line, **and** the block being closed is a standalone construct (paragraph, heading, table, or complete fence) — not a list, blockquote, or lazy continuation, whose rendering depends on what follows;
- a code fence has just closed (always safe, unconditionally).

Track fence state with the same rule as `streamingSegmenter.ts:50`: a fence delimiter line is `/^ {0,3}(`{3,}|~{3,})(.*)$/`, and a close requires the same marker character, a length at least as long as the opener, and an empty info string.

Unlike `splitFinalized`, do **not** call the renderer to verify each cut. React memoization means a mis-cut produces a wrong render, not corrupted DOM, and the conservative boundary rules above are what prevent mis-cuts. Dropping the `cutIsRenderSafe` self-check is what makes this ~60 lines instead of ~200.

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test:run -- src/lib/__tests__/markdownBlocks.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify the cut-safety property also holds for the new splitter**

Add one test that reuses `Task 2`'s contract, replacing `splitFinalized` with `splitBlocks`:

```ts
it("freezing with splitBlocks does not change rendered output", () => {
  for (const shape of STREAM_SHAPES) {
    for (const n of shape.cutPoints) {
      const prefix = shape.full.slice(0, n);
      const { frozen, tail } = splitBlocks(prefix);
      const joined = [...frozen, tail].join("");
      expect(renderMarkdown(joined)).toBe(renderMarkdown(prefix));
    }
  }
});
```

`renderMarkdown` is imported from `src/lib/markdown.ts` — it still exists at this point and is only removed in Task 6.

- [ ] **Step 7: Verify the full suite**

Run: `npm run typecheck && npm run test:run`
Expected: 0 failures.

- [ ] **Step 8: Commit**

```bash
git add src/lib/markdownBlocks.ts src/lib/__tests__/markdownBlocks.test.ts
git commit -m "feat(stream): add pure markdown block splitter"
```

---

### Task 4: React-native streaming tail

**Files:**
- Create: `src/components/chat/StreamingTail.tsx`
- Create: `src/components/chat/__tests__/StreamingTail.test.tsx`

**Interfaces:**
- Consumes: `splitBlocks(text): BlockSplit` from `Task 3`; `MarkdownRenderer` from `src/components/chat/MarkdownRenderer.tsx`; `StreamingSectionProps` from `src/components/chat/types.ts`.
- Produces:

```ts
export function StreamingTail(props: StreamingSectionProps): JSX.Element | null;
```

Same props contract as the component it replaces (`sessionId`, `stickToBottomRef`, `onBumpScroll`) so `ChatViewNew` changes by one import.

- [ ] **Step 1: Write the frozen-block render test**

```tsx
it("never re-renders a frozen block while the tail grows", () => {
  const renderSpy = vi.fn();
  // Render with a short body, then re-render with a much longer body and
  // assert the first block's component did not re-render.
});
```

Assert on a `vi.fn()` wrapper around the block component, not on `MarkdownRenderer` internals. Delta in frozen-block renders between the two renders must be exactly 0.

- [ ] **Step 2: Write the streaming/settled structural parity test**

This is the real parity gate, replacing the spec's byte-identical HTML comparison.

```tsx
it("renders streamed and settled content with identical structure", () => {
  for (const shape of STREAM_SHAPES) {
    const streamed = renderToStaticMarkup(<StreamingTailBody text={shape.full} />);
    const settled = renderToStaticMarkup(<MarkdownRenderer content={shape.full} />);
    expect(normalizeForCompare(streamed)).toBe(normalizeForCompare(settled));
  }
});
```

`normalizeForCompare` strips React comment markers and collapses whitespace so only structure is compared. Export it from the test file. This test is expected to fail for the GFM shapes until Step 5 lands, which is the point — it is what proves the current two-renderer defect is gone.

- [ ] **Step 3: Write the empty/degenerate render test**

`<StreamingTail text="" />`, `text="   "`, `text="\n"` → renders the pulse indicator, no blocks, no throw.

- [ ] **Step 4: Run to verify it fails**

Run: `npm run test:run -- src/components/chat/__tests__/StreamingTail.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 5: Implement `StreamingTail.tsx`**

```tsx
export function StreamingTail({ sessionId, stickToBottomRef, onBumpScroll }: StreamingSectionProps)
```

- Reads `streaming`, `streamContent`, `streamThinking` from `useChatStreamStore` using the **inline arrow selectors copied verbatim from `StreamingSection.tsx:18-26`**, e.g. `useChatStreamStore((s) => s.sessions[sessionId]?.streamContent ?? "")`. Do **not** import `selectStreamSlice` from Task 5 — this task runs before it. Task 5 formalizes these into named exports later; the selectors themselves do not change.
- Returns `null` when `!streaming`.
- Renders, in order: the thinking panel (unchanged markup from `StreamingSection.tsx:68-72`), then a `MarkdownBlocks` list, then the pulse indicator when there is no content and no thinking (unchanged markup from `StreamingSection.tsx:79-85`).
- `MarkdownBlocks` is a local `React.memo` component taking `blocks: string[]`; it maps to a `React.memo` `MarkdownBlock` per entry keyed by index, each rendering `<MarkdownRenderer content={block} />`. Because a frozen block's string never changes, `MarkdownRenderer`'s existing memo (which already keys on `content` alone) skips the parse.
- `useEffect` on `[streamContent]`: if `stickToBottomRef.current` is true, call `onBumpScroll()` — preserving `StreamingSection.tsx:58-59`'s same-frame scroll.
- `memoize` the `splitBlocks` result with `useMemo` keyed on `streamContent`.
- No `useRef`, no direct DOM writes, no `dangerouslySetInnerHTML`.

- [ ] **Step 6: Run to verify it passes**

Run: `npm run test:run -- src/components/chat/__tests__/StreamingTail.test.tsx`
Expected: PASS, including the structural parity test for all GFM shapes.

- [ ] **Step 7: Verify the full suite**

Run: `npm run typecheck && npm run test:run`
Expected: 0 failures.

- [ ] **Step 8: Commit**

```bash
git add src/components/chat/StreamingTail.tsx src/components/chat/__tests__/StreamingTail.test.tsx
git commit -m "feat(stream): React-native streaming tail with frozen block memoization"
```

---

### Task 5: Store slice subscriptions

The store mirrors mutable session state in a module-level `Map` and forces re-renders with a hand-maintained `version` counter and a `bump()` function on every mutation (`chatStream.ts:455-471`, `bump` at `:140-147`). Every mutation site must remember to call `bump`; missing one is a silent stale-UI bug. This task makes zustand the single source of truth.

**Files:**
- Modify: `src/stores/chatStream.ts` (`ChatStreamStore` interface ~`:460-471`, `bump` ~`:140-147`, `getOrCreate` ~`:400-457`, `evictSessionState` ~`:132-151`)
- Test: `src/stores/__tests__/chatStreamStore.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:

```ts
/** Select the streaming slice for one session. Stable across unrelated sessions. */
export function selectStreamSlice(sessionId: string): (s: ChatStreamStore) => StreamSlice | undefined;

/** Select the frozen message list for one session. Reference-stable while streaming. */
export function selectMessages(sessionId: string): (s: ChatStreamStore) => ChatMessage[] | undefined;

export interface StreamSlice {
  streaming: boolean;
  streamContent: string;
  streamThinking: string;
  status: ChatStatus;
  error: string | null;
}
```

`version` and `bump` are **removed** from the public surface.

- [ ] **Step 1: Write the failing reference-stability test**

```ts
it("message array reference is stable while a stream appends", () => {
  const before = selectMessages("s1")(store.getState());
  // drive a chunk through the public listener path
  const after = selectMessages("s1")(store.getState());
  expect(after).toBe(before);
});

it("a session's stream slice is untouched by another session's chunks", () => {
  // append to s2, assert selectStreamSlice("s1") returns a deep-equal but
  // not-throwing value and that s1's slice reference is unchanged when idle
});
```

- [ ] **Step 2: Write the no-manual-bump test**

Assert that mutating a session through the store's own actions updates the slice **without** any caller having invoked a bump. Enumerate the mutation entry points and assert each one alone is enough.

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test:run -- src/stores/__tests__/chatStreamStore.test.ts`
Expected: FAIL — selectors not exported; `version` still required for updates.

- [ ] **Step 4: Rework the store**

- Delete `version` from `ChatStreamStore` and delete `bump`.
- Make `getOrCreate(cid)` and every mutation go through `useChatStreamStore.setState` directly, so zustand's own change detection drives re-renders.
- Keep `stateBySession`, `terminalStreams`, `pendingDeltas`, `sessionLoads`, `stopTimers`, and `autoTitled` in module scope — they are app-lifetime registries, not reactive state, and moving them is out of scope.
- Keep `evictSessionState` and `acceptTerminalEvent` exported with their current signatures; other tests import them.
- **Do not touch** `sendMessage`, `recallMemories`, `buildContextBlock`, the listener registration, or the rAF `scheduleFlush` drain. Those are removed or rewritten in Plans 2–4. The rAF batching is correct and load-bearing.

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test:run -- src/stores/__tests__/chatStreamStore.test.ts src/stores/__tests__/chatStreamLifecycle.test.ts src/stores/__tests__/chatStreamTerminal.test.ts src/stores/__tests__/chatPersistence.test.ts`
Expected: PASS. The existing store tests are the regression net for this task — if any of them needed a `version` bump to pass, the rework is wrong.

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm run test:run`
Expected: 0 failures, count ≥ 263.

- [ ] **Step 7: Commit**

```bash
git add src/stores/chatStream.ts src/stores/__tests__/chatStreamStore.test.ts
git commit -m "refactor(stream): make zustand the single source of truth for session state"
```

---

### Task 6: Wire the new tail and delete the DOM renderer

The gate task. Nothing is deleted until the replacement is proven equivalent.

**Files:**
- Modify: `src/components/chat/ChatViewNew.tsx` (import + usage of `StreamingSection`)
- Delete: `src/components/chat/StreamingSection.tsx`
- Delete: `src/lib/streamingRenderer.ts`
- Delete: `src/lib/streamingSegmenter.ts`
- Delete: `src/lib/__tests__/streamingRenderer.test.ts`
- Delete: `src/lib/__tests__/streamingSegmenter.test.ts`
- Delete or rewrite: `src/lib/markdown.ts` — only if `renderMarkdown` has no remaining callers
- Modify: `src/lib/__tests__/streamingParity.test.ts` (from Task 2)

**Interfaces:**
- Consumes: `StreamingTail` (Task 4), `splitBlocks` (Task 3), selectors (Task 5).
- Produces: a `src/` with no DOM-direct streaming code and one markdown renderer.

- [ ] **Step 1: Verify the replacement before deleting anything**

Run: `npm run test:run -- src/components/chat/__tests__/StreamingTail.test.tsx src/lib/__tests__/markdownBlocks.test.ts`
Expected: PASS. If this fails, stop. Do not delete the old renderer.

- [ ] **Step 2: Delete the temporary characterization harness**

`src/lib/__tests__/streamingParity.test.ts` (Task 2) imports `splitFinalized` and `createStreamRenderer` from the modules this task deletes, so it cannot survive them. Its assertions are already superseded — the splitter contracts live in `markdownBlocks.test.ts` and the parity assertions live in `StreamingTail.test.tsx`. Delete it.

`src/components/chat/__tests__/fixtures/streamShapes.ts` **stays**. It lives in its own file precisely so the corpus outlives the harness; Tasks 4, 6, and 7 still import `STREAM_SHAPES`.

The fence-mismatch case that `streamingParity.test.ts` annotated `.fails` is permanently covered by `markdownBlocks.test.ts` → `mismatchedFenceLengths` (Task 3, Step 2). There is nothing to promote.

- [ ] **Step 3: Swap the component in `ChatViewNew.tsx`**

Replace the `StreamingSection` import and its single usage with `StreamingTail`. Props are identical, so this is a two-line change. Also drop the `StreamingSection` re-export from `src/components/chat/index.ts:5` and add `StreamingTail`.

Run: `grep -rn "StreamingSection" src/`
Expected: only `src/components/chat/types.ts` (the `StreamingSectionProps` type name).

- [ ] **Step 4: Confirm the no-visual-jump property end to end**

The defect this rewrite fixes: mid-stream output came from `renderMarkdown`, settled output came from `MarkdownRenderer`, so every message restyles on finalize. After this task there is one renderer. Verify by test, not by reading.

Add to `StreamingTail.test.tsx` a test that renders `StreamingTail` with `streaming: true` and then with `streaming: false` for the **same** content, and asserts the markdown subtree is structurally identical across the transition. Before Task 4 this assertion fails; after it passes.

- [ ] **Step 5: Close Review Focus case 1 — rewritten (non-append-only) content**

Add a test that drives `StreamingTail` through re-renders where the text is *corrected* rather than appended: render with `"para one\n\npara two"`, then re-render with `"para ONE\n\npara two"`, and assert the rendered output shows `para ONE` and not `para one`.

This is the failure mode `streamingRenderer.ts:60-66` documents as an append-only PRECONDITION and no existing test covered. It passes for free here because `StreamingTail` re-derives from `streamContent` every render with no frozen DOM, but it must be pinned by a test or a future refactor could reintroduce a cache that breaks it.

- [ ] **Step 6: Delete the old modules and their tests**

```bash
git rm src/components/chat/StreamingSection.tsx \
       src/lib/streamingRenderer.ts \
       src/lib/streamingSegmenter.ts \
       src/lib/__tests__/streamingRenderer.test.ts \
       src/lib/__tests__/streamingSegmenter.test.ts \
       src/lib/__tests__/streamingParity.test.ts
```

This removes **19 tests** (7 in `streamingRenderer.test.ts`, 9 in `streamingSegmenter.test.ts`, 3 in `streamingParity.test.ts`). Per Global Constraints that is permitted **only** in this commit, because the modules they cover are deleted here. The suite may drop by exactly 19 and no more; anything else means a test for a live module was deleted by accident. Record the delta in the commit body.

- [ ] **Step 7: Keep `src/lib/markdown.ts` — do not delete it**

`renderMarkdown` is no longer on any render path after this task, but it is the **pure test oracle** for the block splitter: `markdownBlocks.test.ts` and `streamingParity.test.ts` both assert that concatenating split blocks reproduces `renderMarkdown(prefix)`. Deleting it would also delete `src/lib/__tests__/markdown.test.ts` (19 tests) for no gain.

Leave both files in place. Mark `markdown.ts` in the commit body as no-longer-rendered, retained as a test oracle, slated for removal in Plan 5 once the splitter's contracts are fully covered by React-level assertions.

- [ ] **Step 8: Verify no DOM-direct streaming code remains**

Run: `grep -rn "createStreamRenderer\|splitFinalized\|describeOpenFence" src/`
Expected: no output.

Separately, `grep -rn "dangerouslySetInnerHTML" src/` — the new streaming path must have zero hits. Pre-existing hits elsewhere in the app are out of scope for this plan; note their count in the commit body so a later plan can pick them up.

- [ ] **Step 9: Run the full suite**

Run: `npm run typecheck && npm run test:run && npm run build`
Expected: 0 failures, count ≥ the Task 5 count minus 19.

- [ ] **Step 10: Commit**

```bash
git add -A src/
git commit -m "refactor(stream): replace DOM-direct renderer with React-native block rendering

Unifies streaming and settled markdown onto MarkdownRenderer, fixing the
visual restyle every completed message had when its stream finalized.
Deletes streamingRenderer.ts and streamingSegmenter.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Performance gate and Phase 1 close

The five invariants from spec §8.2, asserted rather than assumed.

**Files:**
- Create: `src/components/chat/__tests__/streamPerformance.test.tsx`
- Modify: `docs/superpowers/specs/2026-09-27-convo-realignment-design.md` (§8.2 checkboxes)
- Modify: `docs/GOALS.md` (mark the 60fps gate as enforced)

**Interfaces:**
- Consumes: `StreamingTail` (Task 4), `STREAM_SHAPES` (Task 2).
- Produces: the enforced invariant list.

- [ ] **Step 1: Write the 60fps tail test**

Drive a 4,000-token stream through `StreamingTail` by re-rendering with progressively longer `streamContent`. Count `requestAnimationFrame` callbacks between the first and last render. Assert the render loop never blocks longer than 32ms (two frames) for any single update, and that total frames are consistent with one render per frame rather than one per token.

This test must be a **budget assertion**, not a wall-clock assertion on a shared CI machine. Use a `performance.now()` delta per update with a generous ceiling, and a relative assertion (renders must be far fewer than chunks) as the primary signal.

- [ ] **Step 2: Write the frozen-row-never-re-renders test at the integration level**

Task 4 tests the block components. This tests the whole `ChatViewNew` tree: render a session with 20 completed messages, start a stream, feed 100 chunks, assert the total render count of the completed `MessageRow` components is unchanged from before the stream started. This is the v0.6.5 lag regression guard at the level a user would feel it.

- [ ] **Step 3: Write the cancel-immediacy test**

Start a stream, cancel mid-flight, then push 50 more chunks. Assert no store writes occur and the tail content does not change after the cancel. Covers spec §8.2 invariant 3.

- [ ] **Step 4: Run the perf suite**

Run: `npm run test:run -- src/components/chat/__tests__/streamPerformance.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full verification trio**

Run: `npm run typecheck && npm run test:run && npm run build`
Expected: 0 type errors, 0 test failures, build succeeds.

- [ ] **Step 6: Confirm Rust is untouched**

Run: `git diff main --stat -- src-tauri/`
Expected: no output.

- [ ] **Step 7: Update the spec and goals docs**

Mark the five §8.2 invariants as enforced with the test file that enforces each. In `docs/GOALS.md`, the 60fps gate row is already written as a hard gate; leave it, and add the enforcing test path.

- [ ] **Step 8: Commit**

```bash
git add src/components/chat/__tests__/streamPerformance.test.tsx docs/
git commit -m "test(stream): enforce the five streaming invariants as performance gates"
```

---

## Out of Scope — the next plans

This plan covers spec Phase 0 and Phase 1 only. Remaining phases, each to be its own plan written at its phase boundary so its interfaces are real rather than guessed:

| Plan | Spec phase | Starts from |
|---|---|---|
| 2 | Phase 2 + 3 — `V006__unified_index.sql`, retrieval config, ollama-cloud provider, `/api/embed` | Streaming and store stable |
| 3 | Phase 4 + 5 — hybrid retrieval, RRF, extraction, revision | Plan 2's schema and embeddings |
| 4 | Phase 6 + 7 — notes wiring, Rust-owned context assembly, delete `recallMemories` | Plan 3's retrieval |
| 5 | Phase 8 + 9 — nav reorder, Memory/Notes/review UI, release gates | Plan 4's context assembly |

Plan 4 is the one that finally deletes `chatStream.ts:736-787` (`recallMemories`) and `stores/memory.ts buildContextBlock`. Until then the old substring scorer stays in the tree, unused by the new streaming path but still wired into `sendMessage`.
