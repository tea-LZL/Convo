# Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the app shell, every page, and both palettes to the approved reference design, and surface memory-system state in the sidebar — without adding a single new theme key.

**Architecture:** Every new visual treatment is composited from the 26 existing theme keys with `color-mix()`, so all six built-in themes and every user-authored theme follow automatically. No new tokens, no `themes.rs` edits, no migration. Work proceeds foundation → primitives → shell → the Memory page as a proof → the remaining pages.

**Tech Stack:** React 18, Zustand, Tailwind 3.4 (theme-var-driven config), Tauri 2, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-27-visual-redesign-design.md` — the spec is the authority; this plan is the decisions it does not make.

## Global Constraints

- **TypeScript test floor: 403 passing, 0 failures.** It may only rise. **Rust floor: 275 passing**, unchanged (this plan touches no Rust).
- Gates: `npm run typecheck`, `npm run test:run`, `npm run build`.
- **No new dependency.** No new npm package. Playwright is explicitly out of scope, so no screenshot-diff testing.
- **Add no theme key.** The 26 keys in `src-tauri/src/themes.rs` are the entire vocabulary, and all six built-in themes define exactly those. A new key is undefined in every theme and produces a hybrid. Compose with `color-mix(in oklab, …)` instead.
- **Never hardcode a hex, rgb, or hsl literal in a class.** Colours are Tailwind aliases reading CSS vars (`bg-surface-1`, `text-muted`, `border-border`, `accent`, `text-subtle`, `bg-surface-2`). Composited values go in `globals.css` as named vars, not inline in JSX.
- **The palette does not change.** `--color-bg: #0f1014` and `--color-accent: #7c6df0` stay. See spec D2.
- No `density` setting work. `stores/settings.ts` has an unused `density` field; it stays unused (spec D5). Data-page density is expressed as tighter spacing on those three pages.
- Named exports. 2-space JSX indentation. Import order React → third-party → local.
- Sidebar width is unchanged: `w-60` is already 240px; the 64px collapsed rail exists. Touch neither.

## Review Focus

1. **A theme other than Default Dark/Light.** Solar, Forest, Mono, and High Contrast are four of the six built-ins. The composited active row and glow must derive from *that theme's* accent, not from the default. This is the failure the whole D1 decision exists to prevent, and nothing about it is visible on the default theme. → Task 1.
2. **`prefers-reduced-motion` set.** The glow and nav transitions must not animate. A user with vestibular sensitivity is the reason the flag exists. → Task 3.
3. **A long model name or a 200-word memory title in a 240px column.** Must truncate. Overflow breaks the sidebar's width contract and pushes the content pane. → Task 3.
4. **The status fetch fails or is slow.** The sidebar must render without the card. A status card must never be the reason a sidebar fails. → Task 3.
5. **A narrow window.** Sidebar plus content must not squeeze the content pane to zero. → Task 4.

---

## Decisions the implementer cannot make alone

**Composited values live in `globals.css` as named vars, not inline in JSX.** Add e.g. `--color-nav-active`, `--color-nav-glow`, `--color-group-header` — **no.** That reintroduces D1's failure. Instead add them as *Tailwind config* entries that compose from existing vars at use site:

```ts
// tailwind.config.ts — extend.colors
"nav-active": "color-mix(in oklab, var(--color-accent) 14%, var(--color-surface-2))",
"nav-glow": "color-mix(in oklab, var(--color-accent) 45%, transparent)",
```

This is the crux of the plan. A Tailwind alias that composes two existing vars is theme-following by construction, needs no new CSS custom property, and no theme defines or overrides it. Values are the ones spec §3 pins.

**The four existing `toHaveClass` assertions split into two kinds, and only one kind may be retargeted freely:**

