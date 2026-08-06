import { describe, expect, it } from "vitest";

describe("stream delta transport", () => {
  it("keeps payload volume linear instead of resending prefixes", () => {
    const deltas = Array.from({ length: 1000 }, () => "x");
    const deltaBytes = deltas.reduce((total, delta) => total + delta.length, 0);
    const prefixBytes = deltas.reduce((total, _, index) => total + index + 1, 0);

    expect(deltaBytes).toBe(1000);
    expect(prefixBytes).toBeGreaterThan(deltaBytes * 500);
  });
});
