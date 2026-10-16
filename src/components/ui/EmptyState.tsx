import { ReactNode } from "react";

/**
 * The block a route shows when there is nothing to list: an icon, a
 * title, an optional sentence and an optional action.
 *
 * `headingLevel` exists because the title is a heading, and a heading's
 * level is semantic rather than visual. Every route here draws its own
 * `h1` through `RouteShell`, so an `h3` underneath it is a *skipped*
 * level — and screen-reader users move between headings by level, not by
 * position, so the title is not reachable by a level-keyed jump. The
 * treatment is identical either way; only the tag changes, which is why
 * this is a prop on the primitive rather than four pages each drawing
 * their own heading over the top of it.
 *
 * Two levels and not six. The page owns `h1`, and nothing in the app
 * nests deep enough today to want `h4` or below, so widening this is a
 * deliberate act rather than an accident — which is also why
 * `primitiveApi.test.ts` pins the signature.
 *
 * The default is the level this always rendered, so every call site that
 * does not pass the prop behaves exactly as it did.
 *
 * ── The icon is 28px at every call site, and that is arithmetic ─────
 * The chip is `p-2.5` — 10px of padding a side — so the chip resolves to
 * 28 + 20 = **48px**, which is six of the app's 8px step. The call sites
 * were split 32/28, which made the chip 52px on Tasks, Documents and
 * Compare and 48px on Memory, Notes and Chat: one primitive, two sizes,
 * and 52 is not a number any other spacing step in the app uses. So 28
 * is the size, on the grounds that the *chip* lands on the rhythm
 * rather than the glyph.
 *
 * The primitive cannot enforce that — the icon is the caller's element
 * and this component does not add a prop to control it, which is the
 * right boundary: the icon is page vocabulary, not primitive
 * vocabulary. So `primitives.test.tsx` scans the call sites instead, and
 * says so here so the next person who likes 32 knows what they are
 * changing.
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  headingLevel = 3,
  className = "",
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
}) {
  // Annotated rather than cast: the union is `2 | 3`, so the conditional
  // is exhaustive and tsc checks it. No `as`, which would be a way for
  // the two to drift apart without a word.
  const Heading: "h2" | "h3" = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className={`flex flex-col items-center justify-center py-10 px-4 text-center ${className}`}>
      {icon && <div className="inline-flex items-center justify-center rounded-lg bg-surface-2 p-2.5 text-text-muted mb-3">{icon}</div>}
      <Heading className="text-sm font-medium text-text">{title}</Heading>
      {description && <p className="text-xs text-text-muted mt-1 max-w-xs">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