| Location | Asserts | Disposition |
|---|---|---|
| `Form.test.tsx:16` | `appearance-none bg-surface-2 text-text pr-8` | Pure decoration. Replace with a behavioural assertion (the select exposes its options and reports the chosen value). |
| `Form.test.tsx:28` | `disabled:opacity-100 disabled:cursor-not-allowed` | **Encodes meaning** — that a disabled control is *visibly* disabled. Keep the assertion in substance: `toBeDisabled()` plus an assertion that a disabled-affordance class is present, whichever class that ends up being. Do not reduce it to `toBeDisabled()` alone; that would pass on an invisible disabled control. |
| `NotesRoute.test.tsx:135` | `line-through` on a superseded note | **Encodes meaning** — superseded is distinguished visually. Keep it. If the restyle replaces `line-through` with a custom treatment, update the assertion to that treatment rather than dropping it. |
| `NotesRoute.test.tsx:137` | `not.toHaveClass("line-through")` on a live note | Same. Keep. |

**Nav region structure.** One array, grouped:

```ts
const NAV_GROUPS: { header?: string; items: NavItem[] }[] = [
  { items: [chat, notes, memory] },
  { header: "OTHER", items: [compare, documents, tasks] },
];
```

**Status card states** — three, from `KnowledgeIndexStatus`:

| Condition | Chip | Text |
|---|---|---|
| `embeddingModel` set, `needsReindex` false, `needsEmbedding === 0` | `success` | `live` |
| `embeddingModel` set, `needsReindex` true | `warn` | `needs reindex` |
| `embeddingModel` null | `text-subtle` | `off` |

When `semanticNote` is non-null, render it **verbatim** under the chip. A second wording of the same warning in TypeScript is how the two drift.

**Density.** Memory, Documents, and Tasks use compact row spacing. Chat, Notes, Settings, Compare use the standard rhythm. No toggle; the choice is per page and fixed.

---

### Task 1: Foundation — the composited tokens, and the streaming guard

Nothing visible ships here. Two things: prove the composition works, and install the
perf guard *before* anything is restyled, so the risk is measured rather than asserted.

**Files:**
- Modify: `tailwind.config.ts` (add the three composited aliases)
- Modify: `src/components/chat/__tests__/streamPerformance.test.tsx` (add the structural guard)
- Test: `src/components/ui/__tests__/tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Tailwind classes `bg-nav-active`, `shadow-nav-glow`, `text-group-header`, available to every later task. Plus the structural invariant later tasks must not violate.

- [ ] **Step 1: Write the failing composition test**

The test must prove the aliases resolve through the *active theme's* variables, not the default. Set a non-default accent on `:root`, assert a nav-active element's computed background contains that accent's channel, then set it back.

```ts
it("composes nav-active from the active theme's accent, not the default", () => {
  // Set a distinctly non-default accent, as applyTheme would.
  document.documentElement.style.setProperty("--color-accent", "rgb(1, 2, 3)");
  // Assert the composited background reflects (1,2,3) mixed into surface-2 —
  // not #7c6df0. Then restore.
});
```

A test that only checks the alias exists proves nothing; this is Review Focus 1.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:run -- tokens`
Expected: FAIL — the class does not exist yet.

- [ ] **Step 3: Add the aliases to `tailwind.config.ts`**

Two are colours; the glow is a `boxShadow`, because a colour alias cannot produce a
`shadow-*` class on its own — `shadow-nav-glow` has to come from a `boxShadow` entry, not a
`colors` one. All three compose from existing vars, so all three are theme-following.

```ts
// theme.extend.colors — two composited from existing vars, one a direct alias
"nav-active": "color-mix(in oklab, var(--color-accent) 14%, var(--color-surface-2))",
"group-header": "var(--color-text-subtle)",

// theme.extend.boxShadow — a right-edge bloom, never animated
"nav-glow": "6px 0 20px color-mix(in oklab, var(--color-accent) 45%, transparent)",
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm run test:run -- tokens`
Expected: PASS.

- [ ] **Step 5: Add the streaming structural guard**

In `streamPerformance.test.tsx`, add two tests:

- No element inside the streaming message subtree carries a `box-shadow`, `filter`, or `transition` style. Render `MessageList` with a few messages and walk the rendered output.
- `messageRowAreEqual` accounts for every prop. If Task 5 or a later task adds a prop, this must fail until the comparator names it. Verify the test bites: add a prop to `MessageRowProps`, leave the comparator alone, confirm red, then add the comparator entry and confirm green. **Report both runs** — a guard that does not fail on the mutation it exists to catch is worse than none.

