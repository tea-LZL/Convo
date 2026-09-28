# Visual Redesign — Design Spec

Date: 2026-09-27 · Branch: `realignment` · Status: implemented — criteria 2–5 met by test, criterion 1 human-verified and not ticked (see §1)

## 1. Intent

Convo's backend is now a memory-first client: recall, revision, and context assembly all run
in Rust, and the frontend composes nothing. The UI still looks like a documents tool with a
memory page buried under Tasks, and it never says whether semantic recall is working. This
redesign makes the shell, every page, and both palettes match what the application became,
and surfaces the memory system's state where a user will actually see it.

**Success criteria** — ticked at close-out, Task 7, commit recorded in the ledger. The
heading above them originally read "all verifiable". It was wrong about one of them, and the
tick below is the correction rather than a rubber stamp.

| # | Criterion | Status | Established by |
|---|---|---|---|
| 1 | Every route renders in the new visual vocabulary, in both modes, on all six built-in themes, with no hybrid appearance | **Human-verified, not tested** — see below | a person reading the render against the reference image. All ten restyled: the first pass covered seven, and About, Diagnostics and Hardware were finished in the final fix wave with a rhythm guard each |
| 2 | Zero literal hex values in the diff | **Met** | `grep -rnE "#[0-9a-fA-F]{3,8}\|rgb(\|hsl(" src/components src/routes --include=*.tsx \| grep -v test` → empty |
| 3 | The streaming message path gains no per-row paint cost | **Met** | `streamPerformance.test.tsx`, 12 tests, both guards demonstrated red on their own mutations |
| 4 | The TypeScript test floor holds at 403 and rises; Rust holds at 275 | **Met** | **781** TypeScript (54 files), **275** Rust, unchanged. 705 → 781 in the final fix wave |
| 5 | A user with no embedding model, or a stale index, sees that state without navigating away | **Met** | `StatusCard.test.tsx`, 33 tests: all four states, Rust's `semanticNote` verbatim, and the collapsed-rail dot |

Criterion 3 is structural rather than numeric: jsdom cannot measure a frame rate. What the
guard establishes is that no `box-shadow`, `filter` or `transition` is *declared* inside the
streaming subtree — classes, inline styles and `globals.css` — and that `MessageRow`'s prop
interface and `messageRowAreEqual` are byte-identical to the plan base, so no prop can have
gone unaccounted for.

### Criterion 1 is not a test, and is not ticked as one

There is no visual-regression tooling in this repository, and adding Playwright would be a new
dependency, which §9 puts out of scope. Nothing in the suite renders a theme and compares a
pixel, so **no test in this repository establishes criterion 1**, and this spec does not claim
that one does. It is verified by a person reading the render.

What that person still has to look at, so the list is a checklist and not a gesture:

- **Ten routes**, each on **six themes**: `Default (Dark)`, `Default (Light)`, `Solar`,
  `Forest`, `Mono`, `High Contrast`. That is sixty renders. The ten are counted from
  `src/routes/*Route.tsx` by `AboutRoute.test.tsx` rather than written down here, because
  this checklist asserted "ten" for six tasks while seven routes were actually restyled: a
  number in a document is a promise, and a number derived from the filesystem is a fact.
  Every route now also has a guard file beside it, and that test names the one exception
  (Chat, whose guard lives with the chat surface) and asserts the exception's file still
  exists — so the next route to ship without one is a red test rather than a sixth
  discrepancy.
- **Chat separately**, because D7 records that it is not a `RouteShell` page and does not take
  the page chrome. It is the deviation most likely to read as an oversight, so it is the one
  most worth a second look.
- **The empty states**, on Memory, Notes, Documents and Tasks — `EmptyState` is where a
  heading level and a chip surface can disagree with the page around it.
- **Every state the components have rather than only their resting state**: the `Modal` and the
  `Dropdown` (the two overlays that keep a shadow), the `Switch` in both positions, the
  `Select`'s disabled state, the status card in all four states, and the collapsed 64px rail,
  whose every label is replaced by an icon.
- **Any surface that reads as two vocabularies meeting.** That is the specific failure the
  criterion names, and the three Task 1 aliases are where it would appear first: an active nav
  row whose `nav-active` mix looks like a hardcoded tint, a group header that does not match its
  neighbours' `text-subtle`, or a `nav-glow` that reads as a shadow rather than a bloom.

**Known limit, unchanged:** criterion 3 is structural, not numeric, for the reason above.

## 2. Decisions taken

