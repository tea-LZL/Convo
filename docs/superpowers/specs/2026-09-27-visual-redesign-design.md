# Visual Redesign — Design Spec

Date: 2026-09-27 · Branch: `realignment` · Status: awaiting review

## 1. Intent

Convo's backend is now a memory-first client: recall, revision, and context assembly all run
in Rust, and the frontend composes nothing. The UI still looks like a documents tool with a
memory page buried under Tasks, and it never says whether semantic recall is working. This
redesign makes the shell, every page, and both palettes match what the application became,
and surfaces the memory system's state where a user will actually see it.

**Success criteria** — all verifiable:

1. Every route renders in the new visual vocabulary, in both modes, on all six built-in
   themes, with no hybrid appearance.
2. Zero literal hex values in the diff. Grep-enforceable.
3. The streaming message path gains no per-row paint cost: no `box-shadow`, `filter`, or
   `transition` inside the streaming subtree, and no new `MessageRow` prop that
   `messageRowAreEqual` does not account for.
4. The TypeScript test floor holds at **403** and rises. Rust holds at **275**.
5. A user with no embedding model, or a stale index, sees that state without navigating away
   from a conversation.

**Known limit, stated rather than papered over:** there is no visual-regression tooling, and
adding Playwright would be a new dependency, which is out of scope. Criterion 1 is verified by
reading the render against the reference image and by human review, not by an automated
screenshot diff. Criterion 3 is structural, not numeric — jsdom cannot measure frame rate.

## 2. Decisions taken

| # | Decision | Why | Cost if wrong |
|---|---|---|---|
| D1 | **Compose from the existing 26 theme keys using `color-mix()`; add no new keys.** | All six built-in themes and every user-authored theme define exactly the same 26 keys. A new structural key is undefined in all of them, so a user on Solar would get Solar's palette plus default-coloured new chrome. Deriving means every theme follows automatically. | Some visual treatments are composited rather than exact, so tuning one hue means re-tuning a mix. |
| D2 | **Keep the existing palette unchanged** (`#0f1014` bg, `#7c6df0` accent). | The reference's accent is already this violet. The reference's background is slightly warmer and darker; changing it churns a token six themes agree on for a cosmetic gain. | The result is a hair less "near-black" than the reference. |
| D3 | **Shell restyled faithfully; Memory, Documents and Tasks keep row density.** | Those three are where row count is the point. The same tokens, radii and borders, less breathing room. | Two spacing rhythms to maintain. |
| D4 | **Sidebar regions: nav → conversations → status card.** | Preserves the app's primary object and keeps the status card outside the scroll region. | The status card is below the fold on short windows. |
| D5 | **The `density` setting stays unused.** | `stores/settings.ts` has `density` and `theme.ts` has `setDensity`, with no consumer. D3 is expressed as tighter spacing on three pages, not as a half-wired global toggle. | Dead code remains dead. Recorded rather than half-fixed. |
| D6 | **Absorb Phase 8 Tasks 3–4; defer Task 5; retarget Task 6's a11y gate.** | The status banner becomes the status card and the recall panel becomes a Memory-tab component in the new vocabulary. Add-to-chat and `/remember` are feature work, not visual work. | Phase 8 does not close in this plan. |

## 3. The visual foundation

Every value composes from the existing 26 keys. No new tokens, no `themes.rs` edits, no
migration.

| Element | Composed from | Value |
|---|---|---|
| Sidebar surface | `bg` | unchanged; the reference's sidebar *is* the page background |
| Sidebar/content divider | `border` | 1px `--color-border` |
| Nav row height | — | 40px, 12px vertical rhythm |
| Nav row hover | `surface.2` | direct |
| Active nav row | `surface.2` + `accent` | `color-mix(in oklab, var(--color-accent) 14%, var(--color-surface-2))` |
| Active row icon | `accent` | direct |
| Active row glow | `accent` | `color-mix(in oklab, var(--color-accent) 45%, transparent)`, right-edge `box-shadow`, **never animated** |
| Group header | `text.subtle` | 11px, uppercase, `letter-spacing: 0.08em` |
| Page title | `text` | 28px / 700, tight tracking |
| Card | `surface.1` + `border` | `--radius-lg`, 1px border, no shadow |
| Search field | `surface.2` | `--radius-md`, hint from `comboDisplay` |
| Status card | `surface.1` + `border` | as card; `text.muted` for the label row |

Light mode needs no separate work: the same composition derives from the light theme's own
accent and surfaces, so `DEFAULT_LIGHT`, Solar, Forest, Mono, and High Contrast all follow
without a single new declaration.