- [ ] **Step 6: Run the full gates**

Run: `npm run typecheck && npm run test:run && npm run build`
Expected: green; ≥ 403 + your new tests.

- [ ] **Step 7: Commit**

```
git commit -m "feat(tokens): composited nav tokens, and a streaming paint guard

Three Tailwind aliases composed from existing vars with color-mix, not
new CSS custom properties. All six built-in themes define the same 26
keys, so a new custom property would be undefined in every theme and a
Solar user would get Solar's palette with default-coloured new chrome.
A Tailwind alias that composes two existing vars is theme-following by
construction.

The guard is structural, not numeric: jsdom cannot measure frame rate, so
it asserts that the streaming subtree gains no box-shadow, filter, or
transition, and that MessageRow's comparator accounts for every prop. The
comparator assertion is verified by mutating a prop out and confirming
red — a guard that does not fail on its own mutation is theatre."
```

---

### Task 2: The shared primitives

Every page inherits the new look through these, so they go before the shell.

**Files:**
- Modify: `src/components/ui/Button.tsx`, `IconButton.tsx`, `Form.tsx`, `Select` (inside `Form.tsx`), `Switch` (inside `Form.tsx`), `Modal.tsx`, `Panel.tsx`, `EmptyState.tsx`, `Skeleton.tsx`, `Dropdown.tsx`
- Modify: `src/components/ui/__tests__/Form.test.tsx` (the two assertions, per the table above)
- Test: existing `src/components/ui/__tests__/`

**Interfaces:**
- Consumes: `bg-nav-active`, `shadow-nav-glow`, `text-group-header` from Task 1.
- Produces: the same component APIs, restyled. **No prop signatures change** — if a primitive needs a new prop to express the new look, that is a signal the design is wrong, not that a prop is missing.

- [ ] **Step 1: Read before writing**

