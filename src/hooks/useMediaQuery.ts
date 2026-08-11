import { useEffect, useState } from "react";

/**
 * useMediaQuery — returns whether the given media query currently matches.
 * Uses matchMedia and listens for changes. SSR-safe (checks for window).
 *
 * @example const isNarrow = useMediaQuery('(max-width: 760px)');
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    setMatches(mql.matches);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}