| # | Decision | Why | Cost if wrong |
|---|---|---|---|
| D1 | **Compose from the existing 26 theme keys using `color-mix()`; add no new keys.** | All six built-in themes and every user-authored theme define exactly the same 26 keys. A new structural key is undefined in all of them, so a user on Solar would get Solar's palette plus default-coloured new chrome. Deriving means every theme follows automatically. | Some visual treatments are composited rather than exact, so tuning one hue means re-tuning a mix. |
| D2 | **Keep the existing palette unchanged** (`#0f1014` bg, `#7c6df0` accent). | The reference's accent is already this violet. The reference's background is slightly warmer and darker; changing it churns a token six themes agree on for a cosmetic gain. | The result is a hair less "near-black" than the reference. |
| D3 | **Shell restyled faithfully; Memory, Documents and Tasks keep row density.** | Those three are where row count is the point. The same tokens, radii and borders, less breathing room. | Two spacing rhythms to maintain. |
| D4 | **Sidebar regions: nav → conversations → status card.** | Preserves the app's primary object and keeps the status card outside the scroll region. | The status card is below the fold on short windows. |
| D5 | **The `density` setting stays unused.** | `stores/settings.ts` has `density` and `theme.ts` has `setDensity`, with no consumer. D3 is expressed as tighter spacing on three pages, not as a half-wired global toggle. | Dead code remains dead. Recorded rather than half-fixed. |
| D6 | **Absorb Phase 8 Tasks 3–4; defer Task 5; retarget Task 6's a11y gate.** | The status banner becomes the status card and the recall panel becomes a Memory-tab component in the new vocabulary. Add-to-chat and `/remember` are feature work, not visual work. | Phase 8 does not close in this plan. |
| D7 | **Chat does not take the page chrome.** | Chat is not a `RouteShell` page, and the conversation *is* the screen. A 28px "Chat" heading above a transcript is worse than none, and the reference's page title is not a thing a transcript has. Recorded as an explicit deviation from §4.2 rather than left to read as an oversight — this is the single most likely thing a reviewer reads as a bug. | The app's most-used screen is the one route that does not match the page-chrome pattern, so a reviewer has to know it is deliberate. |
| D8 | **The focus indicator is two tokens, not one: a `text` ring with a `bg` offset.** The treatment this plan inherited (`ring-accent/40`) was carried as a tracked deferral on the grounds that it was *accent on accent* on the two filled variants. Measured, it was worse and wider than that: 1.68:1 against the page on the default dark theme, 1.86 light, 2.14 Solar, 2.16 Forest, 2.92 Mono — clearing 3:1 only on High Contrast, the one theme built so everything does. The deferral's own note said a ring that reads on both a filled accent background and the four surfaces does not exist in the 26 keys. That is true of any *single* token, and the construction above needs no new one: it is `text` and `bg`, both already seeded in all six themes, and the offset is what gives the ring something to read against. Two of its three legs are page-independent, so it does not have to guess which surface a primitive is on — which is the objection that killed `ring-offset-<surface>` twice. | Three extra classes per focus style, and a 2px outset ring can clip against a viewport edge or a 32px icon button, which the old 0-offset ring could not. The alternative was leaving a 1.68:1 indicator in place because the fix looked like it needed a new token. |

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
| Active row icon | *inherits the row* | `text`, **not** `accent` — see below |
| Active row glow | `accent` | `color-mix(in oklab, var(--color-accent) 45%, transparent)`, right-edge `box-shadow`, **never animated** |
| Group header | `text.subtle` | 10px, uppercase, `tracking-wider` (`letter-spacing: 0.05em`), `font-semibold` |
| Page title | `text` | 28px / 700, tight tracking |
| Card | `surface.1` + `border` | `--radius-lg`, 1px border, no shadow |
| Search field | `surface.2` | `--radius-md`, hint from `comboDisplay` |
| Status card | `surface.1` + `border` | as card; `text.muted` for the label row |

Light mode needs no separate work: the same composition derives from the light theme's own
accent and surfaces, so `DEFAULT_LIGHT`, Solar, Forest, Mono, and High Contrast all follow
without a single new declaration.

### 3.1 Two rows this table got wrong, and why the code is the better call

Both of these were written before the rows were built and are corrected here to match what
ships. The code is the better answer on both, which is the reason the spec moved rather than
the code moving back.

**The active row's icon inherits body text rather than taking the accent.** `navRowClass`
gives the whole row `text-text` when it is active, icon included, so a 15px glyph is read at
`--color-text` rather than at `--color-accent`. Two reasons, and the second is the one that
decided it:

- Contrast. The accent is a brand hue tuned for a filled button and for large type; a 15px
  glyph on `nav-active` is a different job, and §10.1 records that the four non-default themes
  have never been measured for anything. Spending the highest-contrast token in the palette on
  the smallest object on the page is the wrong end of the budget.
