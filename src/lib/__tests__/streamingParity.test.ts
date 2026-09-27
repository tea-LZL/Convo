/**
 * Characterization tests for the CURRENT streaming renderer.
 *
 * These exist to be measured against. Every assertion here passes
 * against `streamingRenderer.ts` + `streamingSegmenter.ts` as they
 * stand on 2026-09-27, and the rewrite must not regress them. Where
 * the current renderer is known to be wrong, the test records that
 * instead of asserting the wrong thing as correct.
 *
 * This file is a TEMPORARY HARNESS. It imports the modules the
 * streaming rewrite deletes, so it is deleted with them. Its shape
 * corpus lives in `../fixtures/streamShapes.ts` (under
 * `src/components/chat/__tests__/fixtures/`) and outlives it, because
 * the block splitter, the streaming-tail parity tests, and the
 * performance tests all import that.
 */
import { describe, expect, it } from "vitest";
import { createStreamRenderer } from "../streamingRenderer";
import { splitFinalized } from "../streamingSegmenter";
import { renderMarkdown } from "../markdown";
import { STREAM_SHAPES, shapeNamed } from "../../components/chat/__tests__/fixtures/streamShapes";
import { canonicalElement, canonicalHtml } from "../../components/chat/__tests__/fixtures/domCompare";

function makeRenderer() {
  const el = document.createElement("div");
  const renderer = createStreamRenderer(el, { render: renderMarkdown });
  return { el, renderer };
}

/** Drive a renderer through a shape's cut points in ascending order. */
function replay(shape: { full: string; cutPoints: number[] }) {
  const { el, renderer } = makeRenderer();
  for (const n of shape.cutPoints) {
    renderer.update(shape.full.slice(0, n));
  }
  renderer.finalize();
  return el;
}

describe("segmenter cut safety (current behavior)", () => {
  // The contract the whole freezing design rests on:
  //
  //   render(before) + render(after) === render(before + after)
  //
  // If this ever fails, freezing has changed the output and the
  // "incremental rendering is transparent" claim is false.
  it.each(STREAM_SHAPES.flatMap((shape) =>
    shape.cutPoints.map((n) => [shape.name, n] as const),
  ))("splitFinalized is render-safe for %s at cut %i", (name, n) => {
    const shape = shapeNamed(name);
    const prefix = shape.full.slice(0, n);
    const cut = splitFinalized(prefix, renderMarkdown, 0);
    expect(cut).toBeGreaterThanOrEqual(0);
    expect(cut).toBeLessThanOrEqual(prefix.length);
    expect(renderMarkdown(prefix.slice(0, cut)) + renderMarkdown(prefix.slice(cut))).toBe(
      renderMarkdown(prefix),
    );
  });
});

describe("renderer replay parity (current behavior)", () => {
  // What the user actually ends up seeing: replaying a message one
  // prefix at a time must settle on the same DOM as rendering the whole
  // thing at once.
  //
  // Compared structurally, not as an innerHTML string. The renderer
  // builds some text via DOM text nodes, which serialize `'` where the
  // escaping renderer emits `&#39;` — identical to a user, different
  // as a string. See fixtures/domCompare.ts.
  it.each(STREAM_SHAPES.map((s) => [s.name] as const))(
    "replaying %s settles on the full render",
    (name) => {
      const shape = shapeNamed(name);
      const el = replay(shape);
      expect(canonicalElement(el)).toBe(canonicalHtml(renderMarkdown(shape.full)));
    },
  );
});

describe("append-only precondition (current behavior is WRONG)", () => {
  // streamingRenderer.ts:60-66 documents that callers MUST pass
  // append-only text, because frozen blocks are never revisited. A
  // provider that re-sends corrected earlier text therefore leaves the
  // user staring at stale content with no way to recover short of a
  // full re-render.
  //
  // This asserts the CURRENT (broken) behavior so the rewrite's
  // improvement is measurable. Task 6 replaces it with a test that
  // asserts the correction IS reflected.
  it("leaves stale frozen blocks when earlier text is corrected", () => {
    const { el, renderer } = makeRenderer();
    renderer.update("para one\n\npara two");
    expect(el.textContent).toContain("para one");

    renderer.update("para ONE\n\npara two");

    expect(el.textContent).toContain("para one");
    expect(el.textContent).not.toContain("para ONE");
  });
});