Read all ten files. Note which use `shadow-panel`/`shadow-modal` and which use a literal. The spec keeps shadows off cards — so a `shadow-panel` on a card surface is removed, while a modal keeps `shadow-modal` (it floats above content and the reference's dialog treatment needs it).

- [ ] **Step 2: Re-target the Form assertions per the table**

`Form.test.tsx:16` becomes a behavioural assertion. `Form.test.tsx:28` keeps its substance: assert the disabled affordance survives, whichever class carries it. **Do not reduce line 28 to `toBeDisabled()` alone.**

- [ ] **Step 3: Write failing tests for the restyled states**

Per primitive, at minimum: default and hover, disabled, focus-visible, and (for Modal and Dropdown) open. Focus-visible must use a token-derived ring, not a literal.

- [ ] **Step 4: Restyle, then confirm**

Run: `npm run typecheck && npm run test:run`
Expected: green; floor holds.

- [ ] **Step 5: Commit**

```
git commit -m "feat(ui): restyle the shared primitives

No prop signatures change. If a primitive needed a new prop to express
the new look, the design was wrong rather than the prop missing.

The two Form class assertions split: one was pure decoration and became
behavioural, the other encodes that a disabled control is visibly
disabled and keeps its substance. Reducing it to toBeDisabled() alone
would pass on a control that looks enabled."
```

---

### Task 3: Shell — sidebar, page chrome, status card

**Files:**
- Create: `src/components/sidebar/StatusCard.tsx`
- Modify: `src/components/sidebar/Sidebar.tsx` (header, search row, `NAV_GROUPS`, 40px rows, group header, status card placement)
- Modify: `src/components/ui/RouteShell.tsx` (page title + action cluster)
- Test: `src/components/sidebar/__tests__/`, a new `src/components/sidebar/__tests__/StatusCard.test.tsx`

**Interfaces:**
- Consumes: Task 1's aliases; `api.knowledgeIndexStatus(): Promise<KnowledgeIndexStatus>` → `{ memoryCount, noteCount, embeddedCount, needsEmbedding, needsReindex, embeddingModel, semanticNote }`.
- Produces: `StatusCard` — self-contained, component-local state, no new store. `RouteShell` gains an optional `actions?: ReactNode` prop for the right-aligned cluster.

- [ ] **Step 1: Write the failing tests**

Cover Review Focus 2, 3, and 4:
- three status states, per the table in Decisions;
- `semanticNote` rendered **verbatim** — assert the exact string round-trips, so a reworded copy fails;
- a long `embeddingModel` string truncates rather than overflowing;
- a rejected `knowledgeIndexStatus` promise renders **no** card and does not throw;
- nav renders the two groups with an `OTHER` header between them;
- under `prefers-reduced-motion`, no `transition` or `animation` class reaches a nav row.

- [ ] **Step 2: Run and confirm they fail**

Run: `npm run test:run -- StatusCard Sidebar`
Expected: FAIL.

- [ ] **Step 3: Restyle the sidebar**

Keep `w-60` and the collapsed rail untouched. Add the wordmark header, the search row (opens the existing `CommandPalette`; hint from `comboDisplay`, never a literal `⌘K`), `NAV_GROUPS`, 40px rows, the active row using `bg-nav-active` + `shadow-nav-glow`, and the group header using `text-group-header`.

The search row **does not implement a new search** — it opens the existing palette.

- [ ] **Step 4: Add `StatusCard` and mount it below the scroll region**

- [ ] **Step 5: Restyle `RouteShell` with the title and action cluster**

The reference's "View:" pill appears **only where a real view toggle exists**. Add the `actions` prop; callers pass their own cluster. Do not add a decorative dropdown anywhere.

- [ ] **Step 6: Run the full gates**

Run: `npm run typecheck && npm run test:run && npm run build`
Expected: green.

- [ ] **Step 7: Commit**

```
git commit -m "feat(sidebar): grouped nav, a search row, and a memory status card

Three regions in order: nav, conversations, status. The status card sits
below the scroll region so a degraded index is visible without
navigating, which is the point of putting it there.

Rust's semantic_note is rendered verbatim, asserted by exact string, so a
second wording in TypeScript fails the test instead of drifting.

The search row opens the existing command palette rather than
implementing a new search, and its hint comes from comboDisplay, so it
reads Cmd K on macOS and Ctrl K on Linux."
```

---

### Task 4: The Memory page — the proof

The densest, most feature-rich surface. If the foundation survives this, it survives the rest.
Review it as the pattern the other pages follow.

**Files:**
- Modify: `src/routes/MemoryRoute.tsx`
- Test: `src/routes/__tests__/MemoryRoute.test.tsx`

**Interfaces:**
- Consumes: Task 2's primitives, Task 3's `RouteShell` action cluster.
- Produces: the reference pattern for a dense data page — **compact row spacing**, unlike the standard rhythm elsewhere.

- [ ] **Step 1: Write the failing tests**

Cover Review Focus 5 (narrow window: the content pane keeps a usable minimum width and the sidebar does not grow) and the density decision (rows use compact spacing, asserted as a computed style or a spacing token — not a class-name snapshot).

- [ ] **Step 2: Restyle with compact density**

- [ ] **Step 3: Run the full gates and review this as the pattern**

Run: `npm run typecheck && npm run test:run && npm run build`
Expected: green. **This is the review gate for the whole design.** If the composition, the active row, the card treatment, or the density split does not hold up on the hardest page, fix it here rather than propagating it five more times.

- [ ] **Step 4: Commit**

```
git commit -m "feat(memory): the redesigned dense page

Compact row spacing here rather than the standard rhythm: a memory list
you can only see six rows of is a worse tool. Same tokens, same borders,
less air. Reviewed as the pattern the remaining pages follow."
```

---

### Task 5: Chat — the streaming surface

The one surface that re-renders at 60fps. Task 1's guard already exists; this task must not
break it.

**Files:**
- Modify: `src/components/chat/ChatViewNew.tsx` and its page chrome
- Modify: `src/components/chat/MessageRow.tsx` **only if** the new look requires a prop
- Test: `src/components/chat/__tests__/streamPerformance.test.tsx` (must stay green)

**Interfaces:**
- Consumes: Task 2's primitives, Task 3's page chrome.
- Produces: nothing new. **If `MessageRow` gains a prop, `messageRowAreEqual` must name it in the same change** — Task 1's guard will fail otherwise, which is the point.

- [ ] **Step 1: Restyle the chat page chrome**

- [ ] **Step 2: If `MessageRow` changes, extend the comparator in the same edit**

Report explicitly whether it changed and what you added. If it did not change, say so — that is a good outcome, not a gap.

- [ ] **Step 3: Confirm the streaming guard is still green**

Run: `npm run test:run -- streamPerformance`
Expected: PASS, including both Task 1 guard tests.

- [ ] **Step 4: Run the full gates and commit**

```
git commit -m "feat(chat): restyle the streaming surface

No per-row paint cost added. If MessageRow gained a prop, the comparator
names it in the same change — the Task 1 guard fails otherwise."
```

---

### Task 6: The remaining pages

Notes, Compare, Documents, Tasks, Settings. Mechanical once the pattern is proven. Documents
and Tasks use compact density; the others use the standard rhythm.

**Files:** `src/routes/NotesRoute.tsx`, `CompareRoute.tsx`, `DocumentsRoute.tsx`, `TasksRoute.tsx`, `SettingsRoute.tsx`, and the new `src/routes/settings/KnowledgeSection.tsx` (from the earlier Phase 8 task, already built).
- Test: each route's existing test file.

- [ ] **Step 1: Restyle each route, its own test, its own commit**

One commit per route. Do not batch them: a reviewer who dislikes the Notes treatment should be able to reject that commit alone.

- [ ] **Step 2: Run the full gates after each**

Expected: green; floor holds at or above 403 throughout.

- [ ] **Step 3: Commit per route**

Each commit names its route and its density choice.

---

### Task 7: Close-out — a11y and the spec tick

**Files:** test files as needed; `docs/superpowers/specs/2026-09-27-visual-redesign-design.md`.

- [ ] **Step 1: Accessibility pass over every changed surface**

Every interactive element has a reachable accessible name and is keyboard operable. The new nav rows, the search row, the status card's chips, and the recall-panel input. Focus styles use a token-derived ring.

- [ ] **Step 2: Verify the no-new-keys invariant mechanically**

Run: `grep -rnE "#[0-9a-fA-F]{3,8}|rgb\(|hsl\(" src/components src/routes src/components/ui --include=*.tsx | grep -v test`
Expected: **empty.** Any hit is a literal that must become a token or a `color-mix` alias.

Also confirm `src-tauri/src/themes.rs` and `globals.css`'s existing key set are **unmodified** — `git diff --stat` over both must be empty.

- [ ] **Step 3: Tick the spec's success criteria honestly**

Criteria 2, 3, 4 are mechanically checkable and should be marked met. **Criterion 1 — every route renders correctly on all six themes — is verified by human review against the reference, not by a test.** Mark it as human-verified, and record in the spec that no screenshot-diff tooling exists. Do not tick it as though a test proved it.

- [ ] **Step 4: Run every gate and commit**

Run: `npm run typecheck && npm run test:run && npm run build && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: green; TS ≥ 403; Rust 275 unchanged.

---

## Not in this plan

- **Screenshot regression testing.** Needs Playwright; new dependency.
- **Phase 8 Task 5** — add-to-chat and `/remember`. Feature work; lands after the surface settles.
- **The recall panel and supersede history** (Phase 8 Tasks 3–4). They land in the new vocabulary in a follow-up, built on this surface rather than alongside it.
- **The `density` setting** — left unused, per spec D5.
- **`config::embed_all_notes`**, defined in Rust and called from nowhere. Needs one line of Rust to close; this plan touches no Rust.
- **The extraction-failure visibility gap.** Still the highest-value open item in the project, and unrelated to visual work.