## 4. Components

### 4.1 Shell and sidebar

Width is unchanged: `w-60` is already 240px, and the 64px collapsed rail already exists. Neither is touched. Regions top to bottom:

1. **Header** — "Convo" wordmark, collapse toggle.
2. **Search** — opens the existing `CommandPalette`. The hint is platform-derived via the
   existing `comboDisplay` helper; a literal `⌘K` is wrong on Linux and Windows.
3. **Nav** — six rows: Chat, Notes, Memory; hairline; `OTHER` header; Compare, Documents,
   Tasks. This is spec §9's demotion expressed as the reference's group structure, so the IA
   change and the visual change are one edit.
4. **Recent** — the existing session list, behaviour unchanged.
5. **Status card** — pinned below the scroll region.

### 4.2 Page chrome

Every route: a 28px/700 title and a right-aligned action cluster. The reference's
"View: Timeline" pill appears **only where a real view toggle exists** — Chat carries the
model selector, Memory the kind filter. Pages without one get no pill, because a decorative
dropdown that switches nothing is worse than none.

### 4.3 Status card

Shows the active model, `embeddedCount` against `memoryCount + noteCount`, and a state chip:
**live**, **degraded** (no embedding model), or **needs reindex** (model changed). When Rust
supplies `semanticNote`, render it **verbatim**. A second wording of the same warning in
TypeScript is how the two drift apart.

## 5. Data flow

- `api.knowledgeIndexStatus()` on mount, and again after any pin or toggle mutation.
- No new store. Component-local state, matching the Memory tab's existing provenance map.
- Theme application is untouched: `applyTheme` writes root properties, and components read
  vars, so `color-mix()` needs no JavaScript.
- A failed status fetch renders nothing. A status card must never be the reason a sidebar
  fails to render.

## 6. Degradation and accessibility

- Nav-row hover and active transitions respect `prefers-reduced-motion`. The glow never
  animates regardless.
- Every interactive element keeps a reachable accessible name and keyboard operability.
- Focus styles use a token, never a literal.
- Contrast: the palette is unchanged, so existing contrast ratios hold. The one new tinted
  surface (active nav row) is verified against `text` in both modes before it ships — a
  14% accent mix over `surface.2` is a new pairing that did not previously exist.

## 7. Testing

- Floor: **403 TypeScript** (from `npm run test:run`), **275 Rust**. Both may only rise.
- The four existing `toHaveClass` assertions (`Form.test.tsx`, `NotesRoute.test.tsx`) are
  re-targeted at behaviour, not deleted.
- **Streaming structural guard**, added to `streamPerformance.test.tsx` *before* the chat
  surface is restyled: no `box-shadow`, `filter`, or `transition` in the streaming message
  subtree; and if `MessageRow` gains a prop, `messageRowAreEqual` accounts for it —
  verified by mutating the comparator and confirming the test goes red.
- New tests: three status-card states, reduced-motion, sidebar region order, nav group
  structure, tinted-active-row contrast in both modes.

## 8. Sequencing

1. **Foundation** — verify the composition approach renders; add the streaming structural
   guard first, so the risk is measured before anything is restyled.
2. **Primitives** — `Button`, `Input`, `Select`, `Switch`, `Modal`, card, in the new
   vocabulary. Re-target the class assertions here.
3. **Shell** — sidebar regions, page chrome, status card.
4. **Memory page** — the densest and most feature-rich surface. If the foundation survives
   it, it survives everything; treat it as the pattern and review it as such.
5. **The rest** — Notes, Chat, Compare, Documents, Tasks, Settings.
6. **Absorbed Phase 8 work** — recall panel and supersede history land here, in the new
   vocabulary, not the old one.
7. **Close-out** — a11y pass, then tick only the Phase 8 boxes that are genuinely done.

## 9. Out of scope

- **Visual regression screenshots.** Needs Playwright; new dependency.
- **Phase 8 Task 5** — add-to-chat and `/remember`. Feature work; lands after the surface
  settles.
- **The `density` setting.** Left unused (D5).
- **The extraction-failure visibility gap.** `memory_extract_and_revise` returns `[]` both
  when extraction found nothing and when the model was unreachable, so a broken setup is a
  silent no-op. Needs a Rust change and a product decision about what a memory failure looks
  like to someone who does not know memory exists. Unrelated to this work, and still the
  highest-value open item in the project.
- **Any change to the 26 theme keys, `themes.rs`, or the six built-in themes.**
