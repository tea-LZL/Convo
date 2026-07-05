import { describe, expect, it } from "vitest";
import { diffLines, diffStats } from "../diff";

describe("diffLines", () => {
  it("returns an all-equal array for identical inputs", () => {
    expect(diffLines("a\nb", "a\nb")).toEqual([{ kind: "equal", value: "a\nb" }]);
  });

  it("treats a single-line change as an add with the shared equal line", () => {
    expect(diffLines("a", "a\nb")).toEqual([
      { kind: "equal", value: "a" },
      { kind: "add", value: "b" },
    ]);
  });

  it("treats a single-line change as a remove with the shared equal line", () => {
    expect(diffLines("a\nb", "a")).toEqual([
      { kind: "equal", value: "a" },
      { kind: "remove", value: "b" },
    ]);
  });

  it("detects a replaced line", () => {
    const ops = diffLines("a\nb", "a\nc");
    expect(ops).toEqual([
      { kind: "equal", value: "a" },
      { kind: "remove", value: "b" },
      { kind: "add", value: "c" },
    ]);
  });

  it("handles leading and trailing additions", () => {
    expect(diffLines("b", "a\nb\nc")).toEqual([
      { kind: "add", value: "a" },
      { kind: "equal", value: "b" },
      { kind: "add", value: "c" },
    ]);
  });

  it("handles empty old text", () => {
    expect(diffLines("", "x\ny")).toEqual([{ kind: "add", value: "x\ny" }]);
  });

  it("handles empty new text", () => {
    expect(diffLines("x\ny", "")).toEqual([{ kind: "remove", value: "x\ny" }]);
  });

  it("handles repeated equal runs by merging consecutive same-kind blocks", () => {
    const ops = diffLines("a\nb\nc", "a\nb\nc");
    expect(ops).toEqual([{ kind: "equal", value: "a\nb\nc" }]);
  });
});

describe("diffStats", () => {
  it.each([
    { ops: [{ kind: "add", value: "one\ntwo" }], added: 2, removed: 0 },
    { ops: [{ kind: "remove", value: "x\ny\nz" }], added: 0, removed: 3 },
    {
      ops: [
        { kind: "equal", value: "same" },
        { kind: "add", value: "new" },
        { kind: "remove", value: "old\nolder" },
      ],
      added: 1,
      removed: 2,
    },
  ])("counts added/removed lines (%#)", ({ ops, added, removed }) => {
    expect(diffStats(ops as Parameters<typeof diffStats>[0])).toEqual({ added, removed });
  });

  it("returns zeros for an empty diff", () => {
    expect(diffStats([])).toEqual({ added: 0, removed: 0 });
  });
});
