import { Fragment } from "react";

interface HighlightedSnippetProps {
  snippet: string;
}

function findMatchedMarkerIndexes(parts: string[]) {
  const openingIndexes: number[] = [];
  const matchedIndexes = new Set<number>();

  parts.forEach((part, index) => {
    if (part === "<mark>") {
      openingIndexes.push(index);
      return;
    }

    if (part === "</mark>") {
      const openingIndex = openingIndexes.pop();
      if (openingIndex !== undefined) {
        matchedIndexes.add(openingIndex);
        matchedIndexes.add(index);
      }
    }
  });

  return matchedIndexes;
}

export function HighlightedSnippet({ snippet }: HighlightedSnippetProps) {
  const parts = snippet.split(/(<\/?mark>)/g);
  const matchedMarkerIndexes = findMatchedMarkerIndexes(parts);
  let markDepth = 0;

  return (
    <>
      {parts.map((part, index) => {
        if (part === "<mark>") {
          if (!matchedMarkerIndexes.has(index)) {
            return <Fragment key={index}>{part}</Fragment>;
          }

          markDepth += 1;
          return null;
        }
        if (part === "</mark>") {
          if (!matchedMarkerIndexes.has(index)) {
            return <Fragment key={index}>{part}</Fragment>;
          }

          markDepth -= 1;
          return null;
        }

        return markDepth > 0 ? (
          <mark key={index} className="bg-warn/30 text-text rounded px-0.5">
            {part}
          </mark>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        );
      })}
    </>
  );
}
