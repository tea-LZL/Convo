/**
 * The row control, as one definition.
 *
 * Five pages put a small row control at the end of a line of content —
 * Memory, Notes, Compare and Tasks — and Documents puts one at the end
 * of each document tab. For most of this plan each of them spelled the
 * box out by hand. Three of the original four strings
 * came out byte-identical and Memory's did not: it left off `shrink-0`,
 * because its cluster wrapper is already `shrink-0` and supplies it. So
 * the five docblocks each claimed "one definition" while the
 * definitions were five, and a reviewer reading any one of them had no
 * way to know that.
 *
 * They are one definition now, and this is it. The differences were
 * never intentional — `shrink-0` on Memory's buttons is inert, because
 * the wrapper already refuses to shrink and nothing about the button
 * changes — so unifying on the longer string changes no layout and
 * removes the only place the four could drift.
 *
 * ── Why 24px, on every one of them ────────────────────────────────────
 * Not the ~19px a bare icon button with 4px of padding gives, and not the
 * 16px the Tasks page's complete toggle used to be. WCAG 2.2's target
 * size is a requirement rather than a preference, and the density split
 * this plan drew (decision D3) is about how much air sits *between*
 * rows, not about the one thing a user has to hit. The Memory page took
 * this ruling when it grew its four row controls from 20px and paid for
 * it with a fixed 102px control column; Tasks, Notes and Compare
 * followed on the same grounds.
 *
 * ── Why `focus-visible:` and not `focus:` ─────────────────────────────
 * A row control acts the moment it is clicked, so there is nothing left
 * to disambiguate and a `:focus` ring on a mouse click is noise. This is
 * the same reasoning as the restyled pages' `focus:` *fields*, which do
 * take `focus:` — a field should say where the caret is however it got
 * there. The two are not in tension: one is a command, the other is a
 * text entry.
 *
 * ── No transition, and that is the point ─────────────────────────────
 * Tasks and Memory are the two pages whose lists scale to hundreds of
 * rows, and an unconditional `transition-colors` on every row of a list
 * that scales is the thing those pages are deciding not to do. That is
 * also why this is a hand-written class list rather than `IconButton`,
 * which carries an unconditional transition.
 *
 * A guard, not a convention, keeps the five on it:
 * `rowAction.test.ts` asserts that all five pages import this module and
 * that none of them declares a `ROW_ACTION` of its own — a copy is the
 * failure mode, and a docblock is not what stops one.
 */

/** The resting and active colour for a row control, as one definition. */
export const ROW_ACTION_IDLE = "text-text-subtle hover:text-text";

/**
 * The box: 24px square, a theme radius, and a focus indicator scoped to
 * `focus-visible:` so it cannot paint a shadow at rest.
 */
export const ROW_ACTION =
  "h-6 w-6 shrink-0 inline-flex items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