- Consistency. The row is one object. When the label is `text` and the icon is `accent`, the
  active row reads as *two* selections — a highlighted glyph and a highlighted word — where
  there is one. The accent is already doing that job through `nav-active` and `nav-glow`; a
  third use of it on the same row is the least load-bearing of the three.

`nav-active` is the accent's channel on this row. Spending it once, as a surface, is what
makes the row legible as selected; spending it again on the glyph is decoration.

**The group header is 10px at `0.05em`, not 11px at `0.08em`.** `tracking-wider` on the
default Tailwind scale is `0.05em`; the spec's `0.08em` was a value nobody had measured
against a rendered string, and `0.05em` is the step the sidebar, the settings nav, the
Notes editor and Compare's two inline labels all use. Nine sites, one spelling, and the
sweep in `SettingsRoute.test.tsx` is what keeps it that way.

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

Every `RouteShell` route: a 28px/700 title and a right-aligned action cluster. **Chat is the
exception** — it is not a `RouteShell` page and does not take the page chrome (decision D7). The reference's
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
  Verified as a **rendered sweep**, not as four lookups, on the two surfaces where controls
  carry no text of their own: the sidebar and the Memory page. A `title` is not accepted on
  its own for a control with no text — it is last in the accessible-name computation and is
  not a name on a touch device.
- **A control whose accessible name changes with its state must say what the state is.** This
  is a separate requirement from having a name, and it is the one that was missing. Every aria
  assertion in Tasks 1–6 checked a *value*; none checked an **agreement** between a name and a
  state, and that is how Compare's blind toggle survived sixteen commits announcing "Blind, not
  pressed" while blind mode was on. A control that offers "Disable" because it is enabled has
  promised to say that it is enabled. `stateAgreement.test.tsx` states the rule — same
  expression, and a state channel at all — and applies it to every toggle in the app. It found
  five controls that had made the promise and not kept it; all five were pre-existing.
- Focus styles use a token, never a literal. The indicator is **two** tokens: a `text` ring
  with a `bg` offset, which is what makes it read on a filled accent button as well as on the
  four surfaces the controls sit on. `focusRing.test.ts` measures all three legs of that against
  all six built-in themes on every run, because a class-name pin is satisfied by a value at
  1.68:1 — which is exactly what the treatment it replaced was.
- Contrast: the palette is unchanged, so existing contrast ratios hold. The one new tinted
  surface (active nav row) is verified against `text` in both modes before it ships — a
  14% accent mix over `surface.2` is a new pairing that did not previously exist. **Scope:
  the two default themes only** — see §10.1.

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
- **Added at close-out (Task 7), 677 → 705, and 705 → 781 in the final fix wave:**
  - `stateAgreement.test.tsx` — the name/state agreement rule, over every toggle in the app,
    with one negative control per rule and both rules demonstrated red on the real files.
  - `focusRing.test.ts` — the three legs of the focus indicator, measured against all six
    built-in themes read out of `themes.rs`, plus the record of what the old declaration
    measured.
  - Rendered accessible-name sweeps on the sidebar (expanded and collapsed) and the Memory
    page.
  - A four-channel rendered agreement for the Memory page's enable control: name,
    `aria-pressed`, the `title`, and the row's own dimming.
- **Added in the final fix wave, 705 → 781, 52 → 54 files:**
  - Rhythm guards for the three routes the restyle never reached. Each resolves its spacing
    out of a real Tailwind compile rather than reading a class name, so a page that merely
    *says* `p-3` is not a page that has it. `HardwareRoute`'s walks both of its card
    components, because the page's real defect was two components drawing one object two ways.
  - A directory sweep asserting every `*Route.tsx` has a guard beside it, with Chat's named
    as the one exception. This is the guard that would have caught the omission at Task 5.
  - The floating-radius guard: all three overlays agree, and what they agree on is a
    `var(--radius-*)` rather than a hardcoded 1rem.
  - A group-header sweep over all nine sites, checking the alias against
    `tailwind.config.ts` rather than trusting that two names resolve alike.
  - The rail's active row compared against the expanded nav's, and `aria-current` asserted
    on both widths.
  - A guard that a page does not re-spell `ROW_ACTION` — the failure mode there is a copy,
    and four docblocks claiming "one definition" is what made the copies look safe.

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

## 10. Follow-ups

Written at close-out rather than discovered later. The first is the one with a number attached.

### 10.1 Contrast on Solar, Forest, Mono and High Contrast is still unmeasured

