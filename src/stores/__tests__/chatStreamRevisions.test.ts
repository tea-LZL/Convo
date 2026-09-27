import { beforeEach, describe, expect, it } from "vitest";
import { reportRevisions } from "../chatStream";
import { useToastStore } from "../toasts";
import type { AppliedRevision } from "../../lib/api";

/**
 * The revision table writes memory without a human in the loop, so the only
 * thing standing between a correct write and a silent one is this line. The
 * silence rule matters as much as the wording: extraction runs after a turn
 * and usually finds nothing, and a toast on every quiet round is how a
 * useful signal gets muted.
 */
describe("reportRevisions", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  const messages = () => useToastStore.getState().toasts.map((t) => t.message);

  it("says nothing when the round found nothing", () => {
    reportRevisions([]);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("reports new rows and inbox rows in one line", () => {
    const applied: AppliedRevision[] = [
      { effect: "added", id: "mem-1" },
      { effect: "added", id: "mem-2" },
      { effect: "superseded", newId: "mem-3", oldId: "mem-1" },
      { effect: "sentToReview", reviewId: "review-1" },
    ];

    reportRevisions(applied);

    // A supersede replaces a row, so it reads as a remembered item even
    // though the count of new ids is one lower.
    expect(messages()).toEqual(["3 remembered, 1 needs review"]);
  });

  it("keeps an update out of the remembered count", () => {
    const applied: AppliedRevision[] = [
      { effect: "reinforced", id: "mem-1", confidence: 0.8 },
      { effect: "merged", id: "mem-2" },
    ];

    reportRevisions(applied);

    // Neither adds a row the user will see appear, so calling them
    // "remembered" would overstate what changed.
    expect(messages()).toEqual(["2 updated"]);
  });

  it("agrees with itself about one", () => {
    reportRevisions([{ effect: "sentToReview", reviewId: "review-1" }]);
    expect(messages()).toEqual(["1 needs review"]);

    useToastStore.setState({ toasts: [] });
    reportRevisions([
      { effect: "sentToReview", reviewId: "review-1" },
      { effect: "sentToReview", reviewId: "review-2" },
    ]);
    expect(messages()).toEqual(["2 need review"]);
  });

  it("leaves only one toast no matter how much the round did", () => {
    reportRevisions([
      { effect: "added", id: "mem-1" },
      { effect: "reinforced", id: "mem-1", confidence: 0.8 },
      { effect: "merged", id: "mem-1" },
      { effect: "superseded", newId: "mem-2", oldId: "mem-1" },
      { effect: "sentToReview", reviewId: "review-1" },
      { effect: "sentToReview", reviewId: "review-2" },
    ]);

    expect(messages()).toEqual(["2 remembered, 2 updated, 2 need review"]);
  });
});