**Every contrast figure in this plan came from Default Dark and Default Light**, because those
are the two palettes that can be reasoned about without a render. Four of the six built-in
themes have never been checked. This is a real gap and it is structural rather than an
oversight: contrast is a property of a **pairing**, not of a token, so `--color-text` on
`--color-surface-3` can clear 3:1 on the two defaults and fail on Solar, and no assertion over
class names would notice. High Contrast is the likeliest to diverge, since maximum separation
is its entire purpose.

What is already known, and what is not:

| Pairing | Default Dark | Default Light | Solar / Forest / Mono / High Contrast |
|---|---|---|---|
| Switch thumb, checked track | 3.96 | 7.1 | **unmeasured** |
| Switch thumb, unchecked track | 12.3 | 14.4 | **unmeasured** |
| `EmptyState` icon on its `surface-2` chip | 5.49 | 5.57 | **unmeasured** |
| `IconButton` active tint, three backdrops | clears 3:1 | clears 3:1 | **unmeasured** |
| Every pairing introduced in Tasks 3–6 | — | — | **unmeasured** |
| **Focus ring, all three legs** | **12.37 / 4.80 / 15.52** | **14.30 / 5.96 / 16.47** | **12.72 / 7.48 / 16.02, 13.33 / 7.49 / 16.33, 14.40 / 13.36 / 16.91, 17.40 / 19.56 / 21.00** |

The focus ring is the one row that is not blank, and it is there for a specific reason rather
than as a favour: Task 7 *changed* that indicator, so shipping a new one onto four unmeasured
palettes would have been gambling rather than diligence.
`src/components/ui/__tests__/focusRing.test.ts` measures all three legs against all six themes
on every run, so that one cannot rot. Auditing the rest is the follow-up.

`text-text-subtle` on a raised surface is the pattern to start from, because it is known to be
common (`MemoryRoute`, `SessionSearch`, the input placeholders) and was corrected in exactly one
place by ruling, on the grounds that a rule the codebase does not follow is a guard that cries
wolf. The prevalence was checked; the ratios were not.

### 10.2 The sidebar's session context menu cannot be reached by keyboard

**The highest-value accessibility item left, and it is a design gap rather than a bug.** The
menu opens on `onContextMenu` and on nothing else, so a keyboard user cannot open it at all;
there is no trigger, no keyboard shortcut, and no arrow-key navigation within it. The five
items are all `role="menuitem"`, two of which flip their label with state ("Pin"/"Unpin",
"Archive"/"Unarchive") and — correctly — cannot carry `aria-checked`, because a `menuitem` is a
command and only a `menuitemcheckbox` may report state.

`stateAgreement.test.tsx` exempts that case **in the rule**, with the reason written next to the
exemption, rather than special-casing two line numbers where a later edit would silently
un-exempt them. Closing the gap properly means designing a keyboard-reachable trigger and
deciding whether those two items are checkable menu items, which is a decision about the widget
rather than about an attribute. Out of scope for a close-out pass, and recorded here so it is
not lost.

### 10.3 The status card still cannot say what fraction is covered

Carried from Task 3. The card reports `N embedded · M awaiting` because a coverage ratio needs
a denominator Rust does not compute, and `rows_needing_embedding` and `embedded_count` overlap
rather than partition. A denominator field on `KnowledgeIndexStatus` would fix it; that is a
Rust change, and this plan touches no Rust.

### 10.4 The chat page has no `h1`, and nothing has claimed it since

**Recorded because it was nearly lost, not because it is new.** `ChatViewNew.tsx` carried a
comment saying the page's missing `h1` was "pre-existing and is Task 7's to settle". Task 7
did not settle it, and it was not in these follow-ups, so the decision had been deferred to a
task that had already shipped. That is the failure mode this whole section exists to prevent:
a comment that hands a decision to a numbered task reads as a promise, and nobody audits the
promises.

**What the gap is.** Every other route draws its `h1` through `RouteShell`. Chat does not
(D7), so a screen-reader user arriving on the app's most-used screen finds an outline that
starts at whatever heading the transcript happens to contain — usually `h2`, from an
`EmptyState`, and nothing at all once there are messages. The fix is a visually-hidden `h1`
naming the conversation, which costs no layout and does not reopen D7: a transcript does not
want a 28px visible title, and it does want to be named.

**Why it is not done here.** It is a heading-level change to a page whose heading structure
this plan deliberately left alone, and the brief for this wave rules that a comment deferring
it to a task is the problem rather than the solution. The honest move was to make the comment
stop promising and put the gap where gaps are collected. `ChatViewNew` now says where it went.

**What would settle it.** One `<h1 className="sr-only">` in the chat view, naming the
conversation, plus a heading-outline guard over the chat surface in the shape the six
`RouteShell` routes already have. Small, and the reason it is not simply done here is that it
belongs with whatever D7 is next revisited, not with a visual pass.
